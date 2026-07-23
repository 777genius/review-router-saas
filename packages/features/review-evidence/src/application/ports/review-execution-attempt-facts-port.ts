import type { ProviderInvocationManifest } from "../../domain/provider-invocation-manifest";
import type {
  ReviewEvidenceScope,
  ReviewProviderKind,
  ReviewRevision,
  ReviewTaskKind,
  ReviewTrustDomain,
  ProviderExecutionProfile,
} from "../../domain/review-evidence-primitives";

export enum ReviewExecutionAttemptReportState {
  Reportable = "reportable",
  SupersededHistoricalOnly = "superseded_historical_only",
  AuthorizationRevoked = "authorization_revoked",
  ProducerReleaseRevoked = "producer_release_revoked",
  ReportWindowExpired = "report_window_expired",
  Unknown = "unknown",
}

export type ReviewExecutionAttemptFacts = Readonly<{
  attemptId: string;
  scope: ReviewEvidenceScope;
  revision: ReviewRevision;
  planHash: string;
  sourceExecutionId: string;
  sourceWorkSlotId: string;
  sourceAuthorizationId: string;
  sourceRunId: string;
  sourceRunAttempt: string;
  manifest: ProviderInvocationManifest;
  manifestKey: string;
  providerInvocationKey: string;
  providerVoteIdentityHash: string;
  providerKind: ReviewProviderKind;
  taskKindSet: readonly ReviewTaskKind[];
  requestedModel: string;
  providerRuntimeVersion: string;
  producerReleaseId: string;
  selectedProtocolVersion: string;
  trustedCapabilityProfile: string;
  executionProfile: ProviderExecutionProfile;
  trustDomain: ReviewTrustDomain;
  sourceLeaseId: string;
  leaseCapabilityId: string;
  ownerIdHash: string;
  sourceFencingToken: string;
  resultReportUntilMs: number;
  reportState: ReviewExecutionAttemptReportState;
}>;

export interface ReviewExecutionAttemptFactsPort {
  findAttemptFacts(input: {
    readonly attemptId: string;
    readonly leaseCapabilityId: string;
  }): Promise<ReviewExecutionAttemptFacts | null>;
}
