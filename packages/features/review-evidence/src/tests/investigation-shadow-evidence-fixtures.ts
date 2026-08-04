import { createHash } from "node:crypto";
import {
  InvestigationShadowEvidenceAuthority,
  InvestigationShadowEvidenceConclusion,
  InvestigationShadowEvidenceSourceKind,
  ReviewProviderKind,
  ReviewTrustDomain,
  createInvestigationShadowEvidence,
  investigationShadowEvidenceRetentionMs,
  investigationShadowEvidenceRetentionPolicyVersion,
  investigationShadowEvidenceVersion,
  stableJson,
  type InvestigationShadowEvidence,
  type InvestigationShadowEvidenceCandidate,
} from "../index";

export const shadowIssuedAtMs = Date.UTC(2026, 7, 3, 10, 0, 0);

export function shadowEvidence(
  overrides: Partial<InvestigationShadowEvidenceCandidate> = {},
): InvestigationShadowEvidence {
  const terminalObservationCanonicalJson = stableJson({
    normalizedFindings: [],
    normalizedLifecycleRevalidations: [],
    payloadVersion: 2,
    safeUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  });
  const terminalHash = shadowHash(terminalObservationCanonicalJson);
  return createInvestigationShadowEvidence({
    shadowEvidenceId: "investigation-shadow-fixture",
    evidenceVersion: investigationShadowEvidenceVersion,
    authority: InvestigationShadowEvidenceAuthority.NonAuthoritative,
    sourceKind: InvestigationShadowEvidenceSourceKind.TerminalCertificate,
    retentionPolicyVersion: investigationShadowEvidenceRetentionPolicyVersion,
    investigationId: "investigation-fixture",
    investigationVersion: 8,
    scope: {
      workspaceId: "workspace-fixture",
      repositoryConnectionId: "repository-fixture",
      scmRepositoryIdentityId: "scm-fixture",
      pullRequestNumber: 42,
      trustDomain: ReviewTrustDomain.TrustedManaged,
      authorizationScopeHash: shadowHash("authorization-scope"),
    },
    revision: {
      baseSha: "1".repeat(40),
      mergeBaseSha: "2".repeat(40),
      headSha: "3".repeat(40),
      reviewRevisionHash: shadowHash("revision"),
    },
    executionId: "execution-fixture",
    workSlotId: "slot-fixture",
    stableReviewUnitKey: "unit-fixture",
    providerVoteLaneId: "lane-fixture",
    producerReleaseId: "release-fixture",
    conclusion: InvestigationShadowEvidenceConclusion.VerifiedClean,
    certificateId: "certificate-fixture",
    certificateHash: shadowHash("certificate"),
    certificateCanonicalJson: stableJson({
      certificateId: "certificate-fixture",
    }),
    terminalProviderKind: ReviewProviderKind.Codex,
    terminalActualModel: "gpt-5.6-codex",
    terminalOutcomeHash: terminalHash,
    terminalObservationCanonicalJson,
    terminalPayloadHash: terminalHash,
    terminalPayloadByteCount: new TextEncoder().encode(
      terminalObservationCanonicalJson,
    ).byteLength,
    findingCount: 0,
    recordHash: shadowHash("record"),
    issuedAtMs: shadowIssuedAtMs,
    retainUntilMs: shadowIssuedAtMs + investigationShadowEvidenceRetentionMs,
    ...overrides,
  });
}

export function shadowHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
