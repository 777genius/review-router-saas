import { describe, expect, it } from "vitest";
import {
  ReviewInvestigationConclusion,
  ContextCriticDecision,
  InvestigationTurnProviderKind,
  ReviewInvestigationRuntimeProfile,
  ReviewInvestigationState,
  ReviewInvestigationTurnPurpose,
  canonicalInvestigationCertificateCandidate,
  type InvestigationStorePort,
  type ReviewInvestigation,
} from "@reviewrouter/features-review-investigations";
import { NodeSha256InvestigationDigest } from "@reviewrouter/features-review-investigations/composition";
import {
  InvestigationCertificateConclusion,
  InvestigationCertificateVerificationDenialReason,
  InvestigationCertificateVerificationStatus,
} from "@reviewrouter/features-review-evidence";
import { ReviewInvestigationCertificateVerificationAdapter } from "./review-investigation-certificate-verification-adapter.js";

const h = (value: string) => value.repeat(64);

describe("ReviewInvestigationCertificateVerificationAdapter", () => {
  it("accepts only the exact scope, revision, lane, payload, and release", async () => {
    const investigation = await certificateBackedInvestigation();
    const digest = new NodeSha256InvestigationDigest();
    const adapter = new ReviewInvestigationCertificateVerificationAdapter(
      storeWith(investigation),
      digest,
    );
    await expect(adapter.verifyAcceptedCertificate(query(
      investigation.certificate!.certificateHash,
      investigation.certificate!.terminalOutcomeHash,
    ))).resolves.toEqual({
      status: InvestigationCertificateVerificationStatus.Accepted,
      reason: InvestigationCertificateVerificationDenialReason.None,
      acceptedCertificateHash: investigation.certificate!.certificateHash,
      conclusion: InvestigationCertificateConclusion.VerifiedClean,
    });
  });

  it("fails closed when the terminal payload hash differs", async () => {
    const investigation = await certificateBackedInvestigation();
    const adapter = new ReviewInvestigationCertificateVerificationAdapter(
      storeWith(investigation),
      new NodeSha256InvestigationDigest(),
    );
    await expect(adapter.verifyAcceptedCertificate({
      ...query(
        investigation.certificate!.certificateHash,
        investigation.certificate!.terminalOutcomeHash,
      ),
      terminalOutcomeHash: h("9"),
    })).resolves.toMatchObject({
      status: InvestigationCertificateVerificationStatus.Denied,
      reason:
        InvestigationCertificateVerificationDenialReason.TerminalOutcomeMismatch,
    });
  });

  it("rejects a rehashed certificate whose model disagrees with the turn ledger", async () => {
    const investigation = await certificateBackedInvestigation();
    const digest = new NodeSha256InvestigationDigest();
    const { certificateHash: _, ...candidate } = investigation.certificate!;
    const tamperedCandidate = {
      ...candidate,
      terminalActualModel: "gpt-other",
    };
    const certificate = {
      ...tamperedCandidate,
      certificateHash: await digest.digestUtf8(
        canonicalInvestigationCertificateCandidate(tamperedCandidate),
      ),
    };
    const adapter = new ReviewInvestigationCertificateVerificationAdapter(
      storeWith({ ...investigation, certificate }),
      digest,
    );
    await expect(adapter.verifyAcceptedCertificate(query(
      certificate.certificateHash,
      certificate.terminalOutcomeHash,
    ))).resolves.toMatchObject({
      status: InvestigationCertificateVerificationStatus.Denied,
      reason: InvestigationCertificateVerificationDenialReason.NotAccepted,
    });
  });
});

function query(certificateHash: string, terminalOutcomeHash: string) {
  return {
    certificateId: "certificate-1",
    certificateHash,
    scope: {
      workspaceId: "workspace-1",
      repositoryConnectionId: "connection-1",
      scmRepositoryIdentityId: "repository-1",
      pullRequestNumber: 42,
      authorizationScopeHash: h("1"),
    },
    revision: {
      baseSha: "1".repeat(40),
      mergeBaseSha: "2".repeat(40),
      headSha: "3".repeat(40),
      reviewRevisionHash: h("4"),
    },
    providerVoteIdentityHash: h("5"),
    terminalOutcomeHash,
    expectedConclusion: InvestigationCertificateConclusion.VerifiedClean,
    producerReleaseId: "release-1",
    nowMs: Date.parse("2026-08-02T10:00:00.000Z"),
  } as const;
}

async function certificateBackedInvestigation(): Promise<ReviewInvestigation> {
  const digest = new NodeSha256InvestigationDigest();
  const terminalObservationCanonicalJson = JSON.stringify({ payloadVersion: 2 });
  const candidate = {
    certificateId: "certificate-1",
    investigationId: "investigation-1",
    investigationVersion: 4,
    dossierDigest: h("7"),
    reviewRevisionHash: h("4"),
    stableReviewUnitKey: "unit-1",
    providerVoteLaneId: h("5"),
    coverageContractVersion: "coverage-v1",
    expansionRulesVersion: "expansion-v1",
    gatewayPolicyVersion: "gateway-v4",
    criticPolicyVersion: "critic-v1",
    runtimeProfileVersion: "runtime-v1",
    producerReleaseId: "release-1",
    conclusion: ReviewInvestigationConclusion.VerifiedClean,
    findingSetHash: h("a"),
    obligationSetHash: h("b"),
    receiptSetHash: h("c"),
    scopeHash: h("d"),
    coverageStateHash: h("e"),
    contextAttestationSetHash: h("f"),
    turnProvenanceHash: h("0"),
    terminalProviderKind: InvestigationTurnProviderKind.Codex,
    terminalActualModel: "gpt-test",
    terminalOutcomeHash: await digest.digestUtf8(
      terminalObservationCanonicalJson,
    ),
    terminalObservationCanonicalJson,
    criticAttestationId: "attestation-critic",
    criticAttestationHash: h("2"),
    criticDecision: ContextCriticDecision.Accept,
    issuedAt: "2026-08-02T09:00:00.000Z",
    expiresAt: "2026-08-03T10:00:00.000Z",
  } as const;
  const certificate = {
    ...candidate,
    certificateHash: await digest.digestUtf8(
      canonicalInvestigationCertificateCandidate(candidate),
    ),
  };
  return {
    investigationId: "investigation-1",
    version: 5,
    state: ReviewInvestigationState.Concluded,
    criticDecision: ContextCriticDecision.Accept,
    conclusion: ReviewInvestigationConclusion.VerifiedClean,
    scope: {
      workspaceId: "workspace-1",
      repositoryConnectionId: "connection-1",
      scmRepositoryIdentityId: "repository-1",
      pullRequestNumber: 42,
      trustDomain: "trusted-managed",
      authorizationScopeHash: h("1"),
    },
    revision: {
      baseSha: "1".repeat(40),
      mergeBaseSha: "2".repeat(40),
      headSha: "3".repeat(40),
      reviewRevisionHash: h("4"),
    },
    turnProvenance: [{
      turnId: "turn-1",
      purpose: ReviewInvestigationTurnPurpose.Discovery,
      actualProviderKind: InvestigationTurnProviderKind.Codex,
      actualModel: "gpt-test",
      runtimeProfile: ReviewInvestigationRuntimeProfile.GatewayAttestedAgentV1,
      inputTokens: 10,
      cachedInputTokens: 0,
      outputTokens: 5,
      reasoningOutputTokens: 0,
      totalTokens: 15,
      durationMs: 100,
      acceptedAttestationId: "attestation-1",
      acceptedAttestationHash: h("8"),
      terminalOutcomeHash: h("9"),
    }],
    certificate,
  } as unknown as ReviewInvestigation;
}

function storeWith(
  investigation: ReviewInvestigation,
): InvestigationStorePort {
  return {
    findByCertificateId: async () => investigation,
  } as unknown as InvestigationStorePort;
}
