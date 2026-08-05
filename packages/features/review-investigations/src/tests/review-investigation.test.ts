import { describe, expect, it } from "vitest";
import {
  AbortInvestigationTurn,
  AcquireInvestigationLease,
  CommitInvestigationTurn,
  ConcludeReviewInvestigation,
  ContextCriticDecision,
  enforceCriticPolicyForConclusion,
  InvestigationFindingSeverity,
  InvestigationLeaseAcquireStatus,
  InvestigationStoreTransitionKind,
  InvestigationObligationKind,
  InvestigationReceiptReplayVerdict,
  InvestigationReceiptKind,
  InvestigationTurnProviderKind,
  investigationDossierCanonicalValue,
  canonicalJson,
  independentCriticRiskPriorityV1,
  OpenReviewInvestigation,
  PlanNextInvestigationTurn,
  PrepareReviewInvestigationReplay,
  PrepareReviewInvestigationReplayStatus,
  ReplayReviewInvestigation,
  RestoreReviewInvestigation,
  ReviewInvestigationAbortReason,
  ReviewInvestigationConclusion,
  ReviewInvestigationNextActionKind,
  ReviewInvestigationRuntimeProfile,
  ReviewInvestigationState,
  ReviewInvestigationTurnPurpose,
  reviewInvestigationCriticPolicyV1,
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
      terminalOutcomeHash: "c".repeat(64),
    } as const;
    expect(() =>
      summarizeTerminalDiscoveryProvenance([
        base,
        { ...base, turnId: "turn-2", actualModel: "gpt-two" },
      ]),
    ).toThrow("investigation_terminal_provenance_ambiguous");
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
      sourceCertificateHash: snapshot.certificate!.certificateHash,
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
      sourceCertificateHash: snapshot.certificate!.certificateHash,
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
      sourceCertificateHash: snapshot.certificate!.certificateHash,
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
};
