import { describe, expect, it } from "vitest";
import {
  AbortInvestigationTurn,
  CommitInvestigationTurn,
  ConcludeReviewInvestigation,
  ContextCriticDecision,
  InvestigationObligationKind,
  InvestigationReceiptKind,
  InvestigationTurnProviderKind,
  OpenReviewInvestigation,
  PlanNextInvestigationTurn,
  RestoreReviewInvestigation,
  ReviewInvestigationAbortReason,
  ReviewInvestigationConclusion,
  ReviewInvestigationNextActionKind,
  ReviewInvestigationRuntimeProfile,
  ReviewInvestigationState,
  serializeReviewInvestigation,
  type CommitInvestigationTurnCommand,
  type OpenReviewInvestigationCommand,
  type ReviewInvestigationPolicy,
} from "../index";
import { InMemoryInvestigationStore } from "../infrastructure/memory/in-memory-investigation-store";
import { NodeSha256InvestigationDigest } from "../infrastructure/node/node-sha256-digest";
import {
  CurrentInvestigationExecutionAuthority,
  FixedInvestigationClock,
} from "../testing/investigation-test-kit";

const revisionHash = "a".repeat(64);
const inventorySubject = "inventory:canonical";
const changedSubject = "src/service.ts@head";

describe("review investigation in-memory vertical slice", () => {
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
    expect(snapshot.conclusion).toBe(ReviewInvestigationConclusion.VerifiedClean);
    expect(snapshot.certificate?.certificateHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(snapshot.certificate?.dossierDigest).toBe(ready.dossierDigest);
    expect(snapshot.certificate?.terminalOutcomeHash).toMatch(
      /^[a-f0-9]{64}$/u,
    );
    expect(snapshot.certificate?.turnProvenanceHash).toMatch(
      /^[a-f0-9]{64}$/u,
    );
    expect(snapshot.certificate?.criticDecision).toBe(
      ContextCriticDecision.Accept,
    );
  });

  it("rejects a contradictory critic accept that proposes more work", async () => {
    const harness = createHarness();
    const opened = await harness.open.execute(openCommand("open-critic-conflict"));
    const discovery = await planDiscovery(harness, opened);
    const awaitingCritic = await harness.commit.execute({
      ...emptyCommit(discovery, "commit-before-critic-conflict"),
      closureClaims: [{
        obligationId: discovery.turn!.obligationIds[0]!,
        receipt: receipt("receipt-before-critic-conflict", changedSubject),
      }],
    });
    const critic = await harness.plan.execute({
      commandId: "plan-critic-conflict",
      investigationId: opened.investigationId,
      expectedVersion: awaitingCritic.version,
      leaseDurationMs: 60_000,
      maxObligationsForTurn: 10,
    });
    await expect(harness.commit.execute({
      ...emptyCommit(critic, "commit-critic-conflict"),
      criticDecision: ContextCriticDecision.Accept,
      proposals: [{
        kind: InvestigationObligationKind.DirectCaller,
        canonicalSubject: "src/caller.ts",
        canonicalRequirement: "inspect caller",
        riskPriority: 90,
      }],
    })).rejects.toThrow("critic_output_contradictory");
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
          severity: "major",
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
    const opened = await harness.open.execute(openCommand("open-inconclusive", harness.policy));
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
    expect(snapshot.conclusion).toBe(ReviewInvestigationConclusion.Inconclusive);
    expect(snapshot.certificate?.conclusion).toBe(
      ReviewInvestigationConclusion.Inconclusive,
    );
  });

  it("parks capacity failures without consuming semantic turns or tight-looping", async () => {
    const harness = createHarness();
    const opened = await harness.open.execute(openCommand("open-capacity"));
    const discovery = await planDiscovery(harness, opened);
    const nextEligibleAt = new Date(harness.clock.now().getTime() + 120_000).toISOString();
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

  it("serializes and restores byte-identical durable state", async () => {
    const harness = createHarness();
    const opened = await harness.open.execute(openCommand("open-restart"));
    await planDiscovery(harness, opened);
    const before = harness.store.exportSnapshot();
    const restoredStore = InMemoryInvestigationStore.fromSnapshot(before);
    expect(restoredStore.exportSnapshot()).toBe(before);

    const restore = new RestoreReviewInvestigation(restoredStore, harness.digest);
    const restored = await restore.snapshot(opened.investigationId);
    expect(serializeReviewInvestigation(restored)).toBe(
      serializeReviewInvestigation(
        (await harness.restore.snapshot(opened.investigationId)),
      ),
    );
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
      const opened = await harness.open.execute(openCommand(`invalid-${JSON.stringify(invalid)}`));
      const discovery = await planDiscovery(harness, opened);
      await expect(
        harness.commit.execute({
          ...emptyCommit(discovery, `commit-${JSON.stringify(invalid)}`),
          closureClaims: [
            {
              obligationId: discovery.turn!.obligationIds[0]!,
              receipt: { ...receipt("invalid-receipt", changedSubject), ...invalid },
            },
          ],
        }),
      ).rejects.toThrow("obligation_receipt_invalid");
    }

    const harness = createHarness();
    const opened = await harness.open.execute(openCommand("unreferenced-finding"));
    const discovery = await planDiscovery(harness, opened);
    await expect(
      harness.commit.execute({
        ...emptyCommit(discovery, "unreferenced-finding-commit"),
        findings: [
          {
            fingerprint: "unsupported",
            severity: "major",
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
  const clock = new FixedInvestigationClock(new Date("2026-08-02T10:00:00.000Z"));
  const authority = new CurrentInvestigationExecutionAuthority();
  return {
    store,
    digest,
    clock,
    authority,
    policy: customPolicy,
    open: new OpenReviewInvestigation(store, authority, digest, clock),
    restore: new RestoreReviewInvestigation(store, digest),
    plan: new PlanNextInvestigationTurn(store, authority, digest, clock),
    commit: new CommitInvestigationTurn(store, authority, digest, clock),
    abort: new AbortInvestigationTurn(store, digest, clock),
    conclude: new ConcludeReviewInvestigation(
      store,
      authority,
      digest,
      clock,
      {
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
      },
    ),
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
    runtimeProfile: ReviewInvestigationRuntimeProfile.GatewayAttestedAgentV1,
    contract: {
      coverageContractVersion: "coverage-v1",
      expansionRulesVersion: "expansion-v1",
      criticPolicyVersion: "critic-v1",
      gatewayPolicyVersion: "gateway-v4",
      producerReleaseId: "producer-test",
      runtimeProfileVersion: "runtime-v1",
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
) {
  return {
    turnId: planned.turn!.turnId,
    purpose: planned.turn!.purpose,
    actualProviderKind: InvestigationTurnProviderKind.Codex,
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
