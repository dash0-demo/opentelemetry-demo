// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

import { NextApiHandler } from 'next';
import { context, Exception, Span, SpanStatusCode, trace } from '@opentelemetry/api';
import { SemanticAttributes } from '@opentelemetry/semantic-conventions';
import { status as GrpcStatus } from '@grpc/grpc-js';

import logger from './logger';

// Every API route talks to a backend over gRPC, so a rejected call arrives here
// as a grpc-js ServiceError carrying a numeric `code`. Translating that code to
// the equivalent HTTP status keeps a caller error (e.g. asking for a product ID
// that does not exist) out of the frontend's 5xx rate, where it is
// indistinguishable from a real server fault. Mapping follows the gRPC-to-HTTP
// table used by grpc-gateway and the Google API design guide.
const GRPC_TO_HTTP_STATUS: Readonly<Record<number, number>> = {
  [GrpcStatus.OK]: 200,
  [GrpcStatus.CANCELLED]: 499,
  [GrpcStatus.UNKNOWN]: 500,
  [GrpcStatus.INVALID_ARGUMENT]: 400,
  [GrpcStatus.DEADLINE_EXCEEDED]: 504,
  [GrpcStatus.NOT_FOUND]: 404,
  [GrpcStatus.ALREADY_EXISTS]: 409,
  [GrpcStatus.PERMISSION_DENIED]: 403,
  [GrpcStatus.RESOURCE_EXHAUSTED]: 429,
  [GrpcStatus.FAILED_PRECONDITION]: 400,
  [GrpcStatus.ABORTED]: 409,
  [GrpcStatus.OUT_OF_RANGE]: 400,
  [GrpcStatus.UNIMPLEMENTED]: 501,
  [GrpcStatus.INTERNAL]: 500,
  [GrpcStatus.UNAVAILABLE]: 503,
  [GrpcStatus.DATA_LOSS]: 500,
  [GrpcStatus.UNAUTHENTICATED]: 401,
};

function httpStatusForError(error: unknown): number {
  const code = (error as { code?: unknown })?.code;
  return typeof code === 'number' ? (GRPC_TO_HTTP_STATUS[code] ?? 500) : 500;
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

      // Only a server-side failure marks the span as an error. A 4xx is the
      // caller's fault and must not count towards the service's error rate,
      // otherwise SLOs and error-rate checks fire on invalid input.
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
      const logAtLevel = httpStatus >= 500 ? logger.error.bind(logger) : logger.warn.bind(logger);
      logAtLevel(
        {
          err: error,
          http_status_code: httpStatus,
          trace_id: spanCtx.traceId,
          span_id: spanCtx.spanId,
        },
        'api.error'
      );

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
