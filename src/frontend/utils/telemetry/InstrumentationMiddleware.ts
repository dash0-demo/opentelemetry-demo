// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

import { NextApiHandler } from 'next';
import { context, Span, SpanStatusCode, trace } from '@opentelemetry/api';
import { SemanticAttributes } from '@opentelemetry/semantic-conventions';
import { status as GrpcStatus } from '@grpc/grpc-js';

import logger from './logger';

// gRPC codes that describe a bad request rather than a server fault. Anything
// not listed here stays a 500: in particular the demo's injected failures
// (INTERNAL from productCatalogFailure, RESOURCE_EXHAUSTED from
// adServiceFailure, FAILED_PRECONDITION from cartServiceFailure) must keep
// surfacing as server errors, because showing them is the point of the demo.
const CLIENT_ERROR_STATUS_BY_GRPC_CODE: Record<number, number> = {
  [GrpcStatus.INVALID_ARGUMENT]: 400,
  [GrpcStatus.NOT_FOUND]: 404,
};

// A grpc-js ServiceError carries a numeric `code`. Read it defensively: the
// handler can also throw a plain Error, which must keep returning a 500.
function httpStatusForError(error: unknown): number {
  const code = (error as { code?: unknown } | null)?.code;

  if (typeof code !== 'number') {
    return 500;
  }

  return CLIENT_ERROR_STATUS_BY_GRPC_CODE[code] ?? 500;
}

const InstrumentationMiddleware = (handler: NextApiHandler): NextApiHandler => {
  return async (request, response) => {
    const span = trace.getSpan(context.active()) as Span;

    let httpStatus = 200;
    try {
      await runWithSpan(span, async () => handler(request, response));
      httpStatus = response.statusCode;
    } catch (error) {
      httpStatus = httpStatusForError(error);
      const message = (error as Error).message;

      // Only a server fault marks the span as failed. A 4xx is the caller
      // asking for something that does not exist or is malformed, so it is
      // recorded as an exception for debugging but left out of the service's
      // error rate.
      span.recordException(error as Error);
      if (httpStatus >= 500) {
        span.setStatus({ code: SpanStatusCode.ERROR, message });
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
        'http.response.status_code': httpStatus,
      };
      if (httpStatus >= 500) {
        logger.error(logPayload, 'api.error');
      } else {
        logger.warn(logPayload, 'api.client_error');
      }

      if (!response.headersSent) {
        response.status(httpStatus).json({ error: message });
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
