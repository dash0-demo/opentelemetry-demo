// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

import { status as GrpcStatus } from '@grpc/grpc-js';

// Maps an upstream gRPC status code to the HTTP status code the API route
// should return, so that a caller error is not reported as a server fault.
//
// This mapping is deliberately conservative: it only contains codes that can
// *only* mean "the caller asked for something invalid". Every other code --
// including INTERNAL, UNAVAILABLE, DEADLINE_EXCEEDED, RESOURCE_EXHAUSTED and
// FAILED_PRECONDITION -- keeps its 5xx classification, because services in this
// repository use those for genuine server-side faults. FAILED_PRECONDITION in
// particular is returned by the cart service when its storage backend is
// unreachable; the canonical gRPC mapping would turn that into a 400 and hide a
// real outage, so it is intentionally left out.
const GRPC_CLIENT_ERROR_TO_HTTP_STATUS: Record<number, number> = {
  [GrpcStatus.INVALID_ARGUMENT]: 400,
  [GrpcStatus.OUT_OF_RANGE]: 400,
  [GrpcStatus.UNAUTHENTICATED]: 401,
  [GrpcStatus.PERMISSION_DENIED]: 403,
  [GrpcStatus.NOT_FOUND]: 404,
  [GrpcStatus.ALREADY_EXISTS]: 409,
};

// A few server-side codes carry more information than a bare 500.
const GRPC_SERVER_ERROR_TO_HTTP_STATUS: Record<number, number> = {
  [GrpcStatus.UNIMPLEMENTED]: 501,
  [GrpcStatus.UNAVAILABLE]: 503,
  [GrpcStatus.DEADLINE_EXCEEDED]: 504,
};

// Anything that is not a recognised gRPC ServiceError stays a 500: an
// unexpected error in the frontend itself is a server fault.
export function httpStatusFromError(error: unknown): number {
  const code = (error as { code?: unknown })?.code;

  if (typeof code !== 'number') {
    return 500;
  }

  return GRPC_CLIENT_ERROR_TO_HTTP_STATUS[code] ?? GRPC_SERVER_ERROR_TO_HTTP_STATUS[code] ?? 500;
}

export default httpStatusFromError;
