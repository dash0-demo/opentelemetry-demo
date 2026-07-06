// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

// Structured logger that writes single-line JSON to stdout.
// Each log record stays on one line, so the filelog receiver ingests it as a
// single record without multiline aggregation — even when exception.stacktrace
// contains newlines (pino escapes them as \n inside the JSON string).
//
// Deliberately uses stdout/stderr only (no OTLP log exporter / bridge):
//   - All logs remain visible via `kubectl logs`.
//   - Bootstrap, crash, and library logs are captured automatically.
//   - No risk of silent log loss when the OTLP endpoint is unreachable.
//
// The Dash0 operator's filelog receiver picks up stdout and forwards to the
// backend, where trace_id / span_id enable log ↔ trace correlation.

const pino = require('pino');

const logger = pino({
  // Single-line JSON — required so that the filelog receiver sees one record
  // per log entry, not one record per line of a pretty-printed block.
  // (pino defaults to single-line JSON; this comment makes the intent explicit.)
  base: { 'service.name': process.env.OTEL_SERVICE_NAME || 'frontend' },
  formatters: {
    level: (label) => ({ level: label }),
  },
  // Serialize Error objects as structured fields instead of "[object Object]".
  // pino's built-in `err` serializer extracts type, message, and stack into
  // separate string fields, keeping the entire record on one line.
  serializers: {
    err: pino.stdSerializers.err,
  },
});

module.exports = logger;
