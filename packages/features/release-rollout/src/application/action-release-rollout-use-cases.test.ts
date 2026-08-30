import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { sha256Canonical } from "../domain/canonical-json";
import {
  sha256,
  terminalCanaryReceiptIdentityDigest,
  verifiedActionReleaseV2,
  type FixedCanaryBindingInput,
  type ImmutableEvidenceArtifactLocator,
  type Sha256,
  type VerifiedActionReleaseV2,
  type VerifiedFixedTerminalCanaryReceiptV4,
} from "../domain/action-release-identity";
import {
  acceptFixedTerminalCanaryReceipt,
  armFixedActionReleaseCanary,
  authorizeFixedActionReleaseCanaryProvisioning,
  beginActionReleaseOverlapStaging,
  beginActionReleasePromotion,
  beginFixedTerminalCanaryReceiptVerification,
  beginPredecessorAdmissionClose,
  completeActionReleasePromotion,
  confirmFixedActionReleaseCanaryProvisioned,
  createSteadyActionReleaseRollout,
  exactProductionActionConfiguration,
  markActionReleasePromotionUncertain,
  prepareActionReleasePromotion,
  recordPredecessorAdmissionFence,
  recordPredecessorZeroCapture,
  registerActionReleaseCandidate,
  stageActionReleaseOverlap,
  type ActionReleaseRollout,
} from "../domain/action-release-rollout";
import {
  completeLiveActionReferenceInventory,
  LiveActionDatabaseCoverage,
  LiveActionReferenceKind,
  productionActionConfigurationConsensusDigest,
  zeroPredecessorReferenceCapture,
  type LiveActionReferenceInventoryCaptureV1,
} from "../domain/live-action-reference-inventory";
import {
  ActionReleaseRepositoryWriteResult,
  type ActionReleaseDigestPort,
  type ActionReleaseRolloutRepositoryPort,
  type PredecessorAdmissionCloseCommand,
  type ProductionActionConfigurationPort,
  type VerifiedActionReleaseAttestationV2,
} from "./action-release-rollout-ports";
import {
  AcceptFixedTerminalCanaryReceipt,
  ActionReleaseApplicationError,
  AbortActionReleaseCandidate,
  ArmAndProvisionFixedCanary,
  EnterRecoveryOnly,
  PreparePromotion,
  PromoteActionReleaseCandidate,
  ReconcilePredecessorRetention,
  ReconcileRecoveryAdmission,
  ReconcileCandidateOverlap,
  ReconcileFixedCanaryProvisioning,
  ReconcileFixedTerminalCanaryReceiptVerification,
  ReconcilePromotion,
  RegisterActionReleaseCandidate,
  ResolveActionReleaseSelection,
  StageCandidateOverlap,
  VerifyExactTaggedActionRelease,
} from "./action-release-rollout-use-cases";

const digest = (character: string) => sha256(`sha256:${character.repeat(64)}`);
const sha = (character: string) => character.repeat(40);
const at = (seconds: number) =>
  new Date(Date.UTC(2026, 7, 30, 9, 0, seconds)).toISOString();
const repositoryIdentity = {
  repositoryId: "101",
  fullName: "acme/action",
};

function release(character: string, version: number): VerifiedActionReleaseV2 {
  const commit = sha(character);
  const executable = digest(character);
  return verifiedActionReleaseV2({
    repository: repositoryIdentity,
    tag: `v1.1.${version}`,
    tagRef: { objectSha: sha("1"), objectType: "tag", peeledCommitSha: commit },
    commitTreeSha: sha("2"),
    actionManifest: { blobSha: sha("3"), main: "action-dist/index.cjs" },
    executable: {
      blobOid: sha("4"),
      mode: "100644",
      byteLength: 3,
      sha256: executable,
    },
    taggedSourceTreeSha256: digest("1"),
    buildRecipeSha256: digest("2"),
    lockfileSha256: digest("3"),
    toolchainSha256: digest("4"),
    dependencyInstallationSha256: digest("5"),
    rebuiltExecutableSha256: executable,
    publishedBundle: {
      artifactId: `artifact-${version}`,
      artifactSha256: digest("6"),
      executableSha256: executable,
    },
    release: {
      releaseId: `release-${version}`,
      immutable: true,
      digest: digest("7"),
    },
    attestation: {
      attestationId: `attestation-${version}`,
      digest: digest("8"),
      subjectBundleSha256: executable,
    },
    trustedWorkflow: {
      path: ".github/workflows/release.yml",
      ref: "refs/heads/main",
      commitSha: sha("5"),
      runId: "123",
      runAttempt: 1,
    },
    installer: {
      version: `1.1.${version}`,
      url: `https://example.test/${commit}/installer.tgz`,
      sha256: digest("9"),
    },
  });
}

const A = release("a", 1);
const B = release("b", 2);

function overlapConfig(
  observedAt = at(2),
  bindingDigest: ReturnType<typeof digest> | null = null,
) {
  return exactProductionActionConfiguration({
    schemaVersion: 1,
    revision: 10n,
    observedAt,
    serviceIds: ["api", "web"],
    primaryRef: A.actionRef,
    installerRef: A.actionRef,
    installer: A.installer,
    reusableWorkflowRef: A.actionRef,
    runtimeRef: A.actionRef,
    refreshActionRef: A.actionRef,
    interactionRuntimeRef: A.actionRef,
    knownRefs: [A.actionRef, B.actionRef],
    isolatedCandidateAttemptId: "attempt-1",
    isolatedCandidateBindingDigest: bindingDigest,
  });
}

function preOverlapConfig() {
  return exactProductionActionConfiguration({
    ...overlapConfig(at(1)),
    revision: 9n,
    knownRefs: [A.actionRef],
    isolatedCandidateAttemptId: null,
    isolatedCandidateBindingDigest: null,
  });
}

function binding(attempt = "attempt-1"): FixedCanaryBindingInput {
  void attempt;
  return {
    schemaVersion: 5,
    target: {
      githubRepositoryId: "777",
      githubRepositoryNodeId: "R_fixed",
      repositoryFullName: "777genius/review-router-saas-e2e",
      providerInstanceId: "provider-fixed",
      pullRequestNumber: 51,
      reviewWorkflowPath: ".github/workflows/review.yml",
      interactionWorkflowPath: ".github/workflows/interaction.yml",
      expectedGithubAppSlug: "reviewrouter-test",
      expectedGithubAppLogin: "reviewrouter-test[bot]",
    },
    namespaceId: "namespace-fresh",
    namespaceEpoch: 2n,
    challengeSha256: digest("c"),
    reviewedHeadSha: sha("e"),
    reviewSource: {
      commitSha: sha("e"),
      blobSha: sha("1"),
      semanticSha256: digest("1"),
    },
    interactionSource: {
      commitSha: sha("e"),
      blobSha: sha("2"),
      semanticSha256: digest("2"),
    },
    reusableWorkflowRef: B.actionRef,
    runtimeRef: B.actionRef,
    refreshActionRef: B.actionRef,
    interactionRuntimeRef: B.actionRef,
  };
}

function registered(attempt = "attempt-1") {
  return registerActionReleaseCandidate(
    createSteadyActionReleaseRollout({
      primaryRef: A.actionRef,
      channelVersion: 3n,
    }),
    {
      attemptId: attempt,
      candidateRelease: B,
      policyRevision: 11n,
      registeredAt: at(0),
    },
  );
}

function staged(attempt = "attempt-1") {
  const candidate = registered(attempt);
  const intent = beginActionReleaseOverlapStaging(candidate, {
    attemptId: attempt,
    expectedConfiguration: preOverlapConfig(),
    effectId: `overlap-effect-${attempt}`,
    effectEpoch: candidate.aggregateVersion + 1n,
    startedAt: at(1),
  });
  return stageActionReleaseOverlap(intent, {
    attemptId: attempt,
    configuration: exactProductionActionConfiguration({
      ...overlapConfig(),
      isolatedCandidateAttemptId: attempt,
    }),
  });
}

function armed(attempt = "attempt-1") {
  const prepared = armFixedActionReleaseCanary(staged(attempt), {
    attemptId: attempt,
    binding: binding(attempt),
  });
  const state = authorizeFixedActionReleaseCanaryProvisioning(prepared, {
    eligibility: {
      policyRevision: 11n,
      channelVersion: 3n,
      selectionDigest: digest("7"),
      contextDigest: digest("8"),
      decisionDigest: digest("9"),
    },
    authorizedAt: at(3),
  });
  return confirmFixedActionReleaseCanaryProvisioned(state, {
    expectationDigest: state.expectation.expectationDigest,
    decisionDigest: digest("9"),
    confirmedAt: at(3),
  });
}

function verificationStarted(state = armed()) {
  return beginFixedTerminalCanaryReceiptVerification(state, {
    attemptId: state.candidate.attemptId,
    locator: {
      artifactId: "artifact-evidence-1",
      artifactSha256: digest("e"),
    },
    effectId: `receipt-verification-${state.candidate.attemptId}`,
    effectEpoch: state.aggregateVersion + 1n,
    startedAt: at(4),
    leaseExpiresAt: at(6),
  });
}

function receipt(
  state = armed(),
  ids = { receiptId: "receipt-1", artifactId: "artifact-evidence-1" },
): VerifiedFixedTerminalCanaryReceiptV4 {
  return {
    schemaVersion: 4,
    ...ids,
    canonicalPayloadDigest: digest("d"),
    artifactSha256: digest("e"),
    expectationDigest: state.expectation.expectationDigest,
    rolloutAttemptId: state.candidate.attemptId,
    candidateActionRef: state.candidate.candidateRelease.actionRef,
    challengeSha256: state.canary.challengeSha256,
    runId: "456",
    runAttempt: 1,
    completedAt: at(4),
  } as unknown as VerifiedFixedTerminalCanaryReceiptV4;
}

function inventory(
  input: {
    capturedAt?: string;
    snapshot?: string;
    references?: LiveActionReferenceInventoryCaptureV1["references"];
    productionRelease?: VerifiedActionReleaseV2;
    databaseServerTime?: string;
    githubAppLogin?: string;
    githubWorkflows?: readonly string[];
    repositoryIds?: readonly string[];
    repositoryCohortRevision?: bigint;
    repositoryCohortDigest?: ReturnType<typeof digest>;
    policyRevision?: bigint;
  } = {},
) {
  const productionRelease = input.productionRelease ?? A;
  const production = {
    serviceIds: ["api", "web"],
    deploymentIds: ["deploy-api", "deploy-web"],
    primaryRef: productionRelease.actionRef,
    installerRef: productionRelease.actionRef,
    installer: productionRelease.installer,
    reusableWorkflowRef: productionRelease.actionRef,
    runtimeRef: productionRelease.actionRef,
    refreshActionRef: productionRelease.actionRef,
    interactionRuntimeRef: productionRelease.actionRef,
    allowlistedRefs: [A.actionRef, B.actionRef],
  } as const;
  const repositoryIds = input.repositoryIds ?? ["777"];
  const workflows = input.githubWorkflows ?? [
    ".github/workflows/review.yml",
    ".github/workflows/interaction.yml",
  ];
  const statuses = ["queued", "in_progress"] as const;
  return completeLiveActionReferenceInventory({
    schemaVersion: 1,
    completeness: "complete",
    coverageVersion: 1,
    coveredReferenceKinds: Object.values(LiveActionReferenceKind),
    unresolvedSources: [],
    repositoryCohort: {
      revision: input.repositoryCohortRevision ?? 20n,
      githubRepositoryIds: repositoryIds,
      digest: input.repositoryCohortDigest ?? digest("1"),
    },
    policyRevision: input.policyRevision ?? 11n,
    database: {
      complete: true,
      serverTime: input.databaseServerTime ?? input.capturedAt ?? at(5),
      snapshotIdentity: input.snapshot ?? "snapshot-1",
      coveredScopes: Object.values(LiveActionDatabaseCoverage),
      coveredTables: ["Lease"],
      rowCounts: { Lease: 0 },
      digest: digest("2"),
    },
    github: {
      complete: true,
      appId: "99",
      appLogin: input.githubAppLogin ?? "reviewrouter-test[bot]",
      workflows,
      statuses,
      pages: repositoryIds.flatMap((repositoryId) =>
        workflows.flatMap((workflow) =>
          statuses.map((status) => ({
            repositoryId,
            workflow,
            status,
            page: 1,
            responseDigest: digest(status === "queued" ? "3" : "6"),
            nextPage: null,
          })),
        ),
      ),
      paginationComplete: true,
      digest: digest("4"),
    },
    production: {
      complete: true,
      ...production,
      consensusDigest: productionActionConfigurationConsensusDigest(production),
    },
    references: input.references ?? [],
    capturedAt: input.capturedAt ?? at(5),
    maximumQueueLeaseWindowMs: 10_000,
  });
}

function prepared() {
  const canary = verificationStarted();
  const terminal = acceptFixedTerminalCanaryReceipt(canary, {
    attemptId: "attempt-1",
    receipt: receipt(canary),
  });
  return prepareActionReleasePromotion(terminal, {
    attemptId: "attempt-1",
    inventory: inventory(),
    configuration: overlapConfig(at(5), terminal.expectation.expectationDigest),
    preparedAt: at(6),
    validUntil: at(30),
  });
}

function recoveryOriginPrepared() {
  const state = prepared();
  const fence = { fenceId: "recovery-fence", epoch: 4n } as const;
  return Object.freeze({
    ...state,
    admissionMode: "recovery_only" as const,
    recoveryAdmissionEffect: Object.freeze({
      operation: "close_recovery_admission" as const,
      effectId: fence.fenceId,
      epoch: 20n,
      state: "verified" as const,
      currentPrimary: state.primaryRef,
      failureDigest: digest("f"),
      fenceId: fence.fenceId,
      fenceEpoch: fence.epoch,
      observationDigest: null,
      updatedAt: at(1),
    }),
    candidate: Object.freeze({
      ...state.candidate,
      originAdmissionMode: "recovery_only" as const,
      originRecoveryFence: Object.freeze(fence),
    }),
  });
}

function promotedConfig(
  known = [A.actionRef, B.actionRef],
  observedAt = at(8),
  revision = 11n,
) {
  return exactProductionActionConfiguration({
    schemaVersion: 1,
    revision,
    observedAt,
    serviceIds: ["api", "web"],
    primaryRef: B.actionRef,
    installerRef: B.actionRef,
    installer: B.installer,
    reusableWorkflowRef: B.actionRef,
    runtimeRef: B.actionRef,
    refreshActionRef: B.actionRef,
    interactionRuntimeRef: B.actionRef,
    knownRefs: known,
    isolatedCandidateAttemptId: null,
    isolatedCandidateBindingDigest: null,
  });
}

function steadyAfterPromotion() {
  const ready = prepared();
  const dispatching = beginActionReleasePromotion(ready, {
    attemptId: "attempt-1",
    reservation: {
      reservationId: "reservation-steady",
      ownerAttemptId: "attempt-1",
      receiptId: ready.receipt.receiptId,
      artifactId: ready.receipt.artifactId,
      canonicalPayloadDigest: ready.receipt.canonicalPayloadDigest,
      artifactSha256: ready.receipt.artifactSha256,
      expectationDigest: ready.receipt.expectationDigest,
      receiptIdentityDigest: terminalCanaryReceiptIdentityDigest(ready.receipt),
      reservedAt: at(7),
      epoch: ready.aggregateVersion + 1n,
    },
    effectId: "promotion-effect-steady",
    now: at(7),
  });
  return completeActionReleasePromotion(dispatching, {
    attemptId: "attempt-1",
    configuration: promotedConfig(),
    completedAt: at(9),
  });
}

function retainedAfterFirstZeroCapture() {
  let state = steadyAfterPromotion();
  const fence = {
    fenceId: "predecessor-fence",
    epoch: 1n,
    predecessorRef: A.actionRef,
    repositoryCohortRevision: 20n,
    repositoryCohortDigest: digest("1"),
    githubRepositoryIds: ["777"],
    policyRevision: 11n,
    inventoryScopeDigest: state.predecessorRetention!.inventoryScopeDigest,
    requiredWindowMs: 10_000,
    authorityEstablishedAt: at(9),
    closedAt: at(10),
  } as const;
  state = beginPredecessorAdmissionClose(state, {
    effectId: fence.fenceId,
    effectEpoch: state.aggregateVersion + 1n,
    fenceId: fence.fenceId,
    fenceEpoch: fence.epoch,
    startedAt: fence.closedAt,
  });
  state = recordPredecessorAdmissionFence(state, fence);
  const first = zeroPredecessorReferenceCapture({
    inventory: inventory({
      capturedAt: at(11),
      snapshot: "snapshot-first",
      productionRelease: B,
    }),
    predecessorRef: A.actionRef,
    successorRef: B.actionRef,
    expectedInstaller: B.installer,
    expectedServiceIds: ["api", "web"],
    fence,
    observedNow: at(12),
    maximumCaptureAgeMs: 30_000,
  });
  return recordPredecessorZeroCapture(state, first);
}

class MemoryRepository implements ActionReleaseRolloutRepositoryPort {
  readonly receiptIds = new Set<string>();
  readonly artifactIds = new Set<string>();
  readonly artifactOwners = new Map<string, string>();
  readonly artifactDigests = new Map<string, Sha256>();
  readonly attemptArtifacts = new Map<string, string>();
  readonly consumedReceiptIds = new Set<string>();

  constructor(public state: ActionReleaseRollout) {}

  async load() {
    return this.state;
  }

  private cas(expected: bigint, next: ActionReleaseRollout) {
    if (this.state.aggregateVersion !== expected)
      return ActionReleaseRepositoryWriteResult.Stale;
    this.state = next;
    return ActionReleaseRepositoryWriteResult.Committed;
  }

  async createCandidateCas(input: {
    expectedAggregateVersion: bigint;
    next: ActionReleaseRollout;
  }) {
    return this.cas(input.expectedAggregateVersion, input.next);
  }

  async compareAndSet(input: {
    expectedAggregateVersion: bigint;
    next: ActionReleaseRollout;
  }) {
    return this.cas(input.expectedAggregateVersion, input.next);
  }

  async beginReceiptVerificationCas(
    input: Parameters<
      ActionReleaseRolloutRepositoryPort["beginReceiptVerificationCas"]
    >[0],
  ) {
    if (this.state.aggregateVersion !== input.expectedAggregateVersion)
      return ActionReleaseRepositoryWriteResult.Stale;
    if (this.attemptArtifacts.has(input.ownerAttemptId))
      return ActionReleaseRepositoryWriteResult.AttemptConflict;
    if (this.artifactOwners.has(input.artifactId))
      return ActionReleaseRepositoryWriteResult.ArtifactConflict;
    if (
      input.effect.ownerAttemptId !== input.ownerAttemptId ||
      input.effect.locator.artifactId !== input.artifactId ||
      input.effect.locator.artifactSha256 !== input.artifactSha256
    )
      return ActionReleaseRepositoryWriteResult.ArtifactConflict;
    const result = this.cas(input.expectedAggregateVersion, input.next);
    if (result === ActionReleaseRepositoryWriteResult.Committed) {
      this.artifactOwners.set(input.artifactId, input.ownerAttemptId);
      this.artifactDigests.set(input.artifactId, input.artifactSha256);
      this.attemptArtifacts.set(input.ownerAttemptId, input.artifactId);
    }
    return result;
  }

  async attachReceiptOnceAndCas(input: {
    expectedAggregateVersion: bigint;
    receiptId: string;
    artifactId: string;
    ownerAttemptId: string;
    verificationEffectId: string;
    verificationEpoch: bigint;
    next: ActionReleaseRollout;
  }) {
    if (this.state.aggregateVersion !== input.expectedAggregateVersion)
      return ActionReleaseRepositoryWriteResult.Stale;
    if (this.receiptIds.has(input.receiptId))
      return ActionReleaseRepositoryWriteResult.ReceiptConflict;
    if (
      this.artifactIds.has(input.artifactId) ||
      this.artifactOwners.get(input.artifactId) !== input.ownerAttemptId ||
      this.attemptArtifacts.get(input.ownerAttemptId) !== input.artifactId ||
      !("receiptVerification" in this.state) ||
      this.state.receiptVerification?.effectId !== input.verificationEffectId ||
      this.state.receiptVerification.epoch !== input.verificationEpoch
    )
      return ActionReleaseRepositoryWriteResult.ArtifactConflict;
    const result = this.cas(input.expectedAggregateVersion, input.next);
    if (result === ActionReleaseRepositoryWriteResult.Committed) {
      this.receiptIds.add(input.receiptId);
      this.artifactIds.add(input.artifactId);
    }
    return result;
  }

  async consumeReceiptAndBeginPromotionCas(input: {
    expectedAggregateVersion: bigint;
    receiptId: string;
    artifactId: string;
    ownerAttemptId: string;
    reservation: Parameters<
      typeof beginActionReleasePromotion
    >[1]["reservation"];
    next: Parameters<
      ActionReleaseRolloutRepositoryPort["consumeReceiptAndBeginPromotionCas"]
    >[0]["next"];
  }) {
    void input.ownerAttemptId;
    void input.reservation;
    if (this.consumedReceiptIds.has(input.receiptId))
      return ActionReleaseRepositoryWriteResult.ReceiptAlreadyConsumed;
    const result = this.cas(input.expectedAggregateVersion, input.next);
    if (result === ActionReleaseRepositoryWriteResult.Committed)
      this.consumedReceiptIds.add(input.receiptId);
    return result;
  }
}

const digestPort: ActionReleaseDigestPort = {
  digestCanonical: (value) => sha256(`sha256:${sha256Canonical(value)}`),
  digestBytes: (value) =>
    sha256(`sha256:${createHash("sha256").update(value).digest("hex")}`),
};

const fixedClock = (value: string) => ({ now: () => value });

function abortHarness(state: ActionReleaseRollout) {
  const repository = new MemoryRepository(state);
  const now = vi.fn(() => at(10));
  const compareAndSet = vi.spyOn(repository, "compareAndSet");
  return {
    repository,
    now,
    compareAndSet,
    useCase: new AbortActionReleaseCandidate({
      repository,
      clock: { now },
    }),
  };
}

const receiptVerificationPorts = {
  digest: digestPort,
  id: { nextId: () => "receipt-verification-effect" },
  verificationLeaseMs: 2_000,
};

const allowEligibility = {
  authorizeExactSelection: async (input: {
    selectionDigest: Sha256;
    contextDigest: Sha256;
    expectedChannelVersion: bigint;
    expectedPolicyRevision: bigint;
  }) => {
    const policyRevision = input.expectedPolicyRevision;
    const decisionDigest = digestPort.digestCanonical({
      allowed: true,
      policyRevision: policyRevision.toString(),
      channelVersion: input.expectedChannelVersion.toString(),
      selectionDigest: input.selectionDigest,
      contextDigest: input.contextDigest,
    });
    return {
      allowed: true,
      policyRevision,
      channelVersion: input.expectedChannelVersion,
      selectionDigest: input.selectionDigest,
      contextDigest: input.contextDigest,
      decisionDigest,
    } as const;
  },
};

describe("Action release application CAS and receipt protocol", () => {
  it("allows exactly one candidate registration CAS winner and reports the stale loser", async () => {
    const repository = new MemoryRepository(
      createSteadyActionReleaseRollout({
        primaryRef: A.actionRef,
        channelVersion: 1n,
      }),
    );
    let id = 0;
    const useCase = new RegisterActionReleaseCandidate({
      repository,
      clock: fixedClock(at(0)),
      id: { nextId: () => `attempt-${++id}` },
    });
    const [first, second] = await Promise.allSettled([
      useCase.execute({
        expectedAggregateVersion: 1n,
        candidateRelease: B,
        policyRevision: 11n,
      }),
      useCase.execute({
        expectedAggregateVersion: 1n,
        candidateRelease: B,
        policyRevision: 11n,
      }),
    ]);
    expect([first.status, second.status].sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    const rejected =
      first.status === "rejected"
        ? first.reason
        : second.status === "rejected"
          ? second.reason
          : null;
    expect(rejected).toMatchObject({
      code: "action_release_rollout_stale_version",
    });
  });

  it("persists an overlap effect permit before exact provider staging", async () => {
    const candidate = registered();
    const repository = new MemoryRepository(candidate);
    const stageAdditiveOverlap = vi.fn(async (input: { effectId: string }) => {
      expect(repository.state.phase).toBe("candidate_registered");
      if (repository.state.phase !== "candidate_registered")
        throw new Error("overlap_intent_missing");
      expect(repository.state.overlapEffect).toMatchObject({
        effectId: input.effectId,
        state: "dispatching",
      });
      return {
        status: "exact" as const,
        configuration: overlapConfig(),
      };
    });
    const result = await new StageCandidateOverlap({
      repository,
      clock: fixedClock(at(2)),
      id: { nextId: () => "overlap-effect-exact" },
      digest: digestPort,
      production: {
        readExact: async () => preOverlapConfig(),
        stageAdditiveOverlap,
      } as never,
    }).execute({
      expectedAggregateVersion: candidate.aggregateVersion,
      attemptId: "attempt-1",
    });
    expect(result.phase).toBe("overlap_staged");
    expect(result.overlapEffect).toMatchObject({
      effectId: "overlap-effect-exact",
      state: "verified",
    });
    expect(stageAdditiveOverlap).toHaveBeenCalledTimes(1);
  });

  it("reconciles a lost overlap response without repeating the stage write", async () => {
    const candidate = registered();
    const repository = new MemoryRepository(candidate);
    const stageAdditiveOverlap = vi.fn(async () => {
      throw new Error("lost response");
    });
    const stage = new StageCandidateOverlap({
      repository,
      clock: fixedClock(at(2)),
      id: { nextId: () => "overlap-effect-lost" },
      digest: digestPort,
      production: {
        readExact: async () => preOverlapConfig(),
        stageAdditiveOverlap,
      } as never,
    });
    const uncertain = await stage.execute({
      expectedAggregateVersion: candidate.aggregateVersion,
      attemptId: "attempt-1",
    });
    expect(uncertain.phase).toBe("candidate_registered");
    expect(uncertain.overlapEffect).toMatchObject({
      effectId: "overlap-effect-lost",
      state: "uncertain",
    });
    await expect(
      stage.execute({
        expectedAggregateVersion: uncertain.aggregateVersion,
        attemptId: "attempt-1",
      }),
    ).rejects.toMatchObject({ code: "action_release_reconcile_only" });

    const reconcileAdditiveOverlap = vi.fn(async () => ({
      status: "exact" as const,
      configuration: overlapConfig(),
    }));
    const reconciled = await new ReconcileCandidateOverlap({
      repository,
      clock: fixedClock(at(3)),
      digest: digestPort,
      production: { reconcileAdditiveOverlap } as never,
    }).execute({
      expectedAggregateVersion: uncertain.aggregateVersion,
      attemptId: "attempt-1",
    });
    expect(reconciled.phase).toBe("overlap_staged");
    expect(stageAdditiveOverlap).toHaveBeenCalledTimes(1);
    expect(reconcileAdditiveOverlap).toHaveBeenCalledWith(
      expect.objectContaining({
        effect: expect.objectContaining({
          effectId: "overlap-effect-lost",
          state: "uncertain",
        }),
      }),
    );
  });

  it("keeps an exact-but-stale overlap effect reconcile-only", async () => {
    const candidate = registered();
    const repository = new MemoryRepository(candidate);
    const compareAndSet = repository.compareAndSet.bind(repository);
    let writes = 0;
    repository.compareAndSet = async (input) => {
      writes += 1;
      if (writes === 2) return ActionReleaseRepositoryWriteResult.Stale;
      return await compareAndSet(input);
    };
    const stageAdditiveOverlap = vi.fn(async () => ({
      status: "exact" as const,
      configuration: overlapConfig(),
    }));
    const stage = new StageCandidateOverlap({
      repository,
      clock: fixedClock(at(2)),
      id: { nextId: () => "overlap-effect-stale" },
      digest: digestPort,
      production: {
        readExact: async () => preOverlapConfig(),
        stageAdditiveOverlap,
      } as never,
    });
    await expect(
      stage.execute({
        expectedAggregateVersion: candidate.aggregateVersion,
        attemptId: "attempt-1",
      }),
    ).rejects.toMatchObject({ code: "action_release_rollout_stale_version" });
    expect(repository.state.phase).toBe("candidate_registered");
    if (repository.state.phase !== "candidate_registered")
      throw new Error("overlap_intent_missing");
    expect(repository.state.overlapEffect?.state).toBe("dispatching");
    await expect(
      stage.execute({
        expectedAggregateVersion: repository.state.aggregateVersion,
        attemptId: "attempt-1",
      }),
    ).rejects.toMatchObject({ code: "action_release_reconcile_only" });
    expect(stageAdditiveOverlap).toHaveBeenCalledTimes(1);

    const reconciled = await new ReconcileCandidateOverlap({
      repository,
      clock: fixedClock(at(3)),
      digest: digestPort,
      production: {
        reconcileAdditiveOverlap: async () => ({
          status: "exact" as const,
          configuration: overlapConfig(),
        }),
      } as never,
    }).execute({
      expectedAggregateVersion: repository.state.aggregateVersion,
      attemptId: "attempt-1",
    });
    expect(reconciled.phase).toBe("overlap_staged");
  });

  it("rejects a wrong attempt before any production, provisioning, receipt, or inventory call", async () => {
    const candidate = registered();
    const readExact = vi.fn();
    const stage = new StageCandidateOverlap({
      repository: new MemoryRepository(candidate),
      clock: fixedClock(at(2)),
      id: { nextId: () => "overlap-effect-wrong-attempt" },
      digest: digestPort,
      production: {
        readExact,
        stageAdditiveOverlap: vi.fn(),
      } as never,
    });
    await expect(
      stage.execute({
        expectedAggregateVersion: candidate.aggregateVersion,
        attemptId: "attempt-other",
      }),
    ).rejects.toMatchObject({ code: "action_release_attempt_conflict" });
    expect(readExact).not.toHaveBeenCalled();

    const overlap = staged();
    const getFixedTarget = vi.fn();
    const arm = new ArmAndProvisionFixedCanary({
      repository: new MemoryRepository(overlap),
      clock: fixedClock(at(3)),
      digest: digestPort,
      eligibility: {} as never,
      target: { getFixedTarget },
      provisioning: {} as never,
    });
    await expect(
      arm.execute({
        expectedAggregateVersion: overlap.aggregateVersion,
        attemptId: "attempt-other",
      }),
    ).rejects.toMatchObject({ code: "action_release_attempt_conflict" });
    expect(getFixedTarget).not.toHaveBeenCalled();

    const canary = verificationStarted();
    const verifyExact = vi.fn();
    const accept = new AcceptFixedTerminalCanaryReceipt({
      ...receiptVerificationPorts,
      repository: new MemoryRepository(canary),
      clock: fixedClock(at(4)),
      verifier: { verifyExact },
    });
    await expect(
      accept.execute({
        expectedAggregateVersion: canary.aggregateVersion,
        attemptId: "attempt-other",
        locator: {
          artifactId: "artifact-evidence-1",
          artifactSha256: digest("e"),
        },
      }),
    ).rejects.toMatchObject({ code: "action_release_attempt_conflict" });
    expect(verifyExact).not.toHaveBeenCalled();

    const terminal = acceptFixedTerminalCanaryReceipt(canary, {
      attemptId: "attempt-1",
      receipt: receipt(canary),
    });
    const captureComplete = vi.fn();
    const readPromotionConfiguration = vi.fn();
    const prepare = new PreparePromotion({
      repository: new MemoryRepository(terminal),
      clock: fixedClock(at(6)),
      maximumCaptureAgeMs: 5_000,
      preparationTtlMs: 10_000,
      inventory: { captureComplete },
      production: { readExact: readPromotionConfiguration } as never,
    });
    await expect(
      prepare.execute({
        expectedAggregateVersion: terminal.aggregateVersion,
        attemptId: "attempt-other",
      }),
    ).rejects.toMatchObject({ code: "action_release_attempt_conflict" });
    expect(captureComplete).not.toHaveBeenCalled();
    expect(readPromotionConfiguration).not.toHaveBeenCalled();
  });

  it("does not close admission for an initial steady release with no completed promotion", async () => {
    const state = createSteadyActionReleaseRollout({
      primaryRef: A.actionRef,
      channelVersion: 1n,
    });
    const closeSetupAndNewWork = vi.fn();
    const enter = new EnterRecoveryOnly({
      repository: new MemoryRepository(state),
      clock: fixedClock(at(1)),
      id: { nextId: () => "recovery-effect" },
      digest: digestPort,
      admission: { closeSetupAndNewWork } as never,
    });
    await expect(
      enter.execute({
        expectedAggregateVersion: state.aggregateVersion,
        failureDigest: digest("f"),
      }),
    ).rejects.toMatchObject({ code: "action_release_reconcile_only" });
    expect(closeSetupAndNewWork).not.toHaveBeenCalled();
  });

  it("persists recovery admission closure before dispatch and reconciles a lost response", async () => {
    const state = steadyAfterPromotion();
    const repository = new MemoryRepository(state);
    const closeSetupAndNewWork = vi.fn(async () => {
      expect(repository.state).toMatchObject({
        phase: "recovery_only",
        recoveryAdmissionEffect: { state: "dispatching" },
      });
      throw new Error("lost close response");
    });
    const entered = await new EnterRecoveryOnly({
      repository,
      clock: fixedClock(at(10)),
      id: { nextId: () => "recovery-close-effect" },
      digest: digestPort,
      admission: { closeSetupAndNewWork } as never,
    }).execute({
      expectedAggregateVersion: state.aggregateVersion,
      failureDigest: digest("f"),
    });
    expect(entered.recoveryAdmissionEffect.state).toBe("uncertain");
    expect(closeSetupAndNewWork).toHaveBeenCalledTimes(1);

    const reconcileSetupAndNewWorkClose = vi.fn(async ({ effect }) => ({
      status: "exact" as const,
      observation: {
        effectId: effect.effectId,
        effectEpoch: effect.epoch,
        fenceId: effect.fenceId,
        fenceEpoch: effect.fenceEpoch,
        currentPrimary: effect.currentPrimary,
        failureDigest: effect.failureDigest,
      },
    }));
    const reconciled = await new ReconcileRecoveryAdmission({
      repository,
      clock: fixedClock(at(11)),
      digest: digestPort,
      admission: { reconcileSetupAndNewWorkClose } as never,
    }).execute({ expectedAggregateVersion: entered.aggregateVersion });
    expect(reconciled.recoveryAdmissionEffect.state).toBe("verified");
    expect(reconcileSetupAndNewWorkClose).toHaveBeenCalledTimes(1);
    expect(closeSetupAndNewWork).toHaveBeenCalledTimes(1);
  });

  it("performs no admission mutation when the recovery checkpoint CAS loses", async () => {
    const state = steadyAfterPromotion();
    const repository = new MemoryRepository(state);
    vi.spyOn(repository, "compareAndSet").mockResolvedValue(
      ActionReleaseRepositoryWriteResult.Stale,
    );
    const closeSetupAndNewWork = vi.fn();
    await expect(
      new EnterRecoveryOnly({
        repository,
        clock: fixedClock(at(10)),
        id: { nextId: () => "recovery-close-stale" },
        digest: digestPort,
        admission: { closeSetupAndNewWork } as never,
      }).execute({
        expectedAggregateVersion: state.aggregateVersion,
        failureDigest: digest("f"),
      }),
    ).rejects.toMatchObject({ code: "action_release_rollout_stale_version" });
    expect(closeSetupAndNewWork).not.toHaveBeenCalled();
  });

  it("invokes the evidence-v4 verifier once and rejects receipt replay before invoking it again", async () => {
    const state = armed();
    const repository = new MemoryRepository(state);
    const verifyExact = vi.fn(async () => receipt(state));
    const useCase = new AcceptFixedTerminalCanaryReceipt({
      ...receiptVerificationPorts,
      repository,
      clock: fixedClock(at(4)),
      verifier: { verifyExact },
    });
    await useCase.execute({
      expectedAggregateVersion: state.aggregateVersion,
      attemptId: "attempt-1",
      locator: {
        artifactId: "artifact-evidence-1",
        artifactSha256: digest("e"),
      },
    });
    await expect(
      useCase.execute({
        expectedAggregateVersion: state.aggregateVersion,
        attemptId: "attempt-1",
        locator: {
          artifactId: "artifact-evidence-1",
          artifactSha256: digest("e"),
        },
      }),
    ).rejects.toMatchObject({ code: "action_release_rollout_stale_version" });
    expect(verifyExact).toHaveBeenCalledTimes(1);

    const secondAttempt = armed("attempt-2");
    repository.state = secondAttempt;
    const replayVerifier = vi.fn(async () =>
      receipt(secondAttempt, {
        receiptId: "receipt-1",
        artifactId: "artifact-evidence-1",
      }),
    );
    const replay = new AcceptFixedTerminalCanaryReceipt({
      ...receiptVerificationPorts,
      repository,
      clock: fixedClock(at(5)),
      verifier: { verifyExact: replayVerifier },
    });
    await expect(
      replay.execute({
        expectedAggregateVersion: secondAttempt.aggregateVersion,
        attemptId: "attempt-2",
        locator: {
          artifactId: "artifact-evidence-1",
          artifactSha256: digest("e"),
        },
      }),
    ).rejects.toMatchObject({ code: "action_release_artifact_conflict" });
    expect(replayVerifier).not.toHaveBeenCalled();

    const duplicateReceiptVerifier = vi.fn(async () =>
      receipt(secondAttempt, {
        receiptId: "receipt-1",
        artifactId: "artifact-evidence-2",
      }),
    );
    const duplicateReceipt = new AcceptFixedTerminalCanaryReceipt({
      ...receiptVerificationPorts,
      repository,
      clock: fixedClock(at(5)),
      verifier: { verifyExact: duplicateReceiptVerifier },
    });
    await expect(
      duplicateReceipt.execute({
        expectedAggregateVersion: secondAttempt.aggregateVersion,
        attemptId: "attempt-2",
        locator: {
          artifactId: "artifact-evidence-2",
          artifactSha256: digest("e"),
        },
      }),
    ).rejects.toMatchObject({ code: "action_release_receipt_conflict" });
    expect(duplicateReceiptVerifier).toHaveBeenCalledTimes(1);
  });

  it("claims an evidence artifact before concurrent verification", async () => {
    const state = armed();
    const repository = new MemoryRepository(state);
    const verifyExact = vi.fn(async () => receipt(state));
    const accept = new AcceptFixedTerminalCanaryReceipt({
      ...receiptVerificationPorts,
      repository,
      clock: fixedClock(at(4)),
      verifier: { verifyExact },
    });
    const request = {
      expectedAggregateVersion: state.aggregateVersion,
      attemptId: "attempt-1",
      locator: {
        artifactId: "artifact-evidence-1",
        artifactSha256: digest("e"),
      },
    } as const;
    const results = await Promise.allSettled([
      accept.execute(request),
      accept.execute(request),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(verifyExact).toHaveBeenCalledTimes(1);
  });

  it("atomically binds an attempt to one artifact before different-artifact concurrency", async () => {
    const state = armed();
    const repository = new MemoryRepository(state);
    const verifyExact = vi.fn(
      async (input: { readonly locator: ImmutableEvidenceArtifactLocator }) =>
        receipt(state, {
          receiptId: `receipt-${input.locator.artifactId}`,
          artifactId: input.locator.artifactId,
        }),
    );
    const accept = new AcceptFixedTerminalCanaryReceipt({
      ...receiptVerificationPorts,
      repository,
      clock: fixedClock(at(4)),
      verifier: { verifyExact },
    });
    const result = await Promise.allSettled([
      accept.execute({
        expectedAggregateVersion: state.aggregateVersion,
        attemptId: "attempt-1",
        locator: {
          artifactId: "artifact-evidence-1",
          artifactSha256: digest("e"),
        },
      }),
      accept.execute({
        expectedAggregateVersion: state.aggregateVersion,
        attemptId: "attempt-1",
        locator: {
          artifactId: "artifact-evidence-2",
          artifactSha256: digest("e"),
        },
      }),
    ]);
    expect(result.filter((item) => item.status === "fulfilled")).toHaveLength(
      1,
    );
    expect(verifyExact).toHaveBeenCalledTimes(1);
    expect(repository.attemptArtifacts.size).toBe(1);
    expect(["artifact-evidence-1", "artifact-evidence-2"]).toContain(
      repository.attemptArtifacts.get("attempt-1"),
    );
  });

  it("persists verifier uncertainty and reconciles only the same immutable tuple", async () => {
    const state = armed();
    const repository = new MemoryRepository(state);
    const acceptVerifier = vi.fn(async () => {
      throw new Error("evidence read outcome unknown");
    });
    const accept = new AcceptFixedTerminalCanaryReceipt({
      ...receiptVerificationPorts,
      repository,
      clock: fixedClock(at(4)),
      verifier: { verifyExact: acceptVerifier },
    });
    await expect(
      accept.execute({
        expectedAggregateVersion: state.aggregateVersion,
        attemptId: "attempt-1",
        locator: {
          artifactId: "artifact-evidence-1",
          artifactSha256: digest("e"),
        },
      }),
    ).rejects.toMatchObject({ code: "action_release_effect_uncertain" });
    expect(repository.state).toMatchObject({
      phase: "canary_armed",
      receiptVerification: {
        state: "uncertain",
        locator: {
          artifactId: "artifact-evidence-1",
          artifactSha256: digest("e"),
        },
      },
    });

    const uncertain = repository.state;
    if (uncertain.phase !== "canary_armed") throw new Error("test invariant");
    const reconcileVerifier = vi.fn(
      async (input: { readonly locator: ImmutableEvidenceArtifactLocator }) => {
        expect(input.locator).toEqual({
          artifactId: "artifact-evidence-1",
          artifactSha256: digest("e"),
        });
        return receipt(uncertain);
      },
    );
    const reconcile = new ReconcileFixedTerminalCanaryReceiptVerification({
      ...receiptVerificationPorts,
      repository,
      clock: fixedClock(at(5)),
      verifier: { verifyExact: reconcileVerifier },
    });
    const result = await reconcile.execute({
      expectedAggregateVersion: uncertain.aggregateVersion,
      attemptId: "attempt-1",
    });
    expect(result.receiptVerification.state).toBe("verified");
    expect(reconcileVerifier).toHaveBeenCalledTimes(1);
  });

  it("allows checkpoint reconciliation only at the dispatch lease boundary", async () => {
    const started = verificationStarted();
    const repository = new MemoryRepository(started);
    const checkpoint = started.receiptVerification;
    if (checkpoint === null) throw new Error("test invariant");
    const locator = checkpoint.locator;
    repository.artifactOwners.set(locator.artifactId, "attempt-1");
    repository.artifactDigests.set(locator.artifactId, locator.artifactSha256);
    repository.attemptArtifacts.set("attempt-1", locator.artifactId);
    const verifyExact = vi.fn(async () => receipt(started));
    const early = new ReconcileFixedTerminalCanaryReceiptVerification({
      ...receiptVerificationPorts,
      repository,
      clock: fixedClock(at(5)),
      verifier: { verifyExact },
    });
    await expect(
      early.execute({
        expectedAggregateVersion: started.aggregateVersion,
        attemptId: "attempt-1",
      }),
    ).rejects.toMatchObject({ code: "action_release_reconcile_only" });
    expect(verifyExact).not.toHaveBeenCalled();

    const atBoundary = new ReconcileFixedTerminalCanaryReceiptVerification({
      ...receiptVerificationPorts,
      repository,
      clock: fixedClock(at(6)),
      verifier: { verifyExact },
    });
    await expect(
      atBoundary.execute({
        expectedAggregateVersion: started.aggregateVersion,
        attemptId: "attempt-1",
      }),
    ).resolves.toMatchObject({
      phase: "canary_verified",
      receiptVerification: { state: "verified" },
    });
    expect(verifyExact).toHaveBeenCalledTimes(1);
  });

  it("does zero provisioning writes when the fixed numeric repository identity changes", async () => {
    const state = staged();
    const repository = new MemoryRepository(state);
    const provision = vi.fn();
    const useCase = new ArmAndProvisionFixedCanary({
      repository,
      clock: fixedClock(at(3)),
      digest: digestPort,
      eligibility: {} as never,
      target: { getFixedTarget: async () => binding().target },
      provisioning: {
        prepareFixedBinding: async () => ({
          ...binding(),
          target: { ...binding().target, githubRepositoryId: "778" },
        }),
        provision,
        reconcile: vi.fn(),
      },
    });
    await expect(
      useCase.execute({
        expectedAggregateVersion: state.aggregateVersion,
        attemptId: "attempt-1",
      }),
    ).rejects.toMatchObject({ code: "fixed_canary_target_mismatch" });
    expect(provision).not.toHaveBeenCalled();
    expect(repository.state).toBe(state);
  });

  it("persists the armed intent and exact eligibility snapshot before provisioning", async () => {
    const state = staged();
    const repository = new MemoryRepository(state);
    const provision = vi.fn(async (input: { eligibility: unknown }) => {
      expect(repository.state.phase).toBe("canary_armed");
      if (repository.state.phase !== "canary_armed")
        throw new Error("armed_state_missing");
      expect(repository.state.provisioning.state).toBe("dispatching");
      expect(input.eligibility).toEqual({
        allowed: true,
        ...repository.state.provisioning.eligibility,
      });
      return {
        expectationDigest: repository.state.expectation.expectationDigest,
      };
    });
    const arm = new ArmAndProvisionFixedCanary({
      repository,
      clock: fixedClock(at(3)),
      digest: digestPort,
      eligibility: allowEligibility,
      target: { getFixedTarget: async () => binding().target },
      provisioning: {
        prepareFixedBinding: async () => binding(),
        provision,
        reconcile: vi.fn(),
      },
    });
    const result = await arm.execute({
      expectedAggregateVersion: state.aggregateVersion,
      attemptId: "attempt-1",
    });
    expect(result.provisioning.state).toBe("verified");
    expect(result.provisioning.eligibility?.decisionDigest).toBeTruthy();
    expect(provision).toHaveBeenCalledTimes(1);
  });

  it("continues a prepared canary only after the authorization permit CAS wins", async () => {
    const preparedState = armFixedActionReleaseCanary(staged(), {
      attemptId: "attempt-1",
      binding: binding(),
    });
    const repository = new MemoryRepository(preparedState);
    const provision = vi.fn(async () => {
      expect(repository.state).toMatchObject({
        phase: "canary_armed",
        provisioning: { state: "dispatching" },
      });
      if (repository.state.phase !== "canary_armed")
        throw new Error("dispatch_permit_missing");
      return {
        expectationDigest: repository.state.expectation.expectationDigest,
      };
    });
    const useCase = new ReconcileFixedCanaryProvisioning({
      repository,
      clock: fixedClock(at(3)),
      digest: digestPort,
      eligibility: allowEligibility,
      provisioning: {
        prepareFixedBinding: async () => binding(),
        provision,
        reconcile: vi.fn(),
      },
    });
    await expect(
      useCase.execute({
        expectedAggregateVersion: preparedState.aggregateVersion,
        attemptId: "attempt-1",
      }),
    ).resolves.toMatchObject({ provisioning: { state: "verified" } });
    expect(provision).toHaveBeenCalledTimes(1);

    const staleRepository = new MemoryRepository(preparedState);
    vi.spyOn(staleRepository, "compareAndSet").mockResolvedValue(
      ActionReleaseRepositoryWriteResult.Stale,
    );
    const staleProvision = vi.fn();
    await expect(
      new ReconcileFixedCanaryProvisioning({
        repository: staleRepository,
        clock: fixedClock(at(3)),
        digest: digestPort,
        eligibility: allowEligibility,
        provisioning: {
          prepareFixedBinding: async () => binding(),
          provision: staleProvision,
          reconcile: vi.fn(),
        },
      }).execute({
        expectedAggregateVersion: preparedState.aggregateVersion,
        attemptId: "attempt-1",
      }),
    ).rejects.toMatchObject({ code: "action_release_rollout_stale_version" });
    expect(staleProvision).not.toHaveBeenCalled();
  });

  it("reconciles an uncertain fixed-canary provisioning effect without another write", async () => {
    const state = staged();
    const repository = new MemoryRepository(state);
    const provision = vi.fn(async () => {
      throw new Error("lost provisioning response");
    });
    const reconcile = vi.fn(async () => {
      if (repository.state.phase !== "canary_armed")
        throw new Error("armed_state_missing");
      return {
        status: "exact" as const,
        expectationDigest: repository.state.expectation.expectationDigest,
      };
    });
    const authorizeExactSelection = vi.fn(
      allowEligibility.authorizeExactSelection,
    );
    const eligibility = { authorizeExactSelection };
    const provisioning = {
      prepareFixedBinding: async () => binding(),
      provision,
      reconcile,
    };
    const arm = new ArmAndProvisionFixedCanary({
      repository,
      clock: fixedClock(at(3)),
      digest: digestPort,
      eligibility,
      target: { getFixedTarget: async () => binding().target },
      provisioning,
    });
    await expect(
      arm.execute({
        expectedAggregateVersion: state.aggregateVersion,
        attemptId: "attempt-1",
      }),
    ).rejects.toMatchObject({ code: "action_release_effect_uncertain" });
    expect(repository.state).toMatchObject({
      phase: "canary_armed",
      provisioning: { state: "uncertain" },
    });
    const uncertainVersion = repository.state.aggregateVersion;
    const result = await new ReconcileFixedCanaryProvisioning({
      repository,
      clock: fixedClock(at(4)),
      digest: digestPort,
      eligibility,
      provisioning,
    }).execute({
      expectedAggregateVersion: uncertainVersion,
      attemptId: "attempt-1",
    });
    expect(result.provisioning.state).toBe("verified");
    expect(provision).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(authorizeExactSelection).toHaveBeenCalledTimes(1);
  });

  it("rejects a mismatched eligibility context before the policy adapter", async () => {
    const state = armed();
    const repository = new MemoryRepository(state);
    const authorizeExactSelection = vi.fn(
      allowEligibility.authorizeExactSelection,
    );
    const resolver = new ResolveActionReleaseSelection({
      repository,
      digest: digestPort,
      eligibility: { authorizeExactSelection },
    });
    await expect(
      resolver.isolatedCandidate({
        expectedAggregateVersion: state.aggregateVersion,
        context: {
          schemaVersion: 5,
          rolloutAttemptId: state.candidate.attemptId,
          policyRevision: state.candidate.policyRevision,
          githubRepositoryId: state.canary.target.githubRepositoryId,
          githubRepositoryNodeId: state.canary.target.githubRepositoryNodeId,
          repositoryFullName: state.canary.target.repositoryFullName,
          providerInstanceId: state.canary.target.providerInstanceId,
          pullRequestNumber: state.canary.target.pullRequestNumber,
          reviewedHeadSha: state.canary.reviewedHeadSha,
          namespaceId: state.canary.namespaceId,
          namespaceEpoch: state.canary.namespaceEpoch,
          challengeSha256: state.canary.challengeSha256,
          reviewWorkflowPath: state.canary.target.reviewWorkflowPath,
          interactionWorkflowPath: state.canary.target.interactionWorkflowPath,
          reviewSource: state.canary.reviewSource,
          interactionSource: state.canary.interactionSource,
          bindingDigest: state.canary.bindingDigest,
        },
        eligibilityContext: {
          githubRepositoryId: "778",
          repositoryFullName: state.canary.target.repositoryFullName,
          providerInstanceId: state.canary.target.providerInstanceId,
          namespaceId: state.canary.namespaceId,
          namespaceEpoch: state.canary.namespaceEpoch,
          workflowSourceDigest: state.canary.bindingDigest,
        },
      }),
    ).rejects.toMatchObject({ code: "action_release_eligibility_rejected" });
    expect(authorizeExactSelection).not.toHaveBeenCalled();
  });

  it("authorizes primary and attested A while generic candidate B stays isolated", async () => {
    const state = staged();
    const authorizeExactSelection = vi.fn(
      allowEligibility.authorizeExactSelection,
    );
    const resolver = new ResolveActionReleaseSelection({
      repository: new MemoryRepository(state),
      digest: digestPort,
      eligibility: { authorizeExactSelection },
    });
    const production = await resolver.production({
      expectedAggregateVersion: state.aggregateVersion,
      expectedPolicyRevision: 11n,
      context: {
        githubRepositoryId: "777",
        repositoryFullName: "777genius/review-router-saas-e2e",
        providerInstanceId: "provider-fixed",
        namespaceId: null,
        namespaceEpoch: null,
        workflowSourceDigest: digest("a"),
      },
    });
    expect(production.selection).toMatchObject({
      kind: "production_primary",
      actionRef: A.actionRef,
    });

    const attestation = {
      actionRef: A.actionRef,
      namespaceId: "already-attested-a",
      namespaceEpoch: 1n,
      workflowSourceDigest: digest("b"),
    } as const;
    const eligibilityContext = {
      githubRepositoryId: "777",
      repositoryFullName: "777genius/review-router-saas-e2e",
      providerInstanceId: "provider-fixed",
      namespaceId: attestation.namespaceId,
      namespaceEpoch: attestation.namespaceEpoch,
      workflowSourceDigest: attestation.workflowSourceDigest,
    } as const;
    const attested = await resolver.attestedLiveNamespace({
      expectedAggregateVersion: state.aggregateVersion,
      expectedPolicyRevision: 11n,
      attestation,
      eligibilityContext,
    });
    expect(attested.selection).toMatchObject({
      kind: "attested_live_namespace",
      actionRef: A.actionRef,
    });
    await expect(
      resolver.attestedLiveNamespace({
        expectedAggregateVersion: state.aggregateVersion,
        expectedPolicyRevision: 11n,
        attestation: { ...attestation, actionRef: B.actionRef },
        eligibilityContext,
      }),
    ).rejects.toThrow("action_release_selection_rejected");
    expect(authorizeExactSelection).toHaveBeenCalledTimes(2);
  });

  it("fails closed on partial inventory and stale complete captures without advancing state", async () => {
    const canary = verificationStarted();
    const state = acceptFixedTerminalCanaryReceipt(canary, {
      attemptId: "attempt-1",
      receipt: receipt(canary),
    });
    const repository = new MemoryRepository(state);
    const partial = new PreparePromotion({
      repository,
      clock: fixedClock(at(10)),
      maximumCaptureAgeMs: 2_000,
      preparationTtlMs: 10_000,
      inventory: {
        captureComplete: async () => {
          throw new Error("inventory_partial");
        },
      },
      production: {
        readExact: async () => overlapConfig(at(10)),
      } as never,
    });
    await expect(
      partial.execute({
        expectedAggregateVersion: state.aggregateVersion,
        attemptId: "attempt-1",
      }),
    ).rejects.toThrow("inventory_partial");
    expect(repository.state).toBe(state);

    const stale = new PreparePromotion({
      repository,
      clock: fixedClock(at(20)),
      maximumCaptureAgeMs: 2_000,
      preparationTtlMs: 10_000,
      inventory: {
        captureComplete: async () => inventory({ capturedAt: at(5) }),
      },
      production: {
        readExact: async () => overlapConfig(at(5)),
      } as never,
    });
    await expect(
      stale.execute({
        expectedAggregateVersion: state.aggregateVersion,
        attemptId: "attempt-1",
      }),
    ).rejects.toMatchObject({
      code: "live_action_reference_inventory_stale",
    });

    const staleDatabaseSnapshot = new PreparePromotion({
      repository,
      clock: fixedClock(at(20)),
      maximumCaptureAgeMs: 2_000,
      preparationTtlMs: 10_000,
      inventory: {
        captureComplete: async () =>
          inventory({ capturedAt: at(19), databaseServerTime: at(5) }),
      },
      production: {
        readExact: async () =>
          overlapConfig(at(19), state.expectation.expectationDigest),
      } as never,
    });
    await expect(
      staleDatabaseSnapshot.execute({
        expectedAggregateVersion: state.aggregateVersion,
        attemptId: "attempt-1",
      }),
    ).rejects.toMatchObject({
      code: "live_action_reference_inventory_stale",
    });
    expect(repository.state).toBe(state);
  });

  it("prepares promotion from one exact fresh inventory/configuration snapshot and CAS", async () => {
    const canary = verificationStarted();
    const state = acceptFixedTerminalCanaryReceipt(canary, {
      attemptId: "attempt-1",
      receipt: receipt(canary),
    });
    const repository = new MemoryRepository(state);
    const captureComplete = vi.fn(async () => inventory({ capturedAt: at(5) }));
    const readExact = vi.fn(async () =>
      overlapConfig(at(5), state.expectation.expectationDigest),
    );
    const result = await new PreparePromotion({
      repository,
      clock: fixedClock(at(6)),
      maximumCaptureAgeMs: 2_000,
      preparationTtlMs: 10_000,
      inventory: { captureComplete },
      production: { readExact } as never,
    }).execute({
      expectedAggregateVersion: state.aggregateVersion,
      attemptId: "attempt-1",
    });

    expect(result.phase).toBe("promotion_prepared");
    expect(result.aggregateVersion).toBe(state.aggregateVersion + 1n);
    expect(result.preparation).toMatchObject({
      preparedAt: at(6),
      validUntil: at(16),
      configurationRevision: 10n,
    });
    expect(repository.state).toBe(result);
    expect(captureComplete).toHaveBeenCalledTimes(1);
    expect(readExact).toHaveBeenCalledTimes(1);
  });

  it("persists Promoting before dispatch, turns a lost response uncertain, and reconciles without a blind retry", async () => {
    const state = prepared();
    const repository = new MemoryRepository(state);
    repository.receiptIds.add(state.receipt.receiptId);
    repository.artifactIds.add(state.receipt.artifactId);
    let nextId = 0;
    const promotePrimary = vi.fn(async () => {
      expect(repository.state.phase).toBe("promoting");
      throw new Error("lost response");
    });
    const promote = new PromoteActionReleaseCandidate({
      repository,
      clock: fixedClock(at(7)),
      id: { nextId: (kind) => `${kind}-${++nextId}` },
      digest: digestPort,
      production: { promotePrimary } as never,
      admission: {} as never,
    });
    const uncertain = await promote.execute({
      expectedAggregateVersion: state.aggregateVersion,
      attemptId: "attempt-1",
    });
    expect(uncertain.phase).toBe("promotion_uncertain");
    expect(repository.consumedReceiptIds).toEqual(new Set(["receipt-1"]));
    await expect(
      promote.execute({
        expectedAggregateVersion: uncertain.aggregateVersion,
        attemptId: "attempt-1",
      }),
    ).rejects.toMatchObject({ code: "action_release_reconcile_only" });
    expect(promotePrimary).toHaveBeenCalledTimes(1);

    const reconcile = new ReconcilePromotion({
      repository,
      clock: fixedClock(at(9)),
      id: { nextId: () => "reconcile-effect" },
      digest: digestPort,
      production: {
        reconcilePromotion: async () => ({
          status: "completed",
          configuration: promotedConfig(),
        }),
      } as never,
      admission: {} as never,
    });
    const complete = await reconcile.execute({
      expectedAggregateVersion: uncertain.aggregateVersion,
      attemptId: "attempt-1",
    });
    expect(complete.phase).toBe("steady");
    expect(complete.primaryRef).toEqual(B.actionRef);
  });

  it("checkpoints recovery admission reopening and reconciles it without replaying promotion", async () => {
    const state = recoveryOriginPrepared();
    const repository = new MemoryRepository(state);
    repository.receiptIds.add(state.receipt.receiptId);
    repository.artifactIds.add(state.receipt.artifactId);
    let clockCalls = 0;
    let ids = 0;
    const promotePrimary = vi.fn(async () => ({
      status: "exact" as const,
      configuration: promotedConfig(),
    }));
    const reopenSetupAndNewWork = vi.fn(async () => {
      expect(repository.state).toMatchObject({
        phase: "promotion_uncertain",
        recoveryAdmissionEffect: {
          operation: "reopen_recovery_admission",
          state: "dispatching",
        },
      });
      throw new Error("lost reopen response");
    });
    const uncertain = await new PromoteActionReleaseCandidate({
      repository,
      clock: {
        now: () => (clockCalls++ === 0 ? at(7) : at(9)),
      },
      id: { nextId: (kind) => `${kind}-${++ids}` },
      digest: digestPort,
      production: { promotePrimary } as never,
      admission: { reopenSetupAndNewWork } as never,
    }).execute({
      expectedAggregateVersion: state.aggregateVersion,
      attemptId: "attempt-1",
    });
    expect(uncertain.phase).toBe("promotion_uncertain");
    expect(uncertain.recoveryAdmissionEffect).toMatchObject({
      operation: "reopen_recovery_admission",
      state: "uncertain",
    });

    const reconcilePromotion = vi.fn();
    const reconcileSetupAndNewWorkReopen = vi.fn(async ({ effect }) => ({
      status: "exact" as const,
      observation: {
        effectId: effect.effectId,
        effectEpoch: effect.epoch,
        fenceId: effect.fenceId,
        fenceEpoch: effect.fenceEpoch,
        ownerAttemptId: effect.ownerAttemptId,
        promotedPrimary: effect.promotedPrimary,
        configurationDigest: effect.promotedConfiguration.configurationDigest,
        openedEpoch: effect.fenceEpoch + 1n,
      },
    }));
    const complete = await new ReconcilePromotion({
      repository,
      clock: fixedClock(at(10)),
      id: { nextId: () => "unused-reconcile-effect" },
      digest: digestPort,
      production: { reconcilePromotion } as never,
      admission: { reconcileSetupAndNewWorkReopen } as never,
    }).execute({
      expectedAggregateVersion: uncertain.aggregateVersion,
      attemptId: "attempt-1",
    });
    expect(complete.phase).toBe("steady");
    expect(complete.primaryRef).toEqual(B.actionRef);
    expect(promotePrimary).toHaveBeenCalledTimes(1);
    expect(reopenSetupAndNewWork).toHaveBeenCalledTimes(1);
    expect(reconcileSetupAndNewWorkReopen).toHaveBeenCalledTimes(1);
    expect(reconcilePromotion).not.toHaveBeenCalled();
  });

  it("enters local RecoveryOnly before closing admission after a promoted failure", async () => {
    const ready = prepared();
    const promoting = beginActionReleasePromotion(ready, {
      attemptId: "attempt-1",
      reservation: {
        reservationId: "reservation-failed-production",
        ownerAttemptId: "attempt-1",
        receiptId: ready.receipt.receiptId,
        artifactId: ready.receipt.artifactId,
        canonicalPayloadDigest: ready.receipt.canonicalPayloadDigest,
        artifactSha256: ready.receipt.artifactSha256,
        expectationDigest: ready.receipt.expectationDigest,
        receiptIdentityDigest: terminalCanaryReceiptIdentityDigest(
          ready.receipt,
        ),
        reservedAt: at(7),
        epoch: ready.aggregateVersion + 1n,
      },
      effectId: "promotion-effect-failed-production",
      now: at(7),
    });
    const uncertain = markActionReleasePromotionUncertain(promoting, {
      attemptId: "attempt-1",
      observationDigest: digest("f"),
      observedAt: at(8),
    });
    const repository = new MemoryRepository(uncertain);
    const closeSetupAndNewWork = vi.fn(async ({ effect }) => {
      expect(repository.state).toMatchObject({
        phase: "recovery_only",
        primaryRef: B.actionRef,
        recoveryAdmissionEffect: { state: "dispatching" },
      });
      return {
        status: "exact" as const,
        observation: {
          effectId: effect.effectId,
          effectEpoch: effect.epoch,
          fenceId: effect.fenceId,
          fenceEpoch: effect.fenceEpoch,
          currentPrimary: effect.currentPrimary,
          failureDigest: effect.failureDigest,
        },
      };
    });
    const recovery = await new ReconcilePromotion({
      repository,
      clock: fixedClock(at(9)),
      id: { nextId: () => "promoted-failure-close" },
      digest: digestPort,
      production: {
        reconcilePromotion: async () => ({
          status: "promoted_failure",
          failureDigest: digest("d"),
          configuration: promotedConfig(),
        }),
      } as never,
      admission: { closeSetupAndNewWork } as never,
    }).execute({
      expectedAggregateVersion: uncertain.aggregateVersion,
      attemptId: "attempt-1",
    });
    expect(recovery.phase).toBe("recovery_only");
    if (recovery.phase !== "recovery_only") throw new Error("test invariant");
    expect(recovery.recoveryAdmissionEffect.state).toBe("verified");
    expect(closeSetupAndNewWork).toHaveBeenCalledTimes(1);
  });

  it("allows exactly one concurrent promotion to reserve the one-shot receipt", async () => {
    const state = prepared();
    const repository = new MemoryRepository(state);
    repository.receiptIds.add(state.receipt.receiptId);
    repository.artifactIds.add(state.receipt.artifactId);
    let clockCalls = 0;
    let ids = 0;
    const promotePrimary = vi.fn(async () => ({
      status: "exact" as const,
      configuration: promotedConfig(),
    }));
    const promote = new PromoteActionReleaseCandidate({
      repository,
      clock: {
        now: () => (clockCalls++ < 2 ? at(7) : at(9)),
      },
      id: { nextId: (kind) => `${kind}-${++ids}` },
      digest: digestPort,
      production: { promotePrimary } as never,
      admission: {} as never,
    });
    const results = await Promise.allSettled([
      promote.execute({
        expectedAggregateVersion: state.aggregateVersion,
        attemptId: "attempt-1",
      }),
      promote.execute({
        expectedAggregateVersion: state.aggregateVersion,
        attemptId: "attempt-1",
      }),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(promotePrimary).toHaveBeenCalledTimes(1);
    expect(repository.consumedReceiptIds).toEqual(new Set(["receipt-1"]));
  });

  it("persists an exact candidate abort through CAS", async () => {
    const state = registered();
    const { repository, now, compareAndSet, useCase } = abortHarness(state);
    const result = await useCase.execute({
      expectedAggregateVersion: state.aggregateVersion,
      attemptId: "attempt-1",
      reasonDigest: digest("a"),
    });

    expect(result).toMatchObject({
      phase: "candidate_aborted",
      aggregateVersion: state.aggregateVersion + 1n,
      primaryRef: A.actionRef,
      abortedAt: at(10),
      abortReasonDigest: digest("a"),
      abortedCandidate: { attemptId: "attempt-1" },
    });
    expect(repository.state).toBe(result);
    expect(compareAndSet).toHaveBeenCalledWith({
      expectedAggregateVersion: state.aggregateVersion,
      next: result,
    });
    expect(now).toHaveBeenCalledTimes(1);
  });

  it("rejects stale, wrong-attempt, lost-CAS, and post-promotion aborts without mutation", async () => {
    const state = registered();
    const stale = abortHarness(state);
    await expect(
      stale.useCase.execute({
        expectedAggregateVersion: state.aggregateVersion - 1n,
        attemptId: "attempt-1",
        reasonDigest: digest("a"),
      }),
    ).rejects.toMatchObject({
      code: "action_release_rollout_stale_version",
    });
    expect(stale.compareAndSet).not.toHaveBeenCalled();
    expect(stale.now).not.toHaveBeenCalled();

    const wrongAttempt = abortHarness(state);
    await expect(
      wrongAttempt.useCase.execute({
        expectedAggregateVersion: state.aggregateVersion,
        attemptId: "attempt-other",
        reasonDigest: digest("a"),
      }),
    ).rejects.toMatchObject({ code: "action_release_attempt_conflict" });
    expect(wrongAttempt.compareAndSet).not.toHaveBeenCalled();
    expect(wrongAttempt.now).not.toHaveBeenCalled();

    const casLoser = abortHarness(state);
    casLoser.compareAndSet.mockResolvedValue(
      ActionReleaseRepositoryWriteResult.Stale,
    );
    await expect(
      casLoser.useCase.execute({
        expectedAggregateVersion: state.aggregateVersion,
        attemptId: "attempt-1",
        reasonDigest: digest("a"),
      }),
    ).rejects.toMatchObject({
      code: "action_release_rollout_stale_version",
    });
    expect(casLoser.repository.state).toBe(state);

    const promoted = steadyAfterPromotion();
    const afterPromotion = abortHarness(promoted);
    await expect(
      afterPromotion.useCase.execute({
        expectedAggregateVersion: promoted.aggregateVersion,
        attemptId: "attempt-1",
        reasonDigest: digest("a"),
      }),
    ).rejects.toMatchObject({ code: "action_release_reconcile_only" });
    expect(afterPromotion.compareAndSet).not.toHaveBeenCalled();
    expect(afterPromotion.now).not.toHaveBeenCalled();
  });

  it("reports stale retention version before rejecting a non-retaining phase", async () => {
    const state = registered();
    const repository = new MemoryRepository(state);
    await expect(
      new ReconcilePredecessorRetention({
        repository,
        clock: fixedClock(at(10)),
        id: { nextId: () => "unused-effect" },
        digest: digestPort,
        maximumCaptureAgeMs: 30_000,
        inventory: {} as never,
        admission: {} as never,
        production: {} as never,
      }).execute({
        expectedAggregateVersion: state.aggregateVersion - 1n,
      }),
    ).rejects.toMatchObject({
      code: "action_release_rollout_stale_version",
    });
    expect(repository.state).toBe(state);
  });

  it("continues predecessor retention after aborting a fresh A reintroduction", async () => {
    const promoted = steadyAfterPromotion();
    const reintroduction = registerActionReleaseCandidate(promoted, {
      attemptId: "attempt-return-a",
      candidateRelease: A,
      policyRevision: 12n,
      registeredAt: at(10),
    });
    const repository = new MemoryRepository(reintroduction);
    const aborted = await new AbortActionReleaseCandidate({
      repository,
      clock: fixedClock(at(11)),
    }).execute({
      expectedAggregateVersion: reintroduction.aggregateVersion,
      attemptId: "attempt-return-a",
      reasonDigest: digest("a"),
    });
    const closePredecessorAdmission = vi.fn(
      async (command: PredecessorAdmissionCloseCommand) => ({
        status: "exact" as const,
        observation: {
          fenceId: command.effect.fenceId,
          epoch: command.effect.fenceEpoch,
          predecessorRef: command.predecessorRef,
          repositoryCohortRevision: command.repositoryCohortRevision,
          repositoryCohortDigest: command.repositoryCohortDigest,
          githubRepositoryIds: command.githubRepositoryIds,
          policyRevision: command.policyRevision,
          inventoryScopeDigest: command.inventoryScopeDigest,
          requiredWindowMs: command.requiredWindowMs,
          authorityEstablishedAt: command.authorityEstablishedAt,
          closedAt: at(12),
        },
      }),
    );
    const fenced = await new ReconcilePredecessorRetention({
      repository,
      clock: fixedClock(at(12)),
      id: { nextId: () => "aborted-predecessor-close" },
      digest: digestPort,
      maximumCaptureAgeMs: 30_000,
      inventory: {} as never,
      admission: { closePredecessorAdmission } as never,
      production: {} as never,
    }).execute({ expectedAggregateVersion: aborted.aggregateVersion });

    expect(fenced.phase).toBe("candidate_aborted");
    expect(fenced.predecessorRetention?.fence).not.toBeNull();
    expect(closePredecessorAdmission).toHaveBeenCalledTimes(1);
  });

  it("binds predecessor admission closure to the exact retained cohort", async () => {
    const ready = prepared();
    const dispatching = beginActionReleasePromotion(ready, {
      attemptId: "attempt-1",
      reservation: {
        reservationId: "reservation-fence",
        ownerAttemptId: "attempt-1",
        receiptId: ready.receipt.receiptId,
        artifactId: ready.receipt.artifactId,
        canonicalPayloadDigest: ready.receipt.canonicalPayloadDigest,
        artifactSha256: ready.receipt.artifactSha256,
        expectationDigest: ready.receipt.expectationDigest,
        receiptIdentityDigest: terminalCanaryReceiptIdentityDigest(
          ready.receipt,
        ),
        reservedAt: at(7),
        epoch: ready.aggregateVersion + 1n,
      },
      effectId: "promotion-effect-fence",
      now: at(7),
    });
    const state = completeActionReleasePromotion(dispatching, {
      attemptId: "attempt-1",
      configuration: promotedConfig(),
      completedAt: at(9),
    });
    const repository = new MemoryRepository(state);
    const closePredecessorAdmission = vi.fn(async (input) => {
      expect(
        repository.state.predecessorRetention?.admissionEffect,
      ).toMatchObject({
        effectId: input.effect.effectId,
        state: "dispatching",
      });
      return {
        status: "exact" as const,
        observation: {
          fenceId: input.effect.fenceId,
          epoch: input.effect.fenceEpoch,
          predecessorRef: input.predecessorRef,
          repositoryCohortRevision: input.repositoryCohortRevision,
          repositoryCohortDigest: input.repositoryCohortDigest,
          githubRepositoryIds: input.githubRepositoryIds,
          policyRevision: input.policyRevision,
          inventoryScopeDigest: input.inventoryScopeDigest,
          requiredWindowMs: input.requiredWindowMs,
          authorityEstablishedAt: input.authorityEstablishedAt,
          closedAt: at(10),
        },
      };
    });
    const useCase = new ReconcilePredecessorRetention({
      repository,
      clock: fixedClock(at(10)),
      id: { nextId: () => "unused-effect" },
      digest: digestPort,
      maximumCaptureAgeMs: 30_000,
      inventory: {} as never,
      admission: { closePredecessorAdmission } as never,
      production: {} as never,
    });
    const fenced = await useCase.execute({
      expectedAggregateVersion: state.aggregateVersion,
    });
    expect(fenced.predecessorRetention?.fence).not.toBeNull();
    expect(closePredecessorAdmission).toHaveBeenCalledWith({
      effect: expect.objectContaining({
        effectId: "unused-effect",
        state: "dispatching",
      }),
      predecessorRef: A.actionRef,
      successorRef: B.actionRef,
      promotionAttemptId: "attempt-1",
      repositoryCohortRevision: 20n,
      repositoryCohortDigest: digest("1"),
      githubRepositoryIds: ["777"],
      policyRevision: 11n,
      inventoryScopeDigest: state.predecessorRetention!.inventoryScopeDigest,
      requiredWindowMs: 10_000,
      authorityEstablishedAt: at(9),
    });

    const mismatchRepository = new MemoryRepository(state);
    const mismatch = await new ReconcilePredecessorRetention({
      repository: mismatchRepository,
      clock: fixedClock(at(10)),
      id: { nextId: () => "unused-effect" },
      digest: digestPort,
      maximumCaptureAgeMs: 30_000,
      inventory: {} as never,
      admission: {
        closePredecessorAdmission: async (
          command: PredecessorAdmissionCloseCommand,
        ) => ({
          status: "exact",
          observation: {
            fenceId: command.effect.fenceId,
            epoch: command.effect.fenceEpoch,
            predecessorRef: A.actionRef,
            repositoryCohortRevision: 20n,
            repositoryCohortDigest: digest("f"),
            githubRepositoryIds: ["777"],
            policyRevision: 11n,
            inventoryScopeDigest: command.inventoryScopeDigest,
            requiredWindowMs: 10_000,
            authorityEstablishedAt: at(9),
            closedAt: at(10),
          },
        }),
      } as never,
      production: {} as never,
    }).execute({ expectedAggregateVersion: state.aggregateVersion });
    expect(mismatch.predecessorRetention?.fence).toBeNull();
    expect(mismatch.predecessorRetention?.admissionEffect?.state).toBe(
      "uncertain",
    );
    const reconcilePredecessorAdmission = vi.fn(
      async (command: PredecessorAdmissionCloseCommand) => ({
        status: "exact" as const,
        observation: {
          fenceId: command.effect.fenceId,
          epoch: command.effect.fenceEpoch,
          predecessorRef: command.predecessorRef,
          repositoryCohortRevision: command.repositoryCohortRevision,
          repositoryCohortDigest: command.repositoryCohortDigest,
          githubRepositoryIds: command.githubRepositoryIds,
          policyRevision: command.policyRevision,
          inventoryScopeDigest: command.inventoryScopeDigest,
          requiredWindowMs: command.requiredWindowMs,
          authorityEstablishedAt: command.authorityEstablishedAt,
          closedAt: at(11),
        },
      }),
    );
    const reconciled = await new ReconcilePredecessorRetention({
      repository: mismatchRepository,
      clock: fixedClock(at(11)),
      id: { nextId: () => "must-not-create-another-effect" },
      digest: digestPort,
      maximumCaptureAgeMs: 30_000,
      inventory: {} as never,
      admission: { reconcilePredecessorAdmission } as never,
      production: {} as never,
    }).execute({ expectedAggregateVersion: mismatch.aggregateVersion });
    expect(reconciled.predecessorRetention?.fence).not.toBeNull();
    expect(reconcilePredecessorAdmission).toHaveBeenCalledTimes(1);
  });

  it("performs no predecessor admission mutation when its checkpoint CAS loses", async () => {
    const state = steadyAfterPromotion();
    const repository = new MemoryRepository(state);
    vi.spyOn(repository, "compareAndSet").mockResolvedValue(
      ActionReleaseRepositoryWriteResult.Stale,
    );
    const closePredecessorAdmission = vi.fn();
    await expect(
      new ReconcilePredecessorRetention({
        repository,
        clock: fixedClock(at(10)),
        id: { nextId: () => "predecessor-close-stale" },
        digest: digestPort,
        maximumCaptureAgeMs: 30_000,
        inventory: {} as never,
        admission: { closePredecessorAdmission } as never,
        production: {} as never,
      }).execute({ expectedAggregateVersion: state.aggregateVersion }),
    ).rejects.toMatchObject({ code: "action_release_rollout_stale_version" });
    expect(closePredecessorAdmission).not.toHaveBeenCalled();
  });

  it("gives one predecessor-removal racer the CAS/effect permit and leaves no rollback path", async () => {
    const state = retainedAfterFirstZeroCapture();
    const repository = new MemoryRepository(state);
    const removePredecessor = vi.fn(async () => ({
      status: "exact" as const,
      configuration: promotedConfig([B.actionRef], at(24), 12n),
    }));
    let effect = 0;
    const make = () =>
      new ReconcilePredecessorRetention({
        repository,
        clock: fixedClock(at(22)),
        id: { nextId: () => `removal-effect-${++effect}` },
        digest: digestPort,
        maximumCaptureAgeMs: 30_000,
        inventory: {
          captureComplete: async () =>
            inventory({
              capturedAt: at(21),
              snapshot: "snapshot-second",
              productionRelease: B,
            }),
        },
        admission: {
          assertPredecessorAdmissionClosed: async () => true,
        } as never,
        production: { removePredecessor } as never,
      });
    const results = await Promise.allSettled([
      make().execute({ expectedAggregateVersion: state.aggregateVersion }),
      make().execute({ expectedAggregateVersion: state.aggregateVersion }),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(removePredecessor).toHaveBeenCalledTimes(1);
    expect(repository.state.predecessorRetention).toBeNull();
    expect(repository.state.primaryRef).toEqual(B.actionRef);
  });

  it("reconciles one uncertain predecessor-removal effect without repeating it", async () => {
    const state = retainedAfterFirstZeroCapture();
    const repository = new MemoryRepository(state);
    const captureComplete = vi.fn(async () =>
      inventory({
        capturedAt: at(21),
        snapshot: "snapshot-second-uncertain",
        productionRelease: B,
      }),
    );
    const nextId = vi.fn(() => "removal-effect-uncertain");
    const admission = {
      assertPredecessorAdmissionClosed: async () => true,
    } as never;
    let removalCommand:
      | Parameters<ProductionActionConfigurationPort["removePredecessor"]>[0]
      | undefined;
    const removePredecessor = vi.fn(
      async (
        command: Parameters<
          ProductionActionConfigurationPort["removePredecessor"]
        >[0],
      ) => {
        removalCommand = command;
        throw new Error("lost predecessor-removal response");
      },
    );
    const uncertain = await new ReconcilePredecessorRetention({
      repository,
      clock: fixedClock(at(22)),
      id: { nextId },
      digest: digestPort,
      maximumCaptureAgeMs: 30_000,
      inventory: { captureComplete },
      admission,
      production: { removePredecessor } as never,
    }).execute({ expectedAggregateVersion: state.aggregateVersion });

    expect(uncertain.aggregateVersion).toBe(state.aggregateVersion + 2n);
    const removalEffect = uncertain.predecessorRetention?.removalEffect;
    if (!removalEffect) throw new Error("missing uncertain removal effect");
    expect(removalEffect).toMatchObject({
      state: "uncertain",
      epoch: state.aggregateVersion + 1n,
      observationDigest: removalEffect.proof.proofDigest,
    });
    expect(removalCommand).toBeDefined();

    const reconcilePredecessorRemoval = vi.fn(
      async (
        command: Parameters<
          ProductionActionConfigurationPort["reconcilePredecessorRemoval"]
        >[0],
      ) => {
        expect(command).toEqual(removalCommand);
        return {
          status: "exact" as const,
          configuration: promotedConfig([B.actionRef], at(24), 12n),
        };
      },
    );
    const complete = await new ReconcilePredecessorRetention({
      repository,
      clock: fixedClock(at(24)),
      id: { nextId },
      digest: digestPort,
      maximumCaptureAgeMs: 30_000,
      inventory: { captureComplete },
      admission,
      production: { reconcilePredecessorRemoval } as never,
    }).execute({ expectedAggregateVersion: uncertain.aggregateVersion });

    expect(complete.aggregateVersion).toBe(uncertain.aggregateVersion + 1n);
    expect(complete.predecessorRetention).toBeNull();
    expect(removePredecessor).toHaveBeenCalledTimes(1);
    expect(reconcilePredecessorRemoval).toHaveBeenCalledTimes(1);
    expect(captureComplete).toHaveBeenCalledTimes(1);
    expect(nextId).toHaveBeenCalledTimes(1);
  });
});

describe("VerifyExactTaggedActionRelease", () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const byteDigest = sha256(
    `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  );

  function verification(
    overrides: {
      publishedBytes?: Uint8Array;
      artifactBytes?: Uint8Array;
      movedTag?: boolean;
      unsafeSource?:
        | "attached"
        | "dirty"
        | "untracked"
        | "shallow"
        | "replace_refs"
        | "symlink"
        | "ambiguous_tag";
    } = {},
  ) {
    const verifyExact = vi.fn(
      async () =>
        ({
          attestation: {
            attestationId: "attestation-verified",
            digest: digest("8"),
            subjectBundleSha256: byteDigest,
          },
          trustedWorkflow: {
            path: ".github/workflows/release.yml",
            ref: "refs/heads/main",
            commitSha: sha("5"),
            runId: "123",
            runAttempt: 1,
          },
          expectedExecutableSha256: byteDigest,
        }) as unknown as VerifiedActionReleaseAttestationV2,
    );
    return {
      verifyExact,
      useCase: new VerifyExactTaggedActionRelease({
        digest: digestPort,
        source: {
          inspectExact: async () => ({
            identity: {
              repository: repositoryIdentity,
              tag: "v1.2.3",
              tagRef: {
                objectSha: sha("1"),
                objectType: "tag",
                peeledCommitSha: sha("b"),
              },
              commitTreeSha: sha("2"),
              actionManifest: {
                blobSha: sha("3"),
                main: "action-dist/index.cjs",
              },
              executable: {
                blobOid: sha("4"),
                mode: "100644",
                byteLength: bytes.byteLength,
                sha256: byteDigest,
              },
              taggedSourceTreeSha256: digest("1"),
              buildRecipeSha256: digest("2"),
              lockfileSha256: digest("3"),
            },
            committedExecutableBytes: bytes,
            detached: overrides.unsafeSource !== "attached",
            clean: overrides.unsafeSource !== "dirty",
            untrackedInputs: overrides.unsafeSource === "untracked",
            shallow: overrides.unsafeSource === "shallow",
            replaceRefs: overrides.unsafeSource === "replace_refs",
            executableSymlink: overrides.unsafeSource === "symlink",
            ambiguousTag: overrides.unsafeSource === "ambiguous_tag",
          }),
          reobserveTag: async () => ({
            tagRef: {
              objectSha: overrides.movedTag ? sha("9") : sha("1"),
              objectType: "tag",
              peeledCommitSha: sha("b"),
            },
            commitTreeSha: sha("2"),
          }),
        },
        build: {
          rebuildTwice: async () => ({
            firstExecutableBytes: bytes,
            secondExecutableBytes: new Uint8Array(bytes),
            firstDetachedPathDigest: digest("a"),
            secondDetachedPathDigest: digest("b"),
            toolchainSha256: digest("4"),
            dependencyInstallationSha256: digest("5"),
          }),
        },
        published: {
          fetchExact: async () => ({
            artifactBytes: overrides.artifactBytes ?? bytes,
            executableBytes: overrides.publishedBytes ?? bytes,
            publishedBundle: {
              artifactId: "artifact-published",
              artifactSha256: byteDigest,
              executableSha256: byteDigest,
            },
            release: {
              releaseId: "release-123",
              immutable: true,
              digest: digest("7"),
            },
            installer: {
              version: "1.2.3",
              url: `https://example.test/${sha("b")}/installer.tgz`,
              sha256: digest("9"),
            },
          }),
        },
        attestation: { verifyExact },
      }),
    };
  }

  it("brands only byte-identical committed, rebuilt, published, and attested bundles", async () => {
    const { useCase, verifyExact } = verification();
    const result = await useCase.execute({
      repository: repositoryIdentity,
      tag: "v1.2.3",
    });
    expect(result.actionManifest.main).toBe("action-dist/index.cjs");
    expect(result.executable.sha256).toBe(byteDigest);
    expect(verifyExact).toHaveBeenCalledTimes(1);
    expect(verifyExact).toHaveBeenCalledWith({
      source: expect.objectContaining({
        identity: expect.objectContaining({ tag: "v1.2.3" }),
      }),
      publishedBundle: {
        artifactId: "artifact-published",
        artifactSha256: byteDigest,
        executableSha256: byteDigest,
      },
      release: {
        releaseId: "release-123",
        immutable: true,
        digest: digest("7"),
      },
      installer: {
        version: "1.2.3",
        url: `https://example.test/${sha("b")}/installer.tgz`,
        sha256: digest("9"),
      },
    });
  });

  it("rejects a decoy published bundle before invoking the attestation verifier", async () => {
    const { useCase, verifyExact } = verification({
      publishedBytes: new Uint8Array([9, 9, 9]),
    });
    await expect(
      useCase.execute({ repository: repositoryIdentity, tag: "v1.2.3" }),
    ).rejects.toBeInstanceOf(ActionReleaseApplicationError);
    expect(verifyExact).not.toHaveBeenCalled();
  });

  it("rejects unsafe source observations, artifact drift, and tag movement", async () => {
    for (const unsafeSource of [
      "attached",
      "dirty",
      "untracked",
      "shallow",
      "replace_refs",
      "symlink",
      "ambiguous_tag",
    ] as const) {
      const { useCase } = verification({ unsafeSource });
      await expect(
        useCase.execute({ repository: repositoryIdentity, tag: "v1.2.3" }),
      ).rejects.toMatchObject({
        code: "exact_action_release_verification_failed",
      });
    }
    await expect(
      verification({
        artifactBytes: new Uint8Array([7, 7, 7]),
      }).useCase.execute({ repository: repositoryIdentity, tag: "v1.2.3" }),
    ).rejects.toMatchObject({
      code: "exact_action_release_verification_failed",
    });
    await expect(
      verification({ movedTag: true }).useCase.execute({
        repository: repositoryIdentity,
        tag: "v1.2.3",
      }),
    ).rejects.toMatchObject({
      code: "exact_action_release_verification_failed",
    });
  });
});
