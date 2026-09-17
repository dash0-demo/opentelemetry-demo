// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

import { NextApiHandler } from 'next';
import { context, Exception, Span, SpanStatusCode, trace } from '@opentelemetry/api';
import { SemanticAttributes } from '@opentelemetry/semantic-conventions';
import { status as GrpcStatus } from '@grpc/grpc-js';

import logger from './logger';

// Upstream gRPC failures that are caused by the request rather than by a
// backend fault. Returning 500 for these mislabels a client mistake as a
// server outage: a request for a product ID that does not exist became an
// HTTP 500 and an ERROR span, inflating the frontend's error rate.
const GRPC_TO_HTTP_STATUS: Record<number, number> = {
  [GrpcStatus.INVALID_ARGUMENT]: 400,
  [GrpcStatus.UNAUTHENTICATED]: 401,
  [GrpcStatus.PERMISSION_DENIED]: 403,
  [GrpcStatus.NOT_FOUND]: 404,
  [GrpcStatus.ALREADY_EXISTS]: 409,
  [GrpcStatus.FAILED_PRECONDITION]: 412,
  [GrpcStatus.RESOURCE_EXHAUSTED]: 429,
};

function httpStatusForError(error: unknown): number {
  const code = (error as { code?: unknown }).code;

  if (typeof code === 'number' && code in GRPC_TO_HTTP_STATUS) {
    return GRPC_TO_HTTP_STATUS[code];
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
      const isServerFault = httpStatus >= 500;

      if (isServerFault) {
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
        http_status: httpStatus,
      };

      if (isServerFault) {
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
