// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

import { NextApiHandler } from 'next';
import { context, Exception, Span, SpanStatusCode, trace } from '@opentelemetry/api';
import { SemanticAttributes } from '@opentelemetry/semantic-conventions';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const logger = require('./logger');

const InstrumentationMiddleware = (handler: NextApiHandler): NextApiHandler => {
  return async (request, response) => {
    const span = trace.getSpan(context.active()) as Span;

    let httpStatus = 200;
    try {
      await runWithSpan(span, async () => handler(request, response));
      httpStatus = response.statusCode;
    } catch (error) {
      span.recordException(error as Exception);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: (error as Error).message,
      });
      httpStatus = 500;

      // Emit a single structured log record with the full stack trace serialized
      // into one line. Without this, Node.js / Next.js prints error.stack to
      // stderr as raw multi-line text and the filelog receiver splits each
      // "    at ..." frame into a separate, context-free log record.
      const spanCtx = span.spanContext();
      logger.error(
        {
          err: error,
          trace_id: spanCtx.traceId,
          span_id: spanCtx.spanId,
        },
        'api.error',
      );

      throw error;
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
