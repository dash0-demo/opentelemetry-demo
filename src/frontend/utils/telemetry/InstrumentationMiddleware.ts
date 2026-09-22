// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

import { NextApiHandler } from 'next';
import { context, Exception, Span, SpanStatusCode, trace } from '@opentelemetry/api';
import { SemanticAttributes } from '@opentelemetry/semantic-conventions';
import { status as GrpcStatus } from '@grpc/grpc-js';

import logger from './logger';

// Upstream gRPC failures reach this middleware as grpc-js ServiceErrors. Mapping
// their status code to the matching HTTP status keeps a caller mistake — asking
// for a product that does not exist — out of the 5xx and ERROR-span population,
// instead of reporting every upstream rejection as a server fault.
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

  return typeof code === 'number' ? (GRPC_TO_HTTP_STATUS[code] ?? 500) : 500;
};

const InstrumentationMiddleware = (handler: NextApiHandler): NextApiHandler => {
  return async (request, response) => {
    const span = trace.getSpan(context.active()) as Span;

    let httpStatus = 200;
    try {
      await runWithSpan(span, async () => handler(request, response));
      httpStatus = response.statusCode;
    } catch (error) {
      httpStatus = httpStatusForError(error);
      const isClientError = httpStatus < 500;

      // Only a server-side failure sets the span status to ERROR. A 4xx is
      // caused by the caller, so recording it as an error would inflate this
      // service's error rate and the alerts derived from it.
      if (!isClientError) {
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

      if (isClientError) {
        logger.warn(logPayload, 'api.client_error');
      } else {
        logger.error(logPayload, 'api.error');
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
