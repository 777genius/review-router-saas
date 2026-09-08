import type { ReviewRunAuthorization } from "../../domain/review-run-authorization";
import type { VerifiedReviewRunAuthorizationToken } from "../ports/platform-ports";

/** Complete claim comparison against a current row and its canonical scope digest.
 * The caller owns locking, scope hashing, state and current-time validity checks.
 */
export function tokenClaimsMatchAuthorization(
  token: VerifiedReviewRunAuthorizationToken,
  authorization: ReviewRunAuthorization,
  scopeHash: string,
): boolean {
  const issuedAt = authorization.renewedAt ?? authorization.createdAt;
  const expectedLaneIds = authorization.providerVoteLanes.map(
    (lane) => lane.providerVoteIdentityHash,
  );
  return (
    token.capabilityId === authorization.authorizationId &&
    token.authorizationId === authorization.authorizationId &&
    token.issuer === authorization.tokenIssuer &&
    token.audience === authorization.tokenAudience &&
    token.scopeHash === scopeHash &&
    token.producerReleaseId === authorization.producerReleaseId &&
    token.selectedProtocolVersion === authorization.selectedProtocolVersion &&
    token.schemaDigest === authorization.schemaDigest &&
    token.protocolLimitsProfileId === authorization.protocolLimitsProfileId &&
    token.operationalSloProfileId === authorization.operationalSloProfileId &&
    token.mutationEpoch === authorization.mutationEpoch &&
    token.authorizationSafetyDecisionHash ===
      authorization.authorizationSafetyDecisionHash &&
    token.providerVoteLaneIds.length === expectedLaneIds.length &&
    token.providerVoteLaneIds.every(
      (laneId, index) => laneId === expectedLaneIds[index],
    ) &&
    numericDate(token.issuedAt) === numericDate(issuedAt) &&
    numericDate(token.expiresAt) === numericDate(authorization.expiresAt)
  );
}

function numericDate(value: Date): number {
  return Math.floor(value.getTime() / 1_000);
}
