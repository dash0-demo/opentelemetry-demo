// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

// Structured logger that writes single-line JSON to stdout.
//
// The Dash0 operator's filelog receiver picks up container stdout; when it is
// configured with a JSON parser operator, each line becomes one LogRecord with
// `trace_id` / `span_id` promoted onto the record (enabling log-trace
// correlation in Dash0). Without that parser this file still works — records
// arrive as a single-line body string, which is already an improvement over
// multi-line stack traces being ingested as one record per frame.
//
// Deliberately stdout only — no OTLP log exporter / bridge:
//   - `kubectl logs` continues to work.
//   - Bootstrap, crash, and library output are captured automatically.
//   - No silent loss when the OTLP endpoint is unreachable.
//
// Resource attributes (service.name, service.namespace, k8s.*) are attached
// downstream by the Dash0 operator, so this file does not set them.

import pino from 'pino';

const logger = pino({
  formatters: {
    level: label => ({ level: label }),
  },
  serializers: {
    err: pino.stdSerializers.err,
  },
});

export default logger;
