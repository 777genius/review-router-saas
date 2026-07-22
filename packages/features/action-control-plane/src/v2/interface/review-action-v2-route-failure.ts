import {
  reviewActionV2Operations,
  ReviewActionV2OperationId,
  ReviewActionV2ProtocolErrorCode,
} from "@reviewrouter/protocol-review-action-v2";

export type ReviewActionV2RouteFailureStatus =
  | 400
  | 401
  | 403
  | 404
  | 409
  | 410
  | 412
  | 413
  | 422
  | 426
  | 429
  | 500
  | 503;

export class ReviewActionV2RouteFailure extends Error {
  readonly issues: readonly string[];

  constructor(
    readonly statusCode: ReviewActionV2RouteFailureStatus,
    readonly errorCode: ReviewActionV2ProtocolErrorCode,
    issues: readonly string[],
  ) {
    super(`review_action_v2_route_failure:${errorCode}`);
    this.name = "ReviewActionV2RouteFailure";
    this.issues = normalizeSafeIssues(issues, errorCode);
  }
}

export function toSafeReviewActionV2RouteFailure(
  error: unknown,
  operationId: ReviewActionV2OperationId,
): ReviewActionV2RouteFailure {
  const descriptor = reviewActionV2Operations.find(
    (candidate) => candidate.operationId === operationId,
  );
  if (!descriptor) {
    throw new Error(`review_action_v2_route_descriptor_missing:${operationId}`);
  }

  if (
    error instanceof ReviewActionV2RouteFailure &&
    error.statusCode === statusFor(error.errorCode) &&
    descriptor.errorCodes.includes(error.errorCode as never)
  ) {
    return error;
  }

  if (
    descriptor.errorCodes.includes(
      ReviewActionV2ProtocolErrorCode.AmbiguousOutcome as never,
    )
  ) {
    return new ReviewActionV2RouteFailure(
      statusFor(ReviewActionV2ProtocolErrorCode.AmbiguousOutcome),
      ReviewActionV2ProtocolErrorCode.AmbiguousOutcome,
      ["handler_failed"],
    );
  }
  if (
    descriptor.errorCodes.includes(
      ReviewActionV2ProtocolErrorCode.ServiceUnavailable as never,
    )
  ) {
    return new ReviewActionV2RouteFailure(
      statusFor(ReviewActionV2ProtocolErrorCode.ServiceUnavailable),
      ReviewActionV2ProtocolErrorCode.ServiceUnavailable,
      ["handler_failed"],
    );
  }

  throw new Error(
    `review_action_v2_route_failure_fallback_missing:${operationId}`,
  );
}

function statusFor(
  errorCode: ReviewActionV2ProtocolErrorCode,
): ReviewActionV2RouteFailureStatus {
  switch (errorCode) {
    case ReviewActionV2ProtocolErrorCode.InvalidRequest:
      return 400;
    case ReviewActionV2ProtocolErrorCode.InvalidAuthentication:
      return 401;
    case ReviewActionV2ProtocolErrorCode.Forbidden:
    case ReviewActionV2ProtocolErrorCode.CapabilityDisabled:
      return 403;
    case ReviewActionV2ProtocolErrorCode.NotFound:
      return 404;
    case ReviewActionV2ProtocolErrorCode.IdempotencyConflict:
      return 409;
    case ReviewActionV2ProtocolErrorCode.ResourceGone:
      return 410;
    case ReviewActionV2ProtocolErrorCode.StalePrecondition:
      return 412;
    case ReviewActionV2ProtocolErrorCode.LimitExceeded:
      return 413;
    case ReviewActionV2ProtocolErrorCode.InvariantViolation:
      return 422;
    case ReviewActionV2ProtocolErrorCode.UnsupportedProtocol:
      return 426;
    case ReviewActionV2ProtocolErrorCode.CapacityLimited:
      return 429;
    case ReviewActionV2ProtocolErrorCode.AmbiguousOutcome:
      return 500;
    case ReviewActionV2ProtocolErrorCode.ServiceUnavailable:
      return 503;
  }
}

function normalizeSafeIssues(
  issues: readonly string[],
  fallback: ReviewActionV2ProtocolErrorCode,
): readonly string[] {
  const safe = [...new Set(issues)]
    .filter((issue) => /^[a-z0-9][a-z0-9_:-]{0,159}$/.test(issue))
    .slice(0, 8);
  return Object.freeze(safe.length > 0 ? safe : [fallback]);
}
