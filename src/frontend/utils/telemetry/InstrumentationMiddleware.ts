// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

import { NextApiHandler } from 'next';
import { context, Exception, Span, SpanStatusCode, trace } from '@opentelemetry/api';
import { SemanticAttributes } from '@opentelemetry/semantic-conventions';
import { status as GrpcStatus } from '@grpc/grpc-js';

import logger from './logger';

// Every API route reaches a backend over gRPC, and the gateways reject with a
// grpc-js ServiceError carrying a numeric `code`. Without this mapping a client
// error such as "product does not exist" (gRPC NOT_FOUND) is reported to the
// browser as HTTP 500, which both misleads the caller and inflates the
// frontend's server-error rate with faults it did not cause.
const GRPC_TO_HTTP_STATUS: Record<number, number> = {
  [GrpcStatus.CANCELLED]: 499,
  [GrpcStatus.INVALID_ARGUMENT]: 400,
  [GrpcStatus.DEADLINE_EXCEEDED]: 504,
  [GrpcStatus.NOT_FOUND]: 404,
  [GrpcStatus.ALREADY_EXISTS]: 409,
  [GrpcStatus.PERMISSION_DENIED]: 403,
  [GrpcStatus.RESOURCE_EXHAUSTED]: 429,
  [GrpcStatus.FAILED_PRECONDITION]: 400,
  [GrpcStatus.OUT_OF_RANGE]: 400,
  [GrpcStatus.UNIMPLEMENTED]: 501,
  [GrpcStatus.UNAVAILABLE]: 503,
  [GrpcStatus.UNAUTHENTICATED]: 401,
};

const httpStatusForError = (error: unknown): number => {
  const code = (error as { code?: unknown })?.code;

  if (typeof code !== 'number') return 500;

  return GRPC_TO_HTTP_STATUS[code] ?? 500;
};

const InstrumentationMiddleware = (handler: NextApiHandler): NextApiHandler => {
  return async (request, response) => {
    const span = trace.getSpan(context.active()) as Span;

    let httpStatus = 200;
    try {
      await runWithSpan(span, async () => handler(request, response));
      httpStatus = response.statusCode;
    } catch (error) {
      const message = (error as Error).message;
      httpStatus = httpStatusForError(error);

      // Per the OTel HTTP semantic conventions, a SERVER span must only be
      // marked Error for a server-side fault. A 4xx is the caller's mistake, so
      // recording it as Error would attribute someone else's bad request to
      // this service.
      if (httpStatus >= 500) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message,
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
        http_status_code: httpStatus,
        trace_id: spanCtx.traceId,
        span_id: spanCtx.spanId,
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
