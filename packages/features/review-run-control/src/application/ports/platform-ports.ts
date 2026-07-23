import type { ReviewRunAuthorization } from "../../domain/review-run-authorization";
import type { ReviewRunAuthorizationTokenAudience } from "../../domain/review-run-control-types";

export interface ClockPort {
  now(): Date;
}

export interface IdentifierFactoryPort {
  nextId(prefix: string): string;
}

export interface Sha256DigestPort {
  digestUtf8(value: string): Promise<string>;
}

export type IssuedReviewRunAuthorizationToken = {
  readonly token: string;
  readonly keyId: string;
  readonly expiresAt: Date;
};

export type ReviewRunAuthorizationTokenProfile = {
  readonly issuer: string;
  readonly audience: ReviewRunAuthorizationTokenAudience;
};

export type VerifiedReviewRunAuthorizationToken = {
  readonly capabilityId: string;
  readonly authorizationId: string;
  readonly issuer: string;
  readonly audience: ReviewRunAuthorizationTokenAudience;
  readonly scopeHash: string;
  readonly producerReleaseId: string;
  readonly selectedProtocolVersion: string;
  readonly schemaDigest: string;
  readonly protocolLimitsProfileId: string;
  readonly operationalSloProfileId: string;
  readonly mutationEpoch: bigint;
  readonly authorizationSafetyDecisionHash: string;
  readonly providerVoteLaneIds: readonly string[];
  readonly issuedAt: Date;
  readonly expiresAt: Date;
};

export interface ReviewRunAuthorizationTokenPort {
  profile(): ReviewRunAuthorizationTokenProfile;
  activeKeyId(): Promise<string>;
  issue(
    authorization: ReviewRunAuthorization,
  ): Promise<IssuedReviewRunAuthorizationToken>;
  verify(input: {
    readonly token: string;
    readonly now: Date;
  }): Promise<VerifiedReviewRunAuthorizationToken>;
}
