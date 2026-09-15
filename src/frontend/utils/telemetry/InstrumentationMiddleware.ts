// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

import { NextApiHandler } from 'next';
import { context, Exception, Span, SpanStatusCode, trace } from '@opentelemetry/api';
import { SemanticAttributes } from '@opentelemetry/semantic-conventions';
import { status as GrpcStatus } from '@grpc/grpc-js';

import logger from './logger';

// A gRPC error from a downstream service is not automatically a server fault.
// Map the gRPC status onto the closest HTTP status so that caller mistakes
// (an unknown product id, a bad argument) surface as 4xx instead of 500.
// Anything not listed here — including UNKNOWN, INTERNAL and DATA_LOSS — stays
// a 500, so genuine downstream faults are still reported as server errors.
const GRPC_TO_HTTP_STATUS: Partial<Record<GrpcStatus, number>> = {
  [GrpcStatus.OK]: 200,
  [GrpcStatus.INVALID_ARGUMENT]: 400,
  [GrpcStatus.FAILED_PRECONDITION]: 400,
  [GrpcStatus.OUT_OF_RANGE]: 400,
  [GrpcStatus.UNAUTHENTICATED]: 401,
  [GrpcStatus.PERMISSION_DENIED]: 403,
  [GrpcStatus.NOT_FOUND]: 404,
  [GrpcStatus.ALREADY_EXISTS]: 409,
  [GrpcStatus.ABORTED]: 409,
  [GrpcStatus.RESOURCE_EXHAUSTED]: 429,
  [GrpcStatus.CANCELLED]: 499,
  [GrpcStatus.UNIMPLEMENTED]: 501,
  [GrpcStatus.UNAVAILABLE]: 503,
  [GrpcStatus.DEADLINE_EXCEEDED]: 504,
};

function httpStatusFromError(error: unknown): number {
  const code = (error as { code?: unknown })?.code;

  return typeof code === 'number' ? (GRPC_TO_HTTP_STATUS[code as GrpcStatus] ?? 500) : 500;
}

const InstrumentationMiddleware = (handler: NextApiHandler): NextApiHandler => {
  return async (request, response) => {
    const span = trace.getSpan(context.active()) as Span;

    let httpStatus = 200;
    try {
      await runWithSpan(span, async () => handler(request, response));
      httpStatus = response.statusCode;
    } catch (error) {
      httpStatus = httpStatusFromError(error);

      // Per the OTel HTTP semantic conventions a SERVER span must only be
      // marked ERROR for a server-side failure; a 4xx is the caller's problem
      // and stays unset so it does not inflate the service error rate.
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
