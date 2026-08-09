import { describe, expect, it, vi } from "vitest";
import {
  AbortInvestigationTurn,
  AcquireInvestigationLease,
  CommitInvestigationTurn,
  ConcludeReviewInvestigation,
  ContextCriticDecision,
  enforceCriticPolicyForConclusion,
  InvestigationFindingSeverity,
  InvestigationEvidenceRequirementKind,
  InvestigationExecutionAuthorityVerdict,
  InvestigationPolicyCanonicalVersion,
  policyCanonicalValue,
  InvestigationLeaseAcquireStatus,
  InvestigationStoreTransitionKind,
  InvestigationObligationKind,
  InvestigationObligationState,
  InvestigationOperationRevision,
  InvestigationReceiptReplayVerdict,
  InvestigationReceiptKind,
  InvestigationTurnProviderKind,
  investigationDossierCanonicalValue,
  canonicalJson,
  canonicalTurnProvenanceSet,
  canonicalInvestigationEvidenceRequirement,
  canonicalRelationObligationSubjectV2,
  independentCriticRiskPriorityV1,
  OpenReviewInvestigation,
  PlanNextInvestigationTurn,
  PrepareReviewInvestigationReplay,
  PrepareReviewInvestigationReplayStatus,
  ReplayReviewInvestigation,
  ReconcileExpiredActiveTurn,
  RestoreReviewInvestigation,
  ReviewInvestigationAbortReason,
  ReviewInvestigationConclusion,
  ReviewInvestigationNextActionKind,
  ReviewInvestigationRuntimeProfile,
  ReviewInvestigationState,
  ReviewInvestigationTurnPurpose,
  TurnResultAdmissionKind,
  TurnResultAuthority,
  decideTurnResultAdmission,
  reviewInvestigationCriticPolicyV1,
  obligationEvidenceRequirementVersionV2,
  serializeReviewInvestigation,
  summarizeTerminalDiscoveryProvenance,
  type CommitInvestigationTurnCommand,
  type OpenReviewInvestigationCommand,
  type ReviewInvestigationPolicy,
} from "../index";
import { InMemoryInvestigationStore } from "../infrastructure/memory/in-memory-investigation-store";
import { NodeSha256InvestigationDigest } from "../infrastructure/node/node-sha256-digest";
import {
  CurrentInvestigationExecutionAuthority,
  FixedInvestigationClock,
  digestBackedInvestigationManifestIdentity,
} from "../testing";

const revisionHash = "a".repeat(64);
const inventorySubject = "inventory:canonical";
const changedSubject = "src/service.ts@head";

describe("review investigation in-memory vertical slice", () => {
  it("normalizes manifest identity adapter failures at the application boundary", async () => {
    const harness = createHarness();
    const open = new OpenReviewInvestigation(
      harness.store,
      harness.authority,
      harness.digest,
      {
        computeManifestKey: async () => {
          throw new Error("provider-specific identity failure");
        },
      },
      harness.clock,
    );

    await expect(open.execute(openCommand("identity-failure"))).rejects.toThrow(
      "investigation_manifest_identity_failed",
    );
  });

  it("normalizes manifest identity failures while acquiring a lease", async () => {
    const harness = createHarness();
    const command = openCommand("lease-identity-open");
    const opened = await harness.open.execute(command);
    const planned = await harness.plan.execute({
      commandId: "lease-identity-plan",
      investigationId: opened.investigationId,
      expectedVersion: opened.version,
      leaseDurationMs: 60_000,
      maxObligationsForTurn: 10,
    });
    const acquire = new AcquireInvestigationLease(
      harness.store,
      harness.store,
      harness.authority,
      harness.digest,
      {
        computeManifestKey: async () => {
          throw new Error("provider-specific identity failure");
        },
      },
      harness.clock,
    );

    await expect(
      acquire.execute({
        investigationId: opened.investigationId,
        expectedVersion: planned.version,
        turnId: planned.turn!.turnId,
        authorizationId: "authorization-test",
        mutationEpoch: 1n,
        providerStrategyId: command.providerStrategyId,
        investigationManifestCanonicalJson:
          command.investigationManifestCanonicalJson!,
        investigationManifestHash: command.investigationManifestHash!,
        acquireRequestId: "lease-identity-acquire",
        acquireRequestHash: "1".repeat(64),
        ownerIdHash: "2".repeat(64),
        leaseId: "lease-identity-failure",
        attemptId: "attempt-identity-failure",
        leaseCapabilityId: "capability-identity-failure",
        capabilitySigningKeyId: "signing-key-1",
        initialLeaseDurationMs: 30_000,
        retentionDurationMs: 3_600_000,
      }),
    ).rejects.toThrow("investigation_manifest_identity_failed");
  });

  it("fails closed when discovery turns report mixed terminal models", () => {
    const base = {
      turnId: "turn-1",
      purpose: ReviewInvestigationTurnPurpose.Discovery,
      actualProviderKind: InvestigationTurnProviderKind.Codex,
      actualModel: "gpt-one",
      runtimeProfile: ReviewInvestigationRuntimeProfile.GatewayAttestedAgentV1,
      inputTokens: 1,
      cachedInputTokens: 0,
      outputTokens: 1,
      reasoningOutputTokens: 0,
      totalTokens: 2,
      durationMs: 1,
      acceptedAttestationId: "attestation-1",
      acceptedAttestationHash: "b".repeat(64),
      acceptedOperationReceiptIds: [],
      terminalOutcomeHash: "c".repeat(64),
    } as const;
    expect(() =>
      summarizeTerminalDiscoveryProvenance([
        base,
        { ...base, turnId: "turn-2", actualModel: "gpt-two" },
      ]),
    ).toThrow("investigation_terminal_provenance_ambiguous");
  });

  it("preserves legacy provenance hashes while binding accepted operation receipts", () => {
    const provenance = {
      turnId: "turn-canonical-provenance",
      purpose: ReviewInvestigationTurnPurpose.Discovery,
      actualProviderKind: InvestigationTurnProviderKind.Codex,
      actualModel: "gpt-test",
      runtimeProfile: ReviewInvestigationRuntimeProfile.GatewayAttestedAgentV1,
      inputTokens: 1,
      cachedInputTokens: 0,
      outputTokens: 1,
      reasoningOutputTokens: 0,
      totalTokens: 2,
      durationMs: 1,
      acceptedAttestationId: "attestation-canonical-provenance",
      acceptedAttestationHash: "b".repeat(64),
      acceptedOperationReceiptIds: [],
      terminalOutcomeHash: "c".repeat(64),
    } as const;
    const { acceptedOperationReceiptIds, ...legacyCanonicalValue } = provenance;
    void acceptedOperationReceiptIds;

    expect(canonicalTurnProvenanceSet([provenance])).toBe(
      canonicalJson([legacyCanonicalValue]),
    );
    expect(
      canonicalTurnProvenanceSet([
        { ...provenance, acceptedOperationReceiptIds: ["d".repeat(64)] },
      ]),
    ).toBe(
      canonicalJson([
        {
          ...legacyCanonicalValue,
          acceptedOperationReceiptIds: ["d".repeat(64)],
        },
      ]),
    );
  });

  it("keeps runner inventory provisional until the first authenticated witness", async () => {
    const harness = createHarness();
    const opened = await harness.open.execute({
      ...openCommand("open-provisional"),
      initialReceipts: [],
    });
    expect(opened.state).toBe(ReviewInvestigationState.Provisional);

    const witnessTurn = await harness.plan.execute({
      commandId: "plan-inventory-witness",
      investigationId: opened.investigationId,
      expectedVersion: opened.version,
      leaseDurationMs: 60_000,
      maxObligationsForTurn: 10,
    });
    expect(witnessTurn.turn?.obligationIds).toHaveLength(1);
    const witnessed = await harness.commit.execute({
      ...emptyCommit(witnessTurn, "commit-inventory-witness"),
      closureClaims: [
        {
          obligationId: witnessTurn.turn!.obligationIds[0]!,
          receipt: receipt("receipt-provisional-inventory", inventorySubject),
        },
      ],
    });
    expect(witnessed).toMatchObject({
      state: ReviewInvestigationState.AwaitingTurn,
      openObligationCount: 1,
      satisfiedObligationCount: 1,
    });
  });

  it("reaches verified clean through discovery, critic, and an immutable certificate", async () => {
    const harness = createHarness();
    const opened = await harness.open.execute(openCommand("open-clean"));
    expect(opened).toMatchObject({
      state: ReviewInvestigationState.AwaitingTurn,
      openObligationCount: 1,
      satisfiedObligationCount: 1,
    });

    const discovery = await harness.plan.execute({
      commandId: "plan-discovery",
      investigationId: opened.investigationId,
      expectedVersion: opened.version,
      leaseDurationMs: 60_000,
      maxObligationsForTurn: 10,
    });
    const changedReceipt = receipt("receipt-changed", changedSubject);
    const discoveryCommand: CommitInvestigationTurnCommand = {
      commandId: "commit-discovery",
      investigationId: opened.investigationId,
      expectedVersion: discovery.version,
      turnId: discovery.turn!.turnId,
      closureClaims: [
        {
          obligationId: discovery.turn!.obligationIds[0]!,
          receipt: changedReceipt,
        },
      ],
      unresolvableDecisions: [],
      proposals: [],
      findings: [],
      criticDecision: null,
      usageTokens: 1_200,
      durationMs: 5_000,
      provenance: provenance(discovery, 1_200, 5_000),
    };
    const awaitingCritic = await harness.commit.execute(discoveryCommand);
    expect(awaitingCritic.state).toBe(ReviewInvestigationState.AwaitingCritic);

    const replayedCommit = await harness.commit.execute(discoveryCommand);
    expect(replayedCommit).toEqual(awaitingCritic);

    const critic = await harness.plan.execute({
      commandId: "plan-critic",
      investigationId: opened.investigationId,
      expectedVersion: awaitingCritic.version,
      leaseDurationMs: 60_000,
      maxObligationsForTurn: 10,
    });
    const ready = await harness.commit.execute({
      commandId: "commit-critic",
      investigationId: opened.investigationId,
      expectedVersion: critic.version,
      turnId: critic.turn!.turnId,
      closureClaims: [],
      unresolvableDecisions: [],
      proposals: [],
      findings: [],
      criticDecision: ContextCriticDecision.Accept,
      usageTokens: 500,
      durationMs: 2_000,
      provenance: provenance(critic, 500, 2_000),
    });
    expect(ready.state).toBe(ReviewInvestigationState.ReadyToConclude);

    const concluded = await harness.conclude.execute({
      commandId: "conclude-clean",
      investigationId: opened.investigationId,
      expectedVersion: ready.version,
      certificateTtlMs: 86_400_000,
    });
    expect(concluded.state).toBe(ReviewInvestigationState.Concluded);

    const snapshot = await harness.restore.snapshot(opened.investigationId);
    expect(snapshot.conclusion).toBe(
      ReviewInvestigationConclusion.VerifiedClean,
    );
    expect(snapshot.certificate?.certificateHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(snapshot.certificate?.dossierDigest).toBe(ready.dossierDigest);
    expect(snapshot.certificate?.terminalOutcomeHash).toMatch(
      /^[a-f0-9]{64}$/u,
    );
    expect(snapshot.certificate?.turnProvenanceHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(snapshot.certificate?.terminalProviderKind).toBe(
      InvestigationTurnProviderKind.Codex,
    );
    expect(snapshot.certificate?.terminalActualModel).toBe("gpt-test");
    expect(snapshot.certificate?.criticDecision).toBe(
      ContextCriticDecision.Accept,
    );

    const sourceBeforeReplay = await harness.store.findById(
      opened.investigationId,
    );
    const preparation = new PrepareReviewInvestigationReplay(
      harness.store,
      harness.authority,
      {
        prepare: async ({ sourceReceipt }) => ({
          contextAttestationId: sourceReceipt.acceptedAttestationId!,
          contextAttestationHash: sourceReceipt.acceptedAttestationHash!,
          sourceOperationReceiptIdsHash: "8".repeat(64),
          replayCapability: "receipt-replay-capability",
          replayPlanCanonicalJson: "{}",
          replayPlanHash: "9".repeat(64),
        }),
      },
      harness.clock,
    );
    await expect(
      preparation.execute({
        targetScope: openCommand("unused").scope,
        targetRevision: {
          baseSha: "1".repeat(40),
          mergeBaseSha: "2".repeat(40),
          headSha: "4".repeat(40),
          reviewRevisionHash: "d".repeat(64),
        },
        targetExecutionId: "execution-target-prepare",
        targetWorkSlotId: "slot-target-prepare",
        stableReviewUnitKey: sourceBeforeReplay!.stableReviewUnitKey,
        providerVoteLaneId: sourceBeforeReplay!.providerVoteLaneId,
        producerReleaseId: "producer-test",
        targetContract: sourceBeforeReplay!.contract,
      }),
    ).resolves.toMatchObject({
      status: PrepareReviewInvestigationReplayStatus.Prepared,
      sourceInvestigationId: opened.investigationId,
      sourceCheckpointHash:
        sourceBeforeReplay!.replayEvidenceCheckpoint!.checkpointHash,
      obligations: expect.arrayContaining([
        expect.objectContaining({
          replay: expect.objectContaining({
            replayCapability: "receipt-replay-capability",
          }),
        }),
      ]),
    });
    await expect(
      preparation.execute({
        targetScope: openCommand("unused").scope,
        targetRevision: {
          baseSha: "1".repeat(40),
          mergeBaseSha: "2".repeat(40),
          headSha: "4".repeat(40),
          reviewRevisionHash: "d".repeat(64),
        },
        targetExecutionId: "execution-target-prepare",
        targetWorkSlotId: "slot-target-prepare",
        stableReviewUnitKey: sourceBeforeReplay!.stableReviewUnitKey,
        providerVoteLaneId: sourceBeforeReplay!.providerVoteLaneId,
        producerReleaseId: "producer-test",
        targetContract: {
          ...sourceBeforeReplay!.contract,
          criticPolicyVersion: "review-investigation-critic.v2",
        },
      }),
    ).resolves.toMatchObject({
      status: PrepareReviewInvestigationReplayStatus.Missing,
    });
    const unsafePreparation = new PrepareReviewInvestigationReplay(
      {
        findReplayCandidates: async () => [
          {
            ...sourceBeforeReplay!,
            state: ReviewInvestigationState.Inconclusive,
            conclusion: ReviewInvestigationConclusion.Inconclusive,
            certificate: {
              ...sourceBeforeReplay!.certificate!,
              conclusion: ReviewInvestigationConclusion.Inconclusive,
            },
          },
          {
            ...sourceBeforeReplay!,
            conclusion: ReviewInvestigationConclusion.Findings,
            findings: [{} as never],
            certificate: {
              ...sourceBeforeReplay!.certificate!,
              conclusion: ReviewInvestigationConclusion.Findings,
            },
          },
        ],
      } as never,
      harness.authority,
      { prepare: async () => ({}) as never },
      harness.clock,
    );
    await expect(
      unsafePreparation.execute({
        targetScope: openCommand("unused").scope,
        targetRevision: {
          baseSha: "1".repeat(40),
          mergeBaseSha: "2".repeat(40),
          headSha: "4".repeat(40),
          reviewRevisionHash: "d".repeat(64),
        },
        targetExecutionId: "execution-target-unsafe",
        targetWorkSlotId: "slot-target-unsafe",
        stableReviewUnitKey: sourceBeforeReplay!.stableReviewUnitKey,
        providerVoteLaneId: sourceBeforeReplay!.providerVoteLaneId,
        producerReleaseId: "producer-test",
        targetContract: sourceBeforeReplay!.contract,
      }),
    ).resolves.toMatchObject({
      status: PrepareReviewInvestigationReplayStatus.Missing,
    });
    const replay = new ReplayReviewInvestigation(
      harness.store,
      harness.authority,
      {
        replay: async ({
          obligation,
          sourceReceipt,
          targetRevision,
          replayProofId,
        }) =>
          obligation.canonicalSubject === inventorySubject
            ? {
                verdict: InvestigationReceiptReplayVerdict.Matched,
                targetReceipt: {
                  ...sourceReceipt,
                  receiptId: `replay-${sourceReceipt.receiptId}`,
                  reviewRevisionHash: targetRevision.reviewRevisionHash,
                  replayProofId,
                },
              }
            : {
                verdict: InvestigationReceiptReplayVerdict.Mismatched,
                targetReceipt: null,
              },
      },
      harness.digest,
      digestBackedInvestigationManifestIdentity(harness.digest),
      harness.clock,
    );
    const targetRevision = {
      baseSha: "1".repeat(40),
      mergeBaseSha: "2".repeat(40),
      headSha: "4".repeat(40),
      reviewRevisionHash: "d".repeat(64),
    };
    const targetOpen = openCommand("unused-target");
    const targetOnlySubject = "tests/service.test.ts@head";
    const replayed = await replay.execute({
      commandId: "replay-selective",
      sourceInvestigationId: opened.investigationId,
      sourceCheckpointHash:
        sourceBeforeReplay!.replayEvidenceCheckpoint!.checkpointHash,
      targetScope: openCommand("unused").scope,
      targetRevision,
      targetExecutionId: "execution-target",
      targetWorkSlotId: "slot-target",
      targetStableReviewUnitKey: targetOpen.stableReviewUnitKey,
      targetProviderVoteLaneId: targetOpen.providerVoteLaneId,
      targetProviderStrategyId: "strategy-target",
      targetInvestigationManifestCanonicalJson:
        targetOpen.investigationManifestCanonicalJson!,
      targetInvestigationManifestHash: targetOpen.investigationManifestHash!,
      targetRuntimeProfile: targetOpen.runtimeProfile,
      targetContract: targetOpen.contract,
      targetPolicy: targetOpen.policy,
      targetSeedObligations: [
        targetOpen.seedObligations[0]!,
        {
          kind: InvestigationObligationKind.TestEvidence,
          canonicalSubject: targetOnlySubject,
          canonicalRequirement: "read complete target test evidence",
          riskPriority: 70,
        },
      ],
      targetInitialReceipts: [],
      replayProofs: sourceBeforeReplay!.obligations.map((obligation) => ({
        obligationId: obligation.obligationId,
        replayProofId: `proof-${obligation.obligationId}`,
      })),
    });
    expect(replayed).toMatchObject({
      state: ReviewInvestigationState.AwaitingTurn,
      openObligationCount: 1,
      satisfiedObligationCount: 1,
    });
    expect(
      (await harness.store.findById(replayed.investigationId))
        ?.totalUsageTokens,
    ).toBe(0);
    const replayedTarget = await harness.store.findById(
      replayed.investigationId,
    );
    expect(replayedTarget).toMatchObject({
      investigationManifestCanonicalJson:
        targetOpen.investigationManifestCanonicalJson!,
      investigationManifestHash: targetOpen.investigationManifestHash!,
    });
    expect(
      replayedTarget?.obligations.map((item) => item.canonicalSubject),
    ).toEqual(expect.arrayContaining([inventorySubject, targetOnlySubject]));
    expect(
      replayedTarget?.obligations.some(
        (item) => item.canonicalSubject === changedSubject,
      ),
    ).toBe(false);
    const replayedPlan = await harness.plan.execute({
      commandId: "plan-selective-replay",
      investigationId: replayed.investigationId,
      expectedVersion: replayed.version,
      leaseDurationMs: 60_000,
      maxObligationsForTurn: 10,
    });
    const acquiredReplayLease = await new AcquireInvestigationLease(
      harness.store,
      harness.store,
      harness.authority,
      harness.digest,
      digestBackedInvestigationManifestIdentity(harness.digest),
      harness.clock,
    ).execute({
      investigationId: replayed.investigationId,
      expectedVersion: replayedPlan.version,
      turnId: replayedPlan.turn!.turnId,
      authorizationId: "authorization-target",
      mutationEpoch: 1n,
      providerStrategyId: "strategy-target",
      investigationManifestCanonicalJson:
        targetOpen.investigationManifestCanonicalJson!,
      investigationManifestHash: targetOpen.investigationManifestHash!,
      acquireRequestId: "acquire-selective-replay",
      acquireRequestHash: "1".repeat(64),
      ownerIdHash: "2".repeat(64),
      leaseId: "lease-selective-replay",
      attemptId: "attempt-selective-replay",
      leaseCapabilityId: "capability-selective-replay",
      capabilitySigningKeyId: "signing-key-1",
      initialLeaseDurationMs: 30_000,
      retentionDurationMs: 3_600_000,
    });
    expect(acquiredReplayLease.status).toBe(
      InvestigationLeaseAcquireStatus.Acquired,
    );
    expect(await harness.store.findById(opened.investigationId)).toEqual(
      sourceBeforeReplay,
    );

    const replayedSubjects: string[] = [];
    const replayAll = new ReplayReviewInvestigation(
      harness.store,
      harness.authority,
      {
        replay: async ({
          obligation,
          sourceReceipt,
          targetRevision,
          replayProofId,
        }) => {
          replayedSubjects.push(obligation.canonicalSubject);
          return {
            verdict: InvestigationReceiptReplayVerdict.Matched,
            targetReceipt: {
              ...sourceReceipt,
              receiptId: `replay-all-${sourceReceipt.receiptId}`,
              reviewRevisionHash: targetRevision.reviewRevisionHash,
              replayProofId,
            },
          };
        },
      },
      harness.digest,
      digestBackedInvestigationManifestIdentity(harness.digest),
      harness.clock,
    );
    const fullyReplayed = await replayAll.execute({
      commandId: "replay-all",
      sourceInvestigationId: opened.investigationId,
      sourceCheckpointHash:
        sourceBeforeReplay!.replayEvidenceCheckpoint!.checkpointHash,
      targetScope: openCommand("unused").scope,
      targetRevision: {
        ...targetRevision,
        headSha: "5".repeat(40),
        reviewRevisionHash: "9".repeat(64),
      },
      targetExecutionId: "execution-target-all",
      targetWorkSlotId: "slot-target-all",
      targetStableReviewUnitKey: targetOpen.stableReviewUnitKey,
      targetProviderVoteLaneId: targetOpen.providerVoteLaneId,
      targetProviderStrategyId: "strategy-target-all",
      targetInvestigationManifestCanonicalJson:
        targetOpen.investigationManifestCanonicalJson!,
      targetInvestigationManifestHash: targetOpen.investigationManifestHash!,
      targetRuntimeProfile: targetOpen.runtimeProfile,
      targetContract: targetOpen.contract,
      targetPolicy: targetOpen.policy,
      targetSeedObligations: targetOpen.seedObligations,
      targetInitialReceipts: [
        {
          ...receipt("target-current-inventory", inventorySubject),
          reviewRevisionHash: "9".repeat(64),
        },
      ],
      replayProofs: sourceBeforeReplay!.obligations.map((obligation) => ({
        obligationId: obligation.obligationId,
        replayProofId: `proof-all-${obligation.obligationId}`,
      })),
    });
    expect(fullyReplayed).toMatchObject({
      state: ReviewInvestigationState.AwaitingTurn,
      openObligationCount: 0,
      satisfiedObligationCount: 2,
    });
    expect(replayedSubjects).toEqual([changedSubject]);
    const provenanceTurn = await harness.plan.execute({
      commandId: "plan-replay-provenance",
      investigationId: fullyReplayed.investigationId,
      expectedVersion: fullyReplayed.version,
      leaseDurationMs: 60_000,
      maxObligationsForTurn: 10,
    });
    expect(provenanceTurn.turn).toMatchObject({
      purpose: ReviewInvestigationTurnPurpose.Discovery,
      obligationIds: [],
    });
    await expect(
      harness.commit.execute(
        emptyCommit(provenanceTurn, "commit-replay-provenance"),
      ),
    ).resolves.toMatchObject({
      state: ReviewInvestigationState.AwaitingCritic,
      semanticTurns: 1,
    });
  });

  it("turns same-provider high-risk critic accepts into bounded abstain", async () => {
    const harness = createHarness();
    const opened = await harness.open.execute(
      criticPolicyV1OpenCommand(
        "open-high-risk-same-provider",
        independentCriticRiskPriorityV1,
      ),
    );
    const discovery = await planDiscovery(harness, opened);
    const awaitingCritic = await harness.commit.execute({
      ...emptyCommit(discovery, "commit-high-risk-discovery"),
      closureClaims: [
        {
          obligationId: discovery.turn!.obligationIds[0]!,
          receipt: receipt("receipt-high-risk", changedSubject),
        },
      ],
    });

    const firstCritic = await harness.plan.execute({
      commandId: "plan-high-risk-critic-1",
      investigationId: opened.investigationId,
      expectedVersion: awaitingCritic.version,
      leaseDurationMs: 60_000,
      maxObligationsForTurn: 10,
    });
    const retry = await harness.commit.execute({
      ...emptyCommit(firstCritic, "commit-high-risk-critic-1"),
      criticDecision: ContextCriticDecision.Accept,
    });
    expect(retry).toMatchObject({
      state: ReviewInvestigationState.AwaitingCritic,
      criticCycles: 1,
    });
    const persisted = await harness.store.findById(opened.investigationId);
    expect(persisted?.criticDecision).toBe(ContextCriticDecision.Abstain);
    expect(
      enforceCriticPolicyForConclusion({
        ...persisted!,
        state: ReviewInvestigationState.ReadyToConclude,
        criticDecision: ContextCriticDecision.Accept,
      }).state,
    ).toBe(ReviewInvestigationState.Inconclusive);

    const secondCritic = await harness.plan.execute({
      commandId: "plan-high-risk-critic-2",
      investigationId: opened.investigationId,
      expectedVersion: retry.version,
      leaseDurationMs: 60_000,
      maxObligationsForTurn: 10,
    });
    const inconclusive = await harness.commit.execute({
      ...emptyCommit(secondCritic, "commit-high-risk-critic-2"),
      criticDecision: ContextCriticDecision.Accept,
    });
    expect(inconclusive).toMatchObject({
      state: ReviewInvestigationState.Inconclusive,
      criticCycles: policy.maxCriticCycles,
      nextAction: ReviewInvestigationNextActionKind.Conclude,
    });
  });

  it("accepts an independent provider for high risk and same provider for normal risk", async () => {
    for (const fixture of [
      {
        id: "high-independent",
        semanticRisk: independentCriticRiskPriorityV1,
        criticProvider: InvestigationTurnProviderKind.ClaudeCode,
      },
      {
        id: "normal-same-provider",
        semanticRisk: independentCriticRiskPriorityV1 - 1,
        criticProvider: InvestigationTurnProviderKind.Codex,
      },
    ] as const) {
      const harness = createHarness();
      const opened = await harness.open.execute(
        criticPolicyV1OpenCommand(fixture.id, fixture.semanticRisk),
      );
      const discovery = await planDiscovery(harness, opened);
      const awaitingCritic = await harness.commit.execute({
        ...emptyCommit(discovery, `commit-${fixture.id}-discovery`),
        closureClaims: [
          {
            obligationId: discovery.turn!.obligationIds[0]!,
            receipt: receipt(`receipt-${fixture.id}`, changedSubject),
          },
        ],
      });
      const critic = await harness.plan.execute({
        commandId: `plan-${fixture.id}-critic`,
        investigationId: opened.investigationId,
        expectedVersion: awaitingCritic.version,
        leaseDurationMs: 60_000,
        maxObligationsForTurn: 10,
      });
      const ready = await harness.commit.execute({
        ...emptyCommit(critic, `commit-${fixture.id}-critic`),
        criticDecision: ContextCriticDecision.Accept,
        provenance: provenance(critic, 100, 100, fixture.criticProvider),
      });
      expect(ready.state).toBe(ReviewInvestigationState.ReadyToConclude);
    }
  });

  it("does not reuse an earlier critic provenance for a later accept", async () => {
    const harness = createHarness();
    const opened = await harness.open.execute(
      criticPolicyV1OpenCommand(
        "open-stale-critic-provenance",
        independentCriticRiskPriorityV1,
      ),
    );
    const discovery = await planDiscovery(harness, opened);
    const awaitingCritic = await harness.commit.execute({
      ...emptyCommit(discovery, "commit-stale-provenance-discovery"),
      closureClaims: [
        {
          obligationId: discovery.turn!.obligationIds[0]!,
          receipt: receipt("receipt-stale-provenance", changedSubject),
        },
      ],
    });
    const firstCritic = await harness.plan.execute({
      commandId: "plan-stale-provenance-critic-1",
      investigationId: opened.investigationId,
      expectedVersion: awaitingCritic.version,
      leaseDurationMs: 60_000,
      maxObligationsForTurn: 10,
    });
    const retry = await harness.commit.execute({
      ...emptyCommit(firstCritic, "commit-stale-provenance-critic-1"),
      criticDecision: ContextCriticDecision.Abstain,
      provenance: provenance(
        firstCritic,
        100,
        100,
        InvestigationTurnProviderKind.ClaudeCode,
      ),
    });
    const secondCritic = await harness.plan.execute({
      commandId: "plan-stale-provenance-critic-2",
      investigationId: opened.investigationId,
      expectedVersion: retry.version,
      leaseDurationMs: 60_000,
      maxObligationsForTurn: 10,
    });
    const result = await harness.commit.execute({
      ...emptyCommit(secondCritic, "commit-stale-provenance-critic-2"),
      criticDecision: ContextCriticDecision.Accept,
      provenance: null,
    });
    expect(result.state).toBe(ReviewInvestigationState.Inconclusive);
  });

  it("rejects a contradictory critic accept that proposes more work", async () => {
    const harness = createHarness();
    const opened = await harness.open.execute(
      openCommand("open-critic-conflict"),
    );
    const discovery = await planDiscovery(harness, opened);
    const awaitingCritic = await harness.commit.execute({
      ...emptyCommit(discovery, "commit-before-critic-conflict"),
      closureClaims: [
        {
          obligationId: discovery.turn!.obligationIds[0]!,
          receipt: receipt("receipt-before-critic-conflict", changedSubject),
        },
      ],
    });
    const critic = await harness.plan.execute({
      commandId: "plan-critic-conflict",
      investigationId: opened.investigationId,
      expectedVersion: awaitingCritic.version,
      leaseDurationMs: 60_000,
      maxObligationsForTurn: 10,
    });
    await expect(
      harness.commit.execute({
        ...emptyCommit(critic, "commit-critic-conflict"),
        criticDecision: ContextCriticDecision.Accept,
        proposals: [
          {
            kind: InvestigationObligationKind.DirectCaller,
            canonicalSubject: "src/caller.ts",
            canonicalRequirement: "inspect caller",
            riskPriority: 90,
          },
        ],
      }),
    ).rejects.toThrow("critic_output_contradictory");
  });

  it("rejects provider proposals above the investigation policy maximum", async () => {
    const constrainedPolicy = { ...policy, maxProposalsPerTurn: 1 };
    const harness = createHarness(constrainedPolicy);
    const opened = await harness.open.execute(
      openCommand("open-proposal-limit", constrainedPolicy),
    );
    const discovery = await planDiscovery(harness, opened);

    await expect(
      harness.commit.execute({
        ...emptyCommit(discovery, "commit-proposal-limit"),
        proposals: [
          {
            kind: InvestigationObligationKind.DirectCaller,
            canonicalSubject: "src/first-caller.ts",
            canonicalRequirement: "inspect first caller",
            riskPriority: 80,
          },
          {
            kind: InvestigationObligationKind.DirectCallee,
            canonicalSubject: "src/second-callee.ts",
            canonicalRequirement: "inspect second callee",
            riskPriority: 70,
          },
        ],
      }),
    ).rejects.toThrow("turn_bounds_exceeded");
    expect(
      (await harness.store.findById(opened.investigationId))?.version,
    ).toBe(discovery.version);
  });

  it("rejects obligation claims outside or duplicated within the active turn", async () => {
    const harness = createHarness();
    const opened = await harness.open.execute(
      openCommand("open-obligation-claim-scope"),
    );
    const discovery = await planDiscovery(harness, opened);
    const obligationId = discovery.turn!.obligationIds[0]!;
    const cases = [
      {
        commandId: "commit-unknown-obligation-claim",
        closureClaims: [
          {
            obligationId: "f".repeat(64),
            receipt: receipt("receipt-unknown-claim", changedSubject),
          },
        ],
        unresolvableDecisions: [],
      },
      {
        commandId: "commit-duplicate-obligation-claim",
        closureClaims: [
          {
            obligationId,
            receipt: receipt("receipt-duplicate-claim-1", changedSubject),
          },
          {
            obligationId,
            receipt: receipt("receipt-duplicate-claim-2", changedSubject),
          },
        ],
        unresolvableDecisions: [],
      },
      {
        commandId: "commit-contradictory-obligation-claim",
        closureClaims: [
          {
            obligationId,
            receipt: receipt("receipt-contradictory-claim", changedSubject),
          },
        ],
        unresolvableDecisions: [
          {
            obligationId,
            reason: "provider reported a contradiction",
            deterministicPolicy: true,
          },
        ],
      },
    ] as const;

    for (const invalid of cases) {
      await expect(
        harness.commit.execute({
          ...emptyCommit(discovery, invalid.commandId),
          closureClaims: invalid.closureClaims,
          unresolvableDecisions: invalid.unresolvableDecisions,
        }),
      ).rejects.toThrow("turn_obligation_claim_invalid");
      expect(
        (await harness.store.findById(opened.investigationId))?.version,
      ).toBe(discovery.version);
    }
  });

  it("concludes with findings only after supporting evidence closes coverage", async () => {
    const harness = createHarness();
    const opened = await harness.open.execute(openCommand("open-findings"));
    const discovery = await planDiscovery(harness, opened);
    const changedReceipt = receipt("receipt-finding", changedSubject);
    const ready = await harness.commit.execute({
      ...emptyCommit(discovery, "commit-finding"),
      closureClaims: [
        {
          obligationId: discovery.turn!.obligationIds[0]!,
          receipt: changedReceipt,
        },
      ],
      findings: [
        {
          fingerprint: "missing-cache-invalidation",
          severity: InvestigationFindingSeverity.Major,
          title: "Cache is not invalidated",
          body: "The update path leaves stale state.",
          path: "src/service.ts",
          line: 12,
          evidenceReceiptIds: [changedReceipt.receiptId],
        },
      ],
    });
    expect(ready).toMatchObject({
      state: ReviewInvestigationState.ReadyToConclude,
      findingCount: 1,
    });

    await harness.conclude.execute({
      commandId: "conclude-findings",
      investigationId: opened.investigationId,
      expectedVersion: ready.version,
      certificateTtlMs: 86_400_000,
    });
    const snapshot = await harness.restore.snapshot(opened.investigationId);
    expect(snapshot.conclusion).toBe(ReviewInvestigationConclusion.Findings);
    const source = await harness.store.findById(opened.investigationId);
    const target = openCommand("findings-target");
    const replay = new ReplayReviewInvestigation(
      harness.store,
      harness.authority,
      {
        replay: async ({ sourceReceipt, targetRevision, replayProofId }) => ({
          verdict: InvestigationReceiptReplayVerdict.Matched,
          targetReceipt: {
            ...sourceReceipt,
            receiptId: `findings-replay-${sourceReceipt.receiptId}`,
            reviewRevisionHash: targetRevision.reviewRevisionHash,
            replayProofId,
          },
        }),
      },
      harness.digest,
      digestBackedInvestigationManifestIdentity(harness.digest),
      harness.clock,
    );
    const replayed = await replay.execute({
      commandId: "replay-findings-source",
      sourceInvestigationId: source!.investigationId,
      sourceCheckpointHash: source!.replayEvidenceCheckpoint!.checkpointHash,
      targetScope: target.scope,
      targetRevision: {
        ...target.revision,
        headSha: "6".repeat(40),
        reviewRevisionHash: "6".repeat(64),
      },
      targetExecutionId: "execution-findings-target",
      targetWorkSlotId: "slot-findings-target",
      targetStableReviewUnitKey: target.stableReviewUnitKey,
      targetProviderVoteLaneId: target.providerVoteLaneId,
      targetProviderStrategyId: target.providerStrategyId,
      targetInvestigationManifestCanonicalJson:
        target.investigationManifestCanonicalJson!,
      targetInvestigationManifestHash: target.investigationManifestHash!,
      targetRuntimeProfile: target.runtimeProfile,
      targetContract: target.contract,
      targetPolicy: target.policy,
      targetSeedObligations: target.seedObligations,
      targetInitialReceipts: [],
      replayProofs: source!.obligations.map((obligation) => ({
        obligationId: obligation.obligationId,
        replayProofId: `proof-findings-${obligation.obligationId}`,
      })),
    });
    const replayedAggregate = await harness.store.findById(
      replayed.investigationId,
    );
    expect(replayedAggregate).toMatchObject({
      findings: [],
      criticDecision: null,
      certificate: null,
    });
    expect(
      replayedAggregate?.obligations.find(
        (obligation) =>
          obligation.kind === InvestigationObligationKind.FindingRevalidation,
      ),
    ).toMatchObject({ state: "open" });
  });

  it("replays committed receipts from superseded revision A into B without terminal state", async () => {
    const harness = createHarness();
    const opened = await harness.open.execute(openCommand("superseded-a"));
    const discovery = await planDiscovery(harness, opened);
    const awaitingCritic = await harness.commit.execute({
      ...emptyCommit(discovery, "commit-superseded-a"),
      closureClaims: [
        {
          obligationId: discovery.turn!.obligationIds[0]!,
          receipt: receipt("receipt-superseded-a", changedSubject),
        },
      ],
    });
    const critic = await harness.plan.execute({
      commandId: "plan-superseded-a-critic",
      investigationId: opened.investigationId,
      expectedVersion: awaitingCritic.version,
      leaseDurationMs: 60_000,
      maxObligationsForTurn: 10,
    });
    await harness.abort.execute({
      commandId: "abort-superseded-a",
      investigationId: opened.investigationId,
      expectedVersion: critic.version,
      turnId: critic.turn!.turnId,
      reason: ReviewInvestigationAbortReason.SupersededExecution,
      nextEligibleAt: null,
    });
    const source = await harness.store.findById(opened.investigationId);
    expect(source).toMatchObject({
      state: ReviewInvestigationState.Superseded,
      conclusion: null,
      certificate: null,
      replayEvidenceCheckpoint: { sourceState: "superseded" },
    });

    const target = openCommand("superseded-b");
    const replay = new ReplayReviewInvestigation(
      harness.store,
      harness.authority,
      {
        replay: async ({ sourceReceipt, targetRevision, replayProofId }) => ({
          verdict: InvestigationReceiptReplayVerdict.Matched,
          targetReceipt: {
            ...sourceReceipt,
            receiptId: `superseded-b-${sourceReceipt.receiptId}`,
            reviewRevisionHash: targetRevision.reviewRevisionHash,
            replayProofId,
          },
        }),
      },
      harness.digest,
      digestBackedInvestigationManifestIdentity(harness.digest),
      harness.clock,
    );
    const replayed = await replay.execute({
      commandId: "replay-superseded-a-to-b",
      sourceInvestigationId: source!.investigationId,
      sourceCheckpointHash: source!.replayEvidenceCheckpoint!.checkpointHash,
      targetScope: target.scope,
      targetRevision: {
        ...target.revision,
        headSha: "7".repeat(40),
        reviewRevisionHash: "7".repeat(64),
      },
      targetExecutionId: "execution-superseded-b",
      targetWorkSlotId: "slot-superseded-b",
      targetStableReviewUnitKey: target.stableReviewUnitKey,
      targetProviderVoteLaneId: target.providerVoteLaneId,
      targetProviderStrategyId: target.providerStrategyId,
      targetInvestigationManifestCanonicalJson:
        target.investigationManifestCanonicalJson!,
      targetInvestigationManifestHash: target.investigationManifestHash!,
      targetRuntimeProfile: target.runtimeProfile,
      targetContract: target.contract,
      targetPolicy: target.policy,
      targetSeedObligations: target.seedObligations,
      targetInitialReceipts: [],
      replayProofs: source!.obligations.map((obligation) => ({
        obligationId: obligation.obligationId,
        replayProofId: `proof-superseded-${obligation.obligationId}`,
      })),
    });
    expect(replayed).toMatchObject({
      state: ReviewInvestigationState.AwaitingTurn,
      findingCount: 0,
      certificateId: null,
      conclusion: null,
    });
    const targetAggregate = await harness.store.findById(
      replayed.investigationId,
    );
    expect(targetAggregate).toMatchObject({
      findings: [],
      criticDecision: null,
      certificate: null,
      replayEvidenceCheckpoint: null,
    });
  });

  it("becomes inconclusive instead of clean when semantic coverage is exhausted", async () => {
    const harness = createHarness({ ...policy, maxSemanticTurns: 1 });
    const opened = await harness.open.execute(
      openCommand("open-inconclusive", harness.policy),
    );
    const discovery = await planDiscovery(harness, opened);
    const result = await harness.commit.execute(
      emptyCommit(discovery, "commit-incomplete"),
    );

    expect(result).toMatchObject({
      state: ReviewInvestigationState.Inconclusive,
      openObligationCount: 1,
      nextAction: ReviewInvestigationNextActionKind.Conclude,
    });
    await harness.conclude.execute({
      commandId: "certify-inconclusive",
      investigationId: opened.investigationId,
      expectedVersion: result.version,
      certificateTtlMs: 86_400_000,
    });
    const snapshot = await harness.restore.snapshot(opened.investigationId);
    expect(snapshot.conclusion).toBe(
      ReviewInvestigationConclusion.Inconclusive,
    );
    expect(snapshot.certificate?.conclusion).toBe(
      ReviewInvestigationConclusion.Inconclusive,
    );
  });

  it("parks capacity failures without consuming semantic turns or tight-looping", async () => {
    const harness = createHarness();
    const opened = await harness.open.execute(openCommand("open-capacity"));
    const discovery = await planDiscovery(harness, opened);
    const nextEligibleAt = new Date(
      harness.clock.now().getTime() + 120_000,
    ).toISOString();
    const parked = await harness.abort.execute({
      commandId: "abort-capacity",
      investigationId: opened.investigationId,
      expectedVersion: discovery.version,
      turnId: discovery.turn!.turnId,
      reason: ReviewInvestigationAbortReason.CapacityUnavailable,
      nextEligibleAt,
    });
    expect(parked).toMatchObject({
      state: ReviewInvestigationState.AwaitingTurn,
      semanticTurns: 0,
      operationalAttempts: 1,
      nextAction: ReviewInvestigationNextActionKind.AwaitCapacity,
    });

    const notYetEligible = await harness.plan.execute({
      commandId: "plan-too-early",
      investigationId: opened.investigationId,
      expectedVersion: parked.version,
      leaseDurationMs: 60_000,
      maxObligationsForTurn: 10,
    });
    expect(notYetEligible.version).toBe(parked.version);
    expect(notYetEligible.turn).toBeNull();
  });

  it("parks an unavailable critic without replanning it in a tight loop", async () => {
    const harness = createHarness();
    const opened = await harness.open.execute(
      criticPolicyV1OpenCommand(
        "open-critic-capacity",
        independentCriticRiskPriorityV1,
      ),
    );
    const discovery = await planDiscovery(harness, opened);
    const awaitingCritic = await harness.commit.execute({
      ...emptyCommit(discovery, "commit-before-critic-capacity"),
      closureClaims: [
        {
          obligationId: discovery.turn!.obligationIds[0]!,
          receipt: receipt("receipt-before-critic-capacity", changedSubject),
        },
      ],
    });
    const critic = await harness.plan.execute({
      commandId: "plan-critic-capacity",
      investigationId: opened.investigationId,
      expectedVersion: awaitingCritic.version,
      leaseDurationMs: 60_000,
      maxObligationsForTurn: 10,
    });
    const nextEligibleAt = new Date(
      harness.clock.now().getTime() + 120_000,
    ).toISOString();
    const parked = await harness.abort.execute({
      commandId: "abort-critic-capacity",
      investigationId: opened.investigationId,
      expectedVersion: critic.version,
      turnId: critic.turn!.turnId,
      reason: ReviewInvestigationAbortReason.RetryableInfrastructureFailure,
      nextEligibleAt,
    });
    expect(parked).toMatchObject({
      state: ReviewInvestigationState.AwaitingCritic,
      criticCycles: 0,
      operationalAttempts: 1,
      nextAction: ReviewInvestigationNextActionKind.AwaitCapacity,
    });

    const notYetEligible = await harness.plan.execute({
      commandId: "plan-critic-too-early",
      investigationId: opened.investigationId,
      expectedVersion: parked.version,
      leaseDurationMs: 60_000,
      maxObligationsForTurn: 10,
    });
    expect(notYetEligible.version).toBe(parked.version);
    expect(notYetEligible.turn).toBeNull();
  });

  it("serializes and restores byte-identical durable state", async () => {
    const harness = createHarness();
    const opened = await harness.open.execute(openCommand("open-restart"));
    await planDiscovery(harness, opened);
    const before = harness.store.exportSnapshot();
    const restoredStore = InMemoryInvestigationStore.fromSnapshot(before);
    expect(restoredStore.exportSnapshot()).toBe(before);

    const restore = new RestoreReviewInvestigation(
      restoredStore,
      harness.digest,
    );
    const restored = await restore.snapshot(opened.investigationId);
    expect(serializeReviewInvestigation(restored)).toBe(
      serializeReviewInvestigation(
        await harness.restore.snapshot(opened.investigationId),
      ),
    );
  });

  it("preserves the legacy dossier preimage when no manifest was admitted", async () => {
    const harness = createHarness();
    const opened = await harness.open.execute(
      openCommand("open-legacy-dossier"),
    );
    const stored = (await harness.store.findById(opened.investigationId))!;
    const legacyWithoutDigest = {
      ...stored,
      investigationManifestCanonicalJson: null,
      investigationManifestHash: null,
    };
    const legacy = {
      ...legacyWithoutDigest,
      dossierDigest: await harness.digest.digestUtf8(
        canonicalJson(investigationDossierCanonicalValue(legacyWithoutDigest)),
      ),
    };
    expect(
      Object.prototype.hasOwnProperty.call(
        investigationDossierCanonicalValue(legacy),
        "investigationManifestHash",
      ),
    ).toBe(false);
    const migratedStore = new InMemoryInvestigationStore();
    await migratedStore.commit({
      investigation: legacy,
      expectedVersion: null,
      commandId: "legacy-open-command",
      commandHash: "3".repeat(64),
      transition: { kind: InvestigationStoreTransitionKind.Opened },
    });
    await expect(
      new RestoreReviewInvestigation(migratedStore, harness.digest).snapshot(
        legacy.investigationId,
      ),
    ).resolves.toMatchObject({
      investigationManifestCanonicalJson: null,
      investigationManifestHash: null,
      dossierDigest: legacy.dossierDigest,
    });
  });

  it("restores legacy policy dossiers and upgrades their digest on mutation", async () => {
    const harness = createHarness();
    const opened = await harness.open.execute(
      openCommand("open-legacy-policy-dossier"),
    );
    const stored = (await harness.store.findById(opened.investigationId))!;
    const legacyPolicy = { ...stored.policy };
    delete legacyPolicy.maxSeedProbesPerFile;
    delete legacyPolicy.maxSeedProbesOverall;
    const legacyPreimage = {
      ...stored,
      policyCanonicalVersion: InvestigationPolicyCanonicalVersion.LegacyV1,
      policy: legacyPolicy,
    };
    const legacy = {
      ...stored,
      policyCanonicalVersion: InvestigationPolicyCanonicalVersion.LegacyV1,
      policy: legacyPolicy,
      dossierDigest: await harness.digest.digestUtf8(
        canonicalJson(investigationDossierCanonicalValue(legacyPreimage)),
      ),
    };
    const migratedStore = new InMemoryInvestigationStore();
    await migratedStore.commit({
      investigation: legacy,
      expectedVersion: null,
      commandId: "legacy-policy-open-command",
      commandHash: "4".repeat(64),
      transition: { kind: InvestigationStoreTransitionKind.Opened },
    });
    const restore = new RestoreReviewInvestigation(
      migratedStore,
      harness.digest,
    );
    await expect(
      restore.snapshot(legacy.investigationId),
    ).resolves.toMatchObject({
      dossierDigest: legacy.dossierDigest,
      policyCanonicalVersion: InvestigationPolicyCanonicalVersion.LegacyV1,
      policy: legacyPolicy,
    });
    const planned = await new PlanNextInvestigationTurn(
      migratedStore,
      harness.authority,
      harness.digest,
      harness.clock,
    ).execute({
      commandId: "legacy-policy-plan",
      investigationId: legacy.investigationId,
      expectedVersion: legacy.version,
      leaseDurationMs: 60_000,
      maxObligationsForTurn: 10,
    });
    expect(planned.dossierDigest).not.toBe(legacy.dossierDigest);
    expect(
      (await migratedStore.findById(legacy.investigationId))
        ?.policyCanonicalVersion,
    ).toBe(InvestigationPolicyCanonicalVersion.SeedProbeV2);
    await expect(
      restore.snapshot(legacy.investigationId),
    ).resolves.toMatchObject({
      dossierDigest: planned.dossierDigest,
    });
  });

  it("rejects a legacy canonical version carrying seed probe limits", () => {
    const policy = openCommand("policy-downgrade").policy;
    expect(() =>
      policyCanonicalValue(
        policy,
        InvestigationPolicyCanonicalVersion.LegacyV1,
      ),
    ).toThrow("investigation_policy_canonical_downgrade_invalid");
  });

  it("is order-independent and rejects conflicting command replay", async () => {
    for (let seed = 1; seed <= 50; seed += 1) {
      const left = createHarness();
      const right = createHarness();
      const command = openCommand(`order-${seed}`);
      const shuffled = {
        ...command,
        commandId: `order-shuffled-${seed}`,
        seedObligations: deterministicShuffle(command.seedObligations, seed),
      };
      const [leftResult, rightResult] = await Promise.all([
        left.open.execute(command),
        right.open.execute(shuffled),
      ]);
      expect(rightResult.dossierDigest).toBe(leftResult.dossierDigest);
    }

    const harness = createHarness();
    const command = openCommand("open-conflict");
    await harness.open.execute(command);
    await expect(
      harness.open.execute({ ...command, workSlotId: "different-slot" }),
    ).rejects.toThrow("investigation_idempotency_conflict");
  });

  it("rejects stale, truncated, failed, and unreferenced evidence", async () => {
    for (const invalid of [
      { reviewRevisionHash: "b".repeat(64) },
      { truncated: true },
      { complete: false },
      { failed: true },
    ]) {
      const harness = createHarness();
      const opened = await harness.open.execute(
        openCommand(`invalid-${JSON.stringify(invalid)}`),
      );
      const discovery = await planDiscovery(harness, opened);
      await expect(
        harness.commit.execute({
          ...emptyCommit(discovery, `commit-${JSON.stringify(invalid)}`),
          closureClaims: [
            {
              obligationId: discovery.turn!.obligationIds[0]!,
              receipt: {
                ...receipt("invalid-receipt", changedSubject),
                ...invalid,
              },
            },
          ],
        }),
      ).rejects.toThrow("obligation_receipt_invalid");
    }

    const harness = createHarness();
    const opened = await harness.open.execute(
      openCommand("unreferenced-finding"),
    );
    const discovery = await planDiscovery(harness, opened);
    await expect(
      harness.commit.execute({
        ...emptyCommit(discovery, "unreferenced-finding-commit"),
        findings: [
          {
            fingerprint: "unsupported",
            severity: InvestigationFindingSeverity.Major,
            title: "Unsupported",
            body: "No accepted evidence",
            path: "src/service.ts",
            line: 1,
            evidenceReceiptIds: ["missing-receipt"],
          },
        ],
      }),
    ).rejects.toThrow("finding_evidence_invalid");
  });
  it("admits results only strictly before the effective deadline", () => {
    const deadline = "2026-08-02T10:01:00.000Z";
    expect(
      decideTurnResultAdmission({
        authority: TurnResultAuthority.Superseded,
        admittedAt: "2026-08-02T10:00:59.999Z",
        deadlines: [deadline, "2026-08-02T10:02:00.000Z"],
      }),
    ).toEqual({
      kind: TurnResultAdmissionKind.HistoricalDrain,
      effectiveDeadline: deadline,
    });
    expect(
      decideTurnResultAdmission({
        authority: TurnResultAuthority.Current,
        admittedAt: deadline,
        deadlines: [deadline],
      }).kind,
    ).toBe(TurnResultAdmissionKind.Rejected);
  });

  it("recovers an expired current turn and becomes inconclusive on budget", async () => {
    const harness = createHarness({ ...policy, maxOperationalAttempts: 2 });
    const opened = await harness.open.execute(
      openCommand("expiry-open", harness.policy),
    );
    const planned = await planDiscovery(harness, opened);
    harness.clock.advance(60_000);
    const reconcile = new ReconcileExpiredActiveTurn(
      harness.store,
      harness.authority,
      harness.digest,
      harness.clock,
    );

    const recovered = await reconcile.execute(planned.investigationId);
    expect(recovered).toMatchObject({
      state: ReviewInvestigationState.AwaitingTurn,
      activeTurn: null,
      operationalAttempts: 1,
    });
    const replanned = await harness.plan.execute({
      commandId: "expiry-replan",
      investigationId: recovered.investigationId,
      expectedVersion: recovered.version,
      leaseDurationMs: 60_000,
      maxObligationsForTurn: 10,
    });
    harness.clock.advance(60_000);
    const exhausted = await reconcile.execute(replanned.investigationId);
    expect(exhausted).toMatchObject({
      state: ReviewInvestigationState.Inconclusive,
      conclusion: ReviewInvestigationConclusion.Inconclusive,
      activeTurn: null,
      operationalAttempts: 2,
    });
  });

  it("drains a superseded result without producing a current projection", async () => {
    const harness = createHarness();
    const opened = await harness.open.execute(openCommand("drain-open"));
    const planned = await planDiscovery(harness, opened);
    const historicalReceipt = receipt("receipt-drain", changedSubject);
    const obligationCountBeforeDrain = (await harness.store.findById(
      planned.investigationId,
    ))!.obligations.length;
    harness.authority.verdict =
      InvestigationExecutionAuthorityVerdict.Superseded;
    const command = {
      ...emptyCommit(planned, "drain-commit"),
      closureClaims: [
        {
          obligationId: planned.turn!.obligationIds[0]!,
          receipt: historicalReceipt,
        },
      ],
      findings: [
        {
          fingerprint: "historical-access-check",
          severity: InvestigationFindingSeverity.Major,
          title: "Access check is stale",
          body: "The superseded revision exposed a stale access decision.",
          path: "src/service.ts",
          line: 12,
          evidenceReceiptIds: [historicalReceipt.receiptId],
        },
      ],
      admittedAt: "2026-08-02T10:00:59.999Z",
      resultDeadlines: [planned.turn!.expiresAt],
      deterministicExpansions: [
        {
          kind: InvestigationObligationKind.DirectCaller,
          canonicalSubject: canonicalRelationObligationSubjectV2({
            obligationKind: InvestigationObligationKind.DirectCaller,
            sourceObligationId: "c".repeat(64),
            initialOperationInputHash: "d".repeat(64),
            queryHash: "e".repeat(64),
            requiredPathSetHash: "f".repeat(64),
          }),
          canonicalRequirement: canonicalInvestigationEvidenceRequirement({
            requirementVersion: obligationEvidenceRequirementVersionV2,
            kind: InvestigationEvidenceRequirementKind.CompleteRelationContext,
            sourceObligationId: "c".repeat(64),
            initialOperationInputHash: "d".repeat(64),
            queryHash: "e".repeat(64),
            requiredPathCount: 1,
            requiredPathSetHash: "f".repeat(64),
            requiredPathHashes: ["1".repeat(64)],
            requiredQueryDigest: "2".repeat(64),
            sourcePathHash: "3".repeat(64),
            revision: InvestigationOperationRevision.Head,
            searchPolicyVersion: "review-investigation-fixed-string-search.v1",
          }),
          riskPriority: 100,
        },
      ],
    } as const;
    const prepareDeterministicExpansionQueries = vi.fn(async () => {
      throw new Error("expired_private_material_must_not_be_resolved");
    });
    const privateContext = { prepareDeterministicExpansionQueries };
    const committed = await harness.commit.execute(command, privateContext);
    await expect(harness.commit.execute(command)).resolves.toEqual(committed);
    expect(prepareDeterministicExpansionQueries).not.toHaveBeenCalled();

    expect(committed).toMatchObject({
      state: ReviewInvestigationState.Superseded,
      turn: null,
      conclusion: null,
    });
    const stored = await harness.store.findById(committed.investigationId);
    expect(stored).toMatchObject({
      certificate: null,
      totalUsageTokens: 100,
      totalDurationMs: 100,
    });
    expect(stored?.turnProvenance).toHaveLength(1);
    expect(stored?.obligations).toHaveLength(obligationCountBeforeDrain);
    expect(stored?.replayEvidenceCheckpoint).toMatchObject({
      sourceState: ReviewInvestigationState.Superseded,
      sourceInvestigationVersion: committed.version,
    });
    expect(
      Date.parse(stored!.replayEvidenceCheckpoint!.expiresAt),
    ).toBeGreaterThan(Date.parse(planned.turn!.expiresAt));

    harness.authority.verdict = InvestigationExecutionAuthorityVerdict.Current;
    const target = openCommand("drain-target");
    const replay = new ReplayReviewInvestigation(
      harness.store,
      harness.authority,
      {
        replay: async ({ sourceReceipt, targetRevision, replayProofId }) => ({
          verdict: InvestigationReceiptReplayVerdict.Matched,
          targetReceipt: {
            ...sourceReceipt,
            receiptId: `drain-target-${sourceReceipt.receiptId}`,
            reviewRevisionHash: targetRevision.reviewRevisionHash,
            replayProofId,
          },
        }),
      },
      harness.digest,
      digestBackedInvestigationManifestIdentity(harness.digest),
      harness.clock,
    );
    const replayed = await replay.execute({
      commandId: "replay-drained-findings",
      sourceInvestigationId: stored!.investigationId,
      sourceCheckpointHash: stored!.replayEvidenceCheckpoint!.checkpointHash,
      targetScope: target.scope,
      targetRevision: {
        ...target.revision,
        headSha: "8".repeat(40),
        reviewRevisionHash: "8".repeat(64),
      },
      targetExecutionId: "execution-drain-target",
      targetWorkSlotId: "slot-drain-target",
      targetStableReviewUnitKey: target.stableReviewUnitKey,
      targetProviderVoteLaneId: target.providerVoteLaneId,
      targetProviderStrategyId: target.providerStrategyId,
      targetInvestigationManifestCanonicalJson:
        target.investigationManifestCanonicalJson!,
      targetInvestigationManifestHash: target.investigationManifestHash!,
      targetRuntimeProfile: target.runtimeProfile,
      targetContract: target.contract,
      targetPolicy: target.policy,
      targetSeedObligations: target.seedObligations,
      targetInitialReceipts: [],
      replayProofs: stored!.obligations.map((obligation) => ({
        obligationId: obligation.obligationId,
        replayProofId: `proof-drain-${obligation.obligationId}`,
      })),
    });
    const replayedAggregate = await harness.store.findById(
      replayed.investigationId,
    );
    expect(
      replayedAggregate?.obligations.find(
        (obligation) =>
          obligation.kind === InvestigationObligationKind.FindingRevalidation,
      ),
    ).toMatchObject({ state: InvestigationObligationState.Open });
  });

  it("rejects historical drain when execution authority is unauthorized", async () => {
    const harness = createHarness();
    const opened = await harness.open.execute(openCommand("revoke-open"));
    const planned = await planDiscovery(harness, opened);
    harness.authority.verdict =
      InvestigationExecutionAuthorityVerdict.Unauthorized;

    await expect(
      harness.commit.execute({
        ...emptyCommit(planned, "revoke-commit"),
        admittedAt: "2026-08-02T10:00:59.999Z",
        resultDeadlines: [planned.turn!.expiresAt],
      }),
    ).rejects.toThrow("investigation_turn_result_unauthorized");
    await expect(
      harness.store.findById(planned.investigationId),
    ).resolves.toMatchObject({
      state: ReviewInvestigationState.TurnLeased,
      activeTurn: { turnId: planned.turn!.turnId },
    });
  });

  it("serializes historical commit against expiry reconciliation", async () => {
    const harness = createHarness();
    const opened = await harness.open.execute(openCommand("race-open"));
    const planned = await planDiscovery(harness, opened);
    harness.clock.advance(60_000);
    harness.authority.verdict =
      InvestigationExecutionAuthorityVerdict.Superseded;
    const reconcile = new ReconcileExpiredActiveTurn(
      harness.store,
      harness.authority,
      harness.digest,
      harness.clock,
    );
    const results = await Promise.allSettled([
      harness.commit.execute({
        ...emptyCommit(planned, "race-commit"),
        admittedAt: "2026-08-02T10:00:59.999Z",
        resultDeadlines: [planned.turn!.expiresAt],
      }),
      reconcile.execute(planned.investigationId),
    ]);

    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    await expect(
      harness.store.findById(planned.investigationId),
    ).resolves.toMatchObject({
      state: ReviewInvestigationState.Superseded,
      activeTurn: null,
    });
  });

  it("lazy restore reconciles an expired superseded active turn", async () => {
    const harness = createHarness();
    const opened = await harness.open.execute(openCommand("lazy-open"));
    const planned = await planDiscovery(harness, opened);
    harness.clock.advance(2 * 60 * 60_000);
    harness.authority.verdict =
      InvestigationExecutionAuthorityVerdict.Superseded;
    const reconcile = new ReconcileExpiredActiveTurn(
      harness.store,
      harness.authority,
      harness.digest,
      harness.clock,
    );
    const restore = new RestoreReviewInvestigation(
      harness.store,
      harness.digest,
      reconcile,
    );

    await expect(
      restore.execute(planned.investigationId),
    ).resolves.toMatchObject({
      state: ReviewInvestigationState.Superseded,
      turn: null,
    });
    await expect(
      harness.store.findById(planned.investigationId),
    ).resolves.toMatchObject({
      replayEvidenceCheckpoint: {
        sourceState: ReviewInvestigationState.Superseded,
        issuedAt: harness.clock.now().toISOString(),
      },
    });
    const recovered = await harness.store.findById(planned.investigationId);
    expect(
      Date.parse(recovered!.replayEvidenceCheckpoint!.expiresAt),
    ).toBeGreaterThan(harness.clock.now().getTime());
  });

  it("terminalizes an expired turn after authorization is revoked", async () => {
    const harness = createHarness();
    const opened = await harness.open.execute(openCommand("revoked-expiry"));
    const planned = await planDiscovery(harness, opened);
    harness.clock.advance(60_000);
    harness.authority.verdict =
      InvestigationExecutionAuthorityVerdict.Unauthorized;

    await expect(
      new ReconcileExpiredActiveTurn(
        harness.store,
        harness.authority,
        harness.digest,
        harness.clock,
      ).execute(planned.investigationId),
    ).resolves.toMatchObject({
      state: ReviewInvestigationState.Superseded,
      activeTurn: null,
    });
  });

  it("validates the persisted dossier before direct recovery mutates it", async () => {
    const harness = createHarness();
    const opened = await harness.open.execute(openCommand("corrupt-expiry"));
    const planned = await planDiscovery(harness, opened);
    harness.clock.advance(60_000);
    harness.authority.verdict =
      InvestigationExecutionAuthorityVerdict.Superseded;
    const findStored = harness.store.findById.bind(harness.store);
    vi.spyOn(harness.store, "findById").mockImplementation(async (id) => {
      const stored = await findStored(id);
      return stored === null
        ? null
        : { ...stored, dossierDigest: "0".repeat(64) };
    });
    const commit = vi.spyOn(harness.store, "commit");
    const reconcile = new ReconcileExpiredActiveTurn(
      harness.store,
      harness.authority,
      harness.digest,
      harness.clock,
    );

    await expect(reconcile.execute(planned.investigationId)).rejects.toThrow(
      "investigation_dossier_digest_invalid",
    );
    expect(commit).not.toHaveBeenCalled();
  });
});

function createHarness(customPolicy: ReviewInvestigationPolicy = policy) {
  const store = new InMemoryInvestigationStore();
  const digest = new NodeSha256InvestigationDigest();
  const clock = new FixedInvestigationClock(
    new Date("2026-08-02T10:00:00.000Z"),
  );
  const authority = new CurrentInvestigationExecutionAuthority();
  return {
    store,
    digest,
    clock,
    authority,
    policy: customPolicy,
    open: new OpenReviewInvestigation(
      store,
      authority,
      digest,
      digestBackedInvestigationManifestIdentity(digest),
      clock,
    ),
    restore: new RestoreReviewInvestigation(store, digest),
    plan: new PlanNextInvestigationTurn(store, authority, digest, clock),
    commit: new CommitInvestigationTurn(store, authority, digest, clock),
    abort: new AbortInvestigationTurn(store, digest, clock),
    conclude: new ConcludeReviewInvestigation(store, authority, digest, clock, {
      project: async (investigation) => {
        const canonicalJson = JSON.stringify({
          findings: investigation.findings,
          totalUsageTokens: investigation.totalUsageTokens,
        });
        return {
          canonicalJson,
          terminalOutcomeHash: await digest.digestUtf8(canonicalJson),
          conclusion:
            investigation.conclusion ??
            (investigation.findings.length > 0
              ? ReviewInvestigationConclusion.Findings
              : ReviewInvestigationConclusion.VerifiedClean),
        };
      },
    }),
  };
}

function openCommand(
  commandId: string,
  selectedPolicy: ReviewInvestigationPolicy = policy,
): OpenReviewInvestigationCommand {
  return {
    commandId,
    scope: {
      workspaceId: "workspace-test",
      repositoryConnectionId: "repository-test",
      scmRepositoryIdentityId: "scm-test",
      pullRequestNumber: 42,
      trustDomain: "trusted-local",
      authorizationScopeHash: "e".repeat(64),
    },
    revision: {
      baseSha: "1".repeat(40),
      mergeBaseSha: "2".repeat(40),
      headSha: "3".repeat(40),
      reviewRevisionHash: revisionHash,
    },
    executionId: "execution-test",
    workSlotId: "slot-test",
    stableReviewUnitKey: "stable-unit-test",
    providerVoteLaneId: "lane-codex",
    providerStrategyId: "strategy-single-provider",
    investigationManifestCanonicalJson: "{}",
    investigationManifestHash:
      "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
    runtimeProfile: ReviewInvestigationRuntimeProfile.GatewayAttestedAgentV1,
    contract: {
      coverageContractVersion: "coverage-v1",
      expansionRulesVersion: "expansion-v1",
      criticPolicyVersion: "critic-v1",
      gatewayPolicyVersion: "gateway-v4",
      probePolicyVersion: "probe-v1",
      producerReleaseId: "producer-test",
      runtimeProfileVersion: "runtime-v1",
      searchPolicyVersion: "search-v1",
    },
    policy: selectedPolicy,
    seedObligations: [
      {
        kind: InvestigationObligationKind.InventoryWitness,
        canonicalSubject: inventorySubject,
        canonicalRequirement: "match canonical inventory hash",
        riskPriority: 100,
      },
      {
        kind: InvestigationObligationKind.ChangedContent,
        canonicalSubject: changedSubject,
        canonicalRequirement: "read complete changed content",
        riskPriority: 80,
      },
    ],
    initialReceipts: [receipt("receipt-inventory", inventorySubject)],
  };
}

function criticPolicyV1OpenCommand(
  commandId: string,
  semanticRisk: number,
): OpenReviewInvestigationCommand {
  const command = openCommand(commandId);
  return {
    ...command,
    contract: {
      ...command.contract,
      criticPolicyVersion: reviewInvestigationCriticPolicyV1,
    },
    seedObligations: command.seedObligations.map((obligation) => ({
      ...obligation,
      riskPriority:
        obligation.kind === InvestigationObligationKind.InventoryWitness
          ? 1_000_000
          : semanticRisk,
    })),
  };
}

async function planDiscovery(
  harness: ReturnType<typeof createHarness>,
  opened: Awaited<ReturnType<OpenReviewInvestigation["execute"]>>,
) {
  return harness.plan.execute({
    commandId: `plan-${opened.investigationId}`,
    investigationId: opened.investigationId,
    expectedVersion: opened.version,
    leaseDurationMs: 60_000,
    maxObligationsForTurn: 10,
  });
}

function emptyCommit(
  planned: Awaited<ReturnType<PlanNextInvestigationTurn["execute"]>>,
  commandId: string,
): CommitInvestigationTurnCommand {
  return {
    commandId,
    investigationId: planned.investigationId,
    expectedVersion: planned.version,
    turnId: planned.turn!.turnId,
    closureClaims: [],
    unresolvableDecisions: [],
    proposals: [],
    findings: [],
    criticDecision: null,
    usageTokens: 100,
    durationMs: 100,
    provenance: provenance(planned, 100, 100),
  };
}

function provenance(
  planned: Awaited<ReturnType<PlanNextInvestigationTurn["execute"]>>,
  totalTokens: number,
  durationMs: number,
  actualProviderKind: InvestigationTurnProviderKind = InvestigationTurnProviderKind.Codex,
) {
  return {
    turnId: planned.turn!.turnId,
    purpose: planned.turn!.purpose,
    actualProviderKind,
    actualModel: "gpt-test",
    runtimeProfile: ReviewInvestigationRuntimeProfile.GatewayAttestedAgentV1,
    inputTokens: totalTokens,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens,
    durationMs,
    acceptedAttestationId: `attestation-${planned.turn!.turnId}`,
    acceptedAttestationHash: "b".repeat(64),
    acceptedOperationReceiptIds: [],
    terminalOutcomeHash: "c".repeat(64),
  } as const;
}

function receipt(receiptId: string, canonicalSubject: string) {
  return {
    receiptId,
    operationKey: `operation-${receiptId}`,
    kind: InvestigationReceiptKind.Blob,
    canonicalSubject,
    reviewRevisionHash: revisionHash,
    gatewayPolicyVersion: "gateway-v4",
    evidenceDigest: "f".repeat(64),
    operationReceiptIds: ["7".repeat(64)],
    acceptedAttestationId: `attestation-${receiptId}`,
    acceptedAttestationHash: "8".repeat(64),
    replayProofId: null,
    complete: true,
    truncated: false,
    failed: false,
  } as const;
}

function deterministicShuffle<T>(items: readonly T[], seed: number): T[] {
  const result = [...items];
  let state = seed;
  for (let index = result.length - 1; index > 0; index -= 1) {
    state = (state * 1_103_515_245 + 12_345) & 0x7fffffff;
    const target = state % (index + 1);
    [result[index], result[target]] = [result[target]!, result[index]!];
  }
  return result;
}

const policy: ReviewInvestigationPolicy = {
  policyId: "investigation-test-v1",
  maxObligations: 100,
  maxExpansionDepth: 5,
  maxSemanticTurns: 5,
  maxOperationalAttempts: 3,
  maxCriticCycles: 2,
  maxFindings: 20,
  maxProposalsPerTurn: 20,
  maxReceiptsPerTurn: 50,
  maxSeedProbesPerFile: 48,
  maxSeedProbesOverall: 384,
};
