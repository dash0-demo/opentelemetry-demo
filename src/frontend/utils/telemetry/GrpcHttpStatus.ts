// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

import { status as GrpcStatus } from '@grpc/grpc-js';

// The frontend's API routes are thin proxies in front of gRPC backends, so the
// gRPC status of a failed backend call is what determines the HTTP status the
// browser should see. Without this mapping every backend error -- including a
// plain "this product does not exist" -- surfaces as a 500, which hides real
// server faults among ordinary client mistakes.
const GRPC_TO_HTTP_STATUS: Partial<Record<GrpcStatus, number>> = {
  [GrpcStatus.INVALID_ARGUMENT]: 400,
  [GrpcStatus.FAILED_PRECONDITION]: 400,
  [GrpcStatus.OUT_OF_RANGE]: 400,
  [GrpcStatus.UNAUTHENTICATED]: 401,
  [GrpcStatus.PERMISSION_DENIED]: 403,
  [GrpcStatus.NOT_FOUND]: 404,
  [GrpcStatus.ALREADY_EXISTS]: 409,
  [GrpcStatus.ABORTED]: 409,
  [GrpcStatus.RESOURCE_EXHAUSTED]: 429,
  [GrpcStatus.UNIMPLEMENTED]: 501,
  [GrpcStatus.UNAVAILABLE]: 503,
  [GrpcStatus.DEADLINE_EXCEEDED]: 504,
};

// A grpc-js ServiceError carries its status in a numeric `code` property. Any
// other error -- a bug in the route, a failed JSON serialization -- has no code
// and stays a 500.
export const httpStatusFromError = (error: unknown): number => {
  const code = (error as { code?: unknown } | null)?.code;

  if (typeof code !== 'number') {
    return 500;
  }

  return GRPC_TO_HTTP_STATUS[code as GrpcStatus] ?? 500;
};

export default httpStatusFromError;
