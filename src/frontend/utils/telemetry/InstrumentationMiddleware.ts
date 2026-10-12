// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

import { NextApiHandler } from 'next';
import { context, Exception, Span, SpanStatusCode, trace } from '@opentelemetry/api';
import { SemanticAttributes } from '@opentelemetry/semantic-conventions';

import logger from './logger';
import { httpStatusFromError } from './GrpcHttpStatus';

const InstrumentationMiddleware = (handler: NextApiHandler): NextApiHandler => {
  return async (request, response) => {
    const span = trace.getSpan(context.active()) as Span;

    let httpStatus = 200;
    try {
      await runWithSpan(span, async () => handler(request, response));
      httpStatus = response.statusCode;
    } catch (error) {
      // Derive the HTTP status from the gRPC status of the failed backend call,
      // so that a client error (e.g. an unknown product id) is not reported as
      // a server fault.
      httpStatus = httpStatusFromError(error);

      // Per the OpenTelemetry HTTP semantic conventions, a SERVER span is only
      // marked Error for a server-side failure; a 4xx describes a bad request
      // and leaves the span status unset.
      if (httpStatus >= 500) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: (error as Error).message,
        });
      }

      // Emit one structured log record with the stack serialized into a single
      // JSON string (pino's `err` serializer). Deliberately do NOT re-throw:
      // re-throwing lets Next.js's default handler print `error.stack` to
      // stderr as multi-line text, and the filelog receiver ingests each
      // "    at ..." frame as its own severity-less record. Sending the status
      // ourselves keeps the stderr stream clean.
      const spanCtx = span.spanContext();
      const logPayload = {
        err: error,
        trace_id: spanCtx.traceId,
        span_id: spanCtx.spanId,
        http_status_code: httpStatus,
      };

      if (httpStatus >= 500) {
        logger.error(logPayload, 'api.error');
      } else {
        logger.warn(logPayload, 'api.client_error');
      }

      if (!response.headersSent) {
        response.status(httpStatus).json({ error: (error as Error).message });
      }
    } finally {
      span.setAttribute(SemanticAttributes.HTTP_STATUS_CODE, httpStatus);
    }
  };
};

async function runWithSpan(parentSpan: Span, fn: () => Promise<unknown>) {
  const ctx = trace.setSpan(context.active(), parentSpan);
  return await context.with(ctx, fn);
}

export default InstrumentationMiddleware;
