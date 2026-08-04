import { describe, expect, it } from "vitest";
import {
  ReviewInvestigationConclusion,
  ContextCriticDecision,
  InvestigationTurnProviderKind,
  ReviewInvestigationRuntimeProfile,
  ReviewInvestigationState,
  ReviewInvestigationTurnPurpose,
  canonicalContextAttestationSet,
  canonicalInvestigationCertificateCandidate,
  canonicalTurnProvenanceSet,
  type InvestigationStorePort,
  type ReviewInvestigation,
} from "@reviewrouter/features-review-investigations";
import { NodeSha256InvestigationDigest } from "@reviewrouter/features-review-investigations/composition";
import {
  InvestigationCertificateConclusion,
  InvestigationCertificateVerificationDenialReason,
  InvestigationCertificateVerificationStatus,
  ReviewProviderKind,
} from "@reviewrouter/features-review-evidence";
import { InvestigationRolloutCapability } from "@reviewrouter/features-review-investigation-operations";
import { ReviewActionV2RouteFailure } from "@reviewrouter/features-action-control-plane/v2";
import { ReviewActionV2ProtocolErrorCode } from "@reviewrouter/protocol-review-action-v2";
import { ReviewInvestigationCertificateVerificationAdapter } from "./review-investigation-certificate-verification-adapter.js";

const h = (value: string) => value.repeat(64);

describe("ReviewInvestigationCertificateVerificationAdapter", () => {
  it("accepts only the exact scope, revision, lane, payload, and release", async () => {
    const investigation = await certificateBackedInvestigation();
    const digest = new NodeSha256InvestigationDigest();
    const adapter = new ReviewInvestigationCertificateVerificationAdapter(
      storeWith(investigation),
      digest,
      allowingRollout,
    );
    await expect(
      adapter.verifyAcceptedCertificate(
        query(
          investigation.certificate!.certificateHash,
          investigation.certificate!.terminalOutcomeHash,
        ),
      ),
    ).resolves.toEqual({
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
      allowingRollout,
    );
    await expect(
      adapter.verifyAcceptedCertificate({
        ...query(
          investigation.certificate!.certificateHash,
          investigation.certificate!.terminalOutcomeHash,
        ),
        terminalOutcomeHash: h("9"),
      }),
    ).resolves.toMatchObject({
      status: InvestigationCertificateVerificationStatus.Denied,
      reason:
        InvestigationCertificateVerificationDenialReason.TerminalOutcomeMismatch,
    });
  });

  it("rejects a rehashed certificate whose model disagrees with the turn ledger", async () => {
    const investigation = await certificateBackedInvestigation();
    const digest = new NodeSha256InvestigationDigest();
    const { certificateHash, ...candidate } = investigation.certificate!;
    void certificateHash;
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
      allowingRollout,
    );
    await expect(
      adapter.verifyAcceptedCertificate(
        query(certificate.certificateHash, certificate.terminalOutcomeHash),
      ),
    ).resolves.toMatchObject({
      status: InvestigationCertificateVerificationStatus.Denied,
      reason: InvestigationCertificateVerificationDenialReason.NotAccepted,
    });
  });

  it("rechecks shadow rollout before evidence acceptance", async () => {
    const investigation = await certificateBackedInvestigation();
    const checked: InvestigationRolloutCapability[] = [];
    const adapter = new ReviewInvestigationCertificateVerificationAdapter(
      storeWith(investigation),
      new NodeSha256InvestigationDigest(),
      {
        async assertAllowed({ capability }) {
          checked.push(capability);
          throw new Error("disabled");
        },
      },
    );

    await expect(
      adapter.verifyAcceptedCertificate(
        query(
          investigation.certificate!.certificateHash,
          investigation.certificate!.terminalOutcomeHash,
        ),
      ),
    ).resolves.toMatchObject({
      status: InvestigationCertificateVerificationStatus.Denied,
      reason: InvestigationCertificateVerificationDenialReason.NotAccepted,
    });
    expect(checked).toEqual([InvestigationRolloutCapability.Shadow]);
  });

  it("preserves a retryable rollout-source outage", async () => {
    const investigation = await certificateBackedInvestigation();
    const outage = new ReviewActionV2RouteFailure(
      503,
      ReviewActionV2ProtocolErrorCode.CapabilityDisabled,
      ["investigation_rollout_unavailable"],
    );
    const adapter = new ReviewInvestigationCertificateVerificationAdapter(
      storeWith(investigation),
      new NodeSha256InvestigationDigest(),
      { assertAllowed: async () => Promise.reject(outage) },
    );

    await expect(
      adapter.verifyAcceptedCertificate(
        query(
          investigation.certificate!.certificateHash,
          investigation.certificate!.terminalOutcomeHash,
        ),
      ),
    ).rejects.toBe(outage);
  });

  it("rejects a certificate produced outside the authorized provider lane", async () => {
    const investigation = await certificateBackedInvestigation();
    const adapter = new ReviewInvestigationCertificateVerificationAdapter(
      storeWith(investigation),
      new NodeSha256InvestigationDigest(),
      allowingRollout,
    );

    await expect(
      adapter.verifyAcceptedCertificate({
        ...query(
          investigation.certificate!.certificateHash,
          investigation.certificate!.terminalOutcomeHash,
        ),
        providerKind: ReviewProviderKind.ClaudeCode,
      }),
    ).resolves.toMatchObject({
      status: InvestigationCertificateVerificationStatus.Denied,
      reason: InvestigationCertificateVerificationDenialReason.NotAccepted,
    });
  });

  it("accepts an independent critic without changing the discovery provider lane", async () => {
    const investigation = await certificateBackedInvestigation();
    expect(
      investigation.turnProvenance.map((turn) => turn.actualProviderKind),
    ).toEqual([
      InvestigationTurnProviderKind.Codex,
      InvestigationTurnProviderKind.ClaudeCode,
    ]);
    const adapter = new ReviewInvestigationCertificateVerificationAdapter(
      storeWith(investigation),
      new NodeSha256InvestigationDigest(),
      allowingRollout,
    );

    await expect(
      adapter.verifyAcceptedCertificate(
        query(
          investigation.certificate!.certificateHash,
          investigation.certificate!.terminalOutcomeHash,
        ),
      ),
    ).resolves.toMatchObject({
      status: InvestigationCertificateVerificationStatus.Accepted,
    });
  });

  it("accepts a fully replayed certificate with no terminal discovery provider", async () => {
    const investigation = await fullyReplayedCertificateBackedInvestigation();
    expect(investigation.turnProvenance.map((turn) => turn.purpose)).toEqual([
      ReviewInvestigationTurnPurpose.Critic,
    ]);
    expect(investigation.certificate).toMatchObject({
      terminalProviderKind: null,
      terminalActualModel: null,
    });
    const adapter = new ReviewInvestigationCertificateVerificationAdapter(
      storeWith(investigation),
      new NodeSha256InvestigationDigest(),
      allowingRollout,
    );

    await expect(
      adapter.verifyAcceptedCertificate(
        query(
          investigation.certificate!.certificateHash,
          investigation.certificate!.terminalOutcomeHash,
        ),
      ),
    ).resolves.toMatchObject({
      status: InvestigationCertificateVerificationStatus.Accepted,
      reason: InvestigationCertificateVerificationDenialReason.None,
    });
  });

  it("rejects a fully replayed certificate for a different observation vote lane", async () => {
    const investigation = await fullyReplayedCertificateBackedInvestigation();
    const adapter = new ReviewInvestigationCertificateVerificationAdapter(
      storeWith(investigation),
      new NodeSha256InvestigationDigest(),
      allowingRollout,
    );

    await expect(
      adapter.verifyAcceptedCertificate({
        ...query(
          investigation.certificate!.certificateHash,
          investigation.certificate!.terminalOutcomeHash,
        ),
        providerVoteIdentityHash: h("6"),
      }),
    ).resolves.toMatchObject({
      status: InvestigationCertificateVerificationStatus.Denied,
      reason: InvestigationCertificateVerificationDenialReason.VoteLaneMismatch,
    });
  });

  it("rejects a rehashed discovery certificate that erases terminal provenance", async () => {
    const investigation = await certificateBackedInvestigation();
    const digest = new NodeSha256InvestigationDigest();
    const { certificateHash, ...candidate } = investigation.certificate!;
    void certificateHash;
    const tamperedCandidate = {
      ...candidate,
      terminalProviderKind: null,
      terminalActualModel: null,
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
      allowingRollout,
    );

    await expect(
      adapter.verifyAcceptedCertificate(
        query(certificate.certificateHash, certificate.terminalOutcomeHash),
      ),
    ).resolves.toMatchObject({
      status: InvestigationCertificateVerificationStatus.Denied,
      reason: InvestigationCertificateVerificationDenialReason.NotAccepted,
    });
  });
});

const allowingRollout = {
  async assertAllowed() {},
};

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
    providerKind: ReviewProviderKind.Codex,
    providerVoteIdentityHash: h("5"),
    terminalOutcomeHash,
    expectedConclusion: InvestigationCertificateConclusion.VerifiedClean,
    producerReleaseId: "release-1",
    nowMs: Date.parse("2026-08-02T10:00:00.000Z"),
  } as const;
}

async function certificateBackedInvestigation(): Promise<ReviewInvestigation> {
  const digest = new NodeSha256InvestigationDigest();
  const terminalObservationCanonicalJson = JSON.stringify({
    payloadVersion: 2,
  });
  const turnProvenance = [
    {
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
    },
    {
      turnId: "turn-critic",
      purpose: ReviewInvestigationTurnPurpose.Critic,
      actualProviderKind: InvestigationTurnProviderKind.ClaudeCode,
      actualModel: "claude-test",
      runtimeProfile: ReviewInvestigationRuntimeProfile.GatewayAttestedAgentV1,
      inputTokens: 8,
      cachedInputTokens: 0,
      outputTokens: 4,
      reasoningOutputTokens: 0,
      totalTokens: 12,
      durationMs: 80,
      acceptedAttestationId: "attestation-critic",
      acceptedAttestationHash: h("2"),
      terminalOutcomeHash: h("3"),
    },
  ] as const;
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
    contextAttestationSetHash: await digest.digestUtf8(
      canonicalContextAttestationSet(turnProvenance),
    ),
    turnProvenanceHash: await digest.digestUtf8(
      canonicalTurnProvenanceSet(turnProvenance),
    ),
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
    turnProvenance,
    certificate,
  } as unknown as ReviewInvestigation;
}

async function fullyReplayedCertificateBackedInvestigation(): Promise<ReviewInvestigation> {
  const investigation = await certificateBackedInvestigation();
  const digest = new NodeSha256InvestigationDigest();
  const turnProvenance = investigation.turnProvenance.filter(
    (turn) => turn.purpose === ReviewInvestigationTurnPurpose.Critic,
  );
  const { certificateHash, ...candidate } = investigation.certificate!;
  void certificateHash;
  const replayedCandidate = {
    ...candidate,
    contextAttestationSetHash: await digest.digestUtf8(
      canonicalContextAttestationSet(turnProvenance),
    ),
    turnProvenanceHash: await digest.digestUtf8(
      canonicalTurnProvenanceSet(turnProvenance),
    ),
    terminalProviderKind: null,
    terminalActualModel: null,
  };
  return {
    ...investigation,
    turnProvenance,
    certificate: {
      ...replayedCandidate,
      certificateHash: await digest.digestUtf8(
        canonicalInvestigationCertificateCandidate(replayedCandidate),
      ),
    },
  };
}

function storeWith(investigation: ReviewInvestigation): InvestigationStorePort {
  return {
    findByCertificateId: async () => investigation,
  } as unknown as InvestigationStorePort;
}
