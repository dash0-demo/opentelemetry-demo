// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

import { NextApiHandler } from 'next';
import { context, Exception, Span, SpanStatusCode, trace } from '@opentelemetry/api';
import { SemanticAttributes } from '@opentelemetry/semantic-conventions';
import { status as GrpcStatus } from '@grpc/grpc-js';

import logger from './logger';

// A rejected backend call is not automatically a server fault. gRPC statuses
// that describe a bad request (an unknown product ID, a malformed argument)
// belong in the 4xx range: returning 500 for them reports a client mistake as
// an outage, which inflates the frontend error rate and hides real ones.
// Everything not listed here keeps the previous behaviour and maps to 500.
const GRPC_TO_HTTP_STATUS: Partial<Record<number, number>> = {
  [GrpcStatus.INVALID_ARGUMENT]: 400,
  [GrpcStatus.UNAUTHENTICATED]: 401,
  [GrpcStatus.PERMISSION_DENIED]: 403,
  [GrpcStatus.NOT_FOUND]: 404,
  [GrpcStatus.ALREADY_EXISTS]: 409,
  [GrpcStatus.FAILED_PRECONDITION]: 412,
};

function httpStatusForError(error: unknown): number {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'number') {
    return GRPC_TO_HTTP_STATUS[code] ?? 500;
  }
  return 500;
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

      // Only 5xx marks the server span as failed, per the OTel HTTP semantic
      // conventions: a 4xx is the caller's problem, not this service's.
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
