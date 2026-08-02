import { describe, expect, it, vi } from "vitest";
import {
  CommitAttestedInvestigationTurn,
  CommitInvestigationTurn,
  ContextCriticDecision,
  InvestigationObligationKind,
  InvestigationReceiptKind,
  InvestigationTurnProviderKind,
  OpenReviewInvestigation,
  PlanNextInvestigationTurn,
  ReviewInvestigationRuntimeProfile,
  ReviewInvestigationState,
  ReviewInvestigationTurnPurpose,
  canonicalInvestigationTerminalObservation,
  canonicalInvestigationTurnObservation,
  parseInvestigationTurnObservation,
  type InvestigationTurnEvidencePort,
  type InvestigationTurnObservation,
} from "../index";
import { InMemoryInvestigationStore } from "../infrastructure/memory/in-memory-investigation-store";
import { NodeSha256InvestigationDigest } from "../infrastructure/node/node-sha256-digest";
import {
  CurrentInvestigationExecutionAuthority,
  FixedInvestigationClock,
} from "../testing";

const hash = (character: string) => character.repeat(64);

describe("CommitAttestedInvestigationTurn", () => {
  it("binds an accepted gateway attestation and operation receipt", async () => {
    const fixture = await createFixture();
    const observation = observationFixture({
      turnId: fixture.turnId,
      dossierVersion: fixture.planned.version,
      obligationId: fixture.obligationId,
      operationReceiptId: hash("9"),
    });
    const terminalOutcomeHash = await fixture.digest.digestUtf8(
      canonicalInvestigationTerminalObservation(observation),
    );
    fixture.evidence.verify.mockResolvedValue(
      Object.freeze({
        acceptedAttestationId: "attestation-1",
        acceptedAttestationHash: hash("8"),
        terminalOutcomeHash,
        gatewayPolicyVersion: "context-gateway-v4",
        operations: Object.freeze([
          Object.freeze({
            operationReceiptId: hash("9"),
            operationKey: hash("7"),
            kind: InvestigationReceiptKind.Tree,
            evidenceDigest: hash("6"),
          }),
        ]),
      }),
    );

    const result = await fixture.commit.execute({
      commandId: "commit-attested-1",
      investigationId: fixture.planned.investigationId,
      expectedVersion: fixture.planned.version,
      turnId: fixture.turnId,
      sourceAttemptId: "attempt-1",
      sourceLeaseId: "lease-1",
      sourceFencingToken: "1",
      acceptedAttestationId: "attestation-1",
      acceptedAttestationHash: hash("8"),
      turnObservationHash: await fixture.digest.digestUtf8(
        canonicalInvestigationTurnObservation(observation),
      ),
      observation,
    });

    expect(result.state).toBe(ReviewInvestigationState.AwaitingCritic);
    expect(result.satisfiedObligationCount).toBe(1);
    const acceptedReceipt = (
      await fixture.store.findById(fixture.planned.investigationId)
    )?.obligations.find(
      (item) => item.obligationId === fixture.obligationId,
    )?.receipt;
    expect(acceptedReceipt).toMatchObject({
      operationReceiptIds: [hash("9")],
      acceptedAttestationId: "attestation-1",
      acceptedAttestationHash: hash("8"),
    });
    expect(fixture.evidence.verify).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceExecutionId: "execution-1",
        sourceWorkSlotId: "work-slot-1",
        terminalOutcomeHash,
      }),
    );
  });

  it("fails closed when attestation evidence is unavailable", async () => {
    const fixture = await createFixture();
    const observation = observationFixture({
      turnId: fixture.turnId,
      dossierVersion: fixture.planned.version,
      obligationId: fixture.obligationId,
      operationReceiptId: hash("9"),
    });
    fixture.evidence.verify.mockResolvedValue(null);

    await expect(
      fixture.commit.execute({
        commandId: "commit-attested-denied",
        investigationId: fixture.planned.investigationId,
        expectedVersion: fixture.planned.version,
        turnId: fixture.turnId,
        sourceAttemptId: "attempt-1",
        sourceLeaseId: "lease-1",
        sourceFencingToken: "1",
        acceptedAttestationId: "attestation-1",
        acceptedAttestationHash: hash("8"),
        turnObservationHash: await fixture.digest.digestUtf8(
          canonicalInvestigationTurnObservation(observation),
        ),
        observation,
      }),
    ).rejects.toThrow("investigation_turn_attestation_invalid");
    expect(
      (await fixture.store.findById(fixture.planned.investigationId))?.version,
    ).toBe(fixture.planned.version);
  });

  it("rejects non-canonical or incomplete observation shapes", () => {
    expect(() =>
      parseInvestigationTurnObservation({
        ...observationFixture({
          turnId: "turn-1",
          dossierVersion: 2,
          obligationId: hash("5"),
          operationReceiptId: hash("9"),
        }),
        schemaComplete: false,
      }),
    ).toThrow("investigation_turn_observation_incomplete");
  });
});

async function createFixture() {
  const store = new InMemoryInvestigationStore();
  const authority = new CurrentInvestigationExecutionAuthority();
  const clock = new FixedInvestigationClock(
    new Date("2026-08-02T10:00:00.000Z"),
  );
  const digest = new NodeSha256InvestigationDigest();
  const opened = await new OpenReviewInvestigation(
    store,
    authority,
    digest,
    clock,
  ).execute({
    commandId: "open-attested-1",
    scope: {
      workspaceId: "workspace-1",
      repositoryConnectionId: "repository-1",
      scmRepositoryIdentityId: "identity-1",
      pullRequestNumber: 1,
      trustDomain: "trusted_managed",
      authorizationScopeHash: hash("9"),
    },
    revision: {
      baseSha: "1".repeat(40),
      mergeBaseSha: "2".repeat(40),
      headSha: "3".repeat(40),
      reviewRevisionHash: hash("4"),
    },
    executionId: "execution-1",
    workSlotId: "work-slot-1",
    stableReviewUnitKey: "review-unit-1",
    providerVoteLaneId: "provider-lane-1",
    providerStrategyId: "codex-primary",
    runtimeProfile: ReviewInvestigationRuntimeProfile.GatewayAttestedAgentV1,
    contract: {
      coverageContractVersion: "coverage-v1",
      expansionRulesVersion: "expansion-v1",
      criticPolicyVersion: "critic-v1",
      gatewayPolicyVersion: "context-gateway-v4",
      producerReleaseId: "release-1",
      runtimeProfileVersion: "runtime-v1",
    },
    policy: {
      policyId: "policy-1",
      maxObligations: 32,
      maxExpansionDepth: 4,
      maxSemanticTurns: 8,
      maxOperationalAttempts: 4,
      maxCriticCycles: 2,
      maxFindings: 32,
      maxProposalsPerTurn: 16,
      maxReceiptsPerTurn: 32,
    },
    seedObligations: [
      {
        kind: InvestigationObligationKind.InventoryWitness,
        canonicalSubject: "changed-inventory",
        canonicalRequirement: "capture-complete-inventory",
        riskPriority: 100,
      },
    ],
    initialReceipts: [],
  });
  const planned = await new PlanNextInvestigationTurn(
    store,
    authority,
    digest,
    clock,
  ).execute({
    commandId: "plan-attested-1",
    investigationId: opened.investigationId,
    expectedVersion: opened.version,
    leaseDurationMs: 300_000,
    maxObligationsForTurn: 8,
  });
  const aggregate = await store.findById(opened.investigationId);
  const obligationId = aggregate!.obligations[0]!.obligationId;
  const evidence = {
    verify: vi.fn<InvestigationTurnEvidencePort["verify"]>(),
  };
  const baseCommit = new CommitInvestigationTurn(
    store,
    authority,
    digest,
    clock,
  );
  return {
    store,
    digest,
    evidence,
    planned,
    obligationId,
    turnId: planned.turn!.turnId,
    commit: new CommitAttestedInvestigationTurn(
      store,
      evidence,
      digest,
      baseCommit,
    ),
  };
}

function observationFixture(input: {
  turnId: string;
  dossierVersion: number;
  obligationId: string;
  operationReceiptId: string;
}): InvestigationTurnObservation {
  return Object.freeze({
    outputVersion: 1,
    findings: Object.freeze([]),
    obligationProposals: Object.freeze([]),
    closureClaims: Object.freeze([
      Object.freeze({
        obligationId: input.obligationId,
        operationReceiptIds: Object.freeze([input.operationReceiptId]),
      }),
    ]),
    unresolvableClaims: Object.freeze([]),
    criticDecision: null as ContextCriticDecision | null,
    observationVersion: 1,
    invocationId: "investigation-1:turn-1:attempt-1",
    turnId: input.turnId,
    dossierVersion: input.dossierVersion,
    purpose: ReviewInvestigationTurnPurpose.Discovery,
    actualProviderKind: InvestigationTurnProviderKind.Codex,
    actualModel: "gpt-5.6-sol",
    runtimeProfile: ReviewInvestigationRuntimeProfile.GatewayAttestedAgentV1,
    usage: Object.freeze({
      inputTokens: 100,
      cachedInputTokens: 50,
      outputTokens: 10,
      reasoningOutputTokens: 5,
      totalTokens: 115,
    }),
    durationMs: 1_000,
    schemaComplete: true,
    streamComplete: true,
    contextAttestationReference: "attestation-1",
  });
}
