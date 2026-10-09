// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

import { NextApiHandler } from 'next';
import { context, Exception, Span, SpanStatusCode, trace } from '@opentelemetry/api';
import { SemanticAttributes } from '@opentelemetry/semantic-conventions';

import logger from './logger';
import { httpStatusFromError } from './grpcHttpStatus';

const InstrumentationMiddleware = (handler: NextApiHandler): NextApiHandler => {
  return async (request, response) => {
    const span = trace.getSpan(context.active()) as Span;

    let httpStatus = 200;
    try {
      await runWithSpan(span, async () => handler(request, response));
      httpStatus = response.statusCode;
    } catch (error) {
      // Derive the HTTP status from the upstream gRPC status code. An upstream
      // client error (e.g. NOT_FOUND for a product that does not exist) must
      // not be reported as a 500, which would make it indistinguishable from a
      // genuine server fault in error rates and alerting.
      httpStatus = httpStatusFromError(error);

      // Always record the exception, so a 4xx is still fully diagnosable on the
      // span even though it does not set an ERROR status.
      span.recordException(error as Exception);

      // Per the OpenTelemetry HTTP semantic conventions, a SERVER span is only
      // an ERROR for a 5xx; a 4xx is the caller's fault and stays UNSET.
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
      // "    at ..." frame as its own severity-less record. Sending the
      // response ourselves keeps the stderr stream clean.
      const spanCtx = span.spanContext();
      const logPayload = {
        err: error,
        http_status: httpStatus,
        trace_id: spanCtx.traceId,
        span_id: spanCtx.spanId,
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
