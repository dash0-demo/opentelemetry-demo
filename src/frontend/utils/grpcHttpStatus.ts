// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

import { status as GrpcStatus } from '@grpc/grpc-js';

// gRPC status codes that describe a problem with the caller's request rather
// than a failure of the backend. Everything else — INTERNAL, UNAVAILABLE,
// DEADLINE_EXCEEDED, an unexpected exception — stays a 500, so genuine backend
// failures (including the ones this demo injects via feature flags) keep
// surfacing as server errors.
const GRPC_CLIENT_ERROR_TO_HTTP_STATUS: Partial<Record<GrpcStatus, number>> = {
  [GrpcStatus.INVALID_ARGUMENT]: 400,
  [GrpcStatus.UNAUTHENTICATED]: 401,
  [GrpcStatus.PERMISSION_DENIED]: 403,
  [GrpcStatus.NOT_FOUND]: 404,
  [GrpcStatus.ALREADY_EXISTS]: 409,
};

/**
 * Maps a rejected downstream call to the HTTP status the API route should
 * return. gRPC client-error codes become their 4xx equivalent; anything else
 * — including non-gRPC errors, whose `code` is absent or a string such as
 * `ECONNREFUSED` — becomes 500.
 */
export default function httpStatusFromError(error: unknown): number {
  const code = (error as { code?: unknown } | null | undefined)?.code;

  if (typeof code !== 'number') {
    return 500;
  }

  return GRPC_CLIENT_ERROR_TO_HTTP_STATUS[code as GrpcStatus] ?? 500;
}
