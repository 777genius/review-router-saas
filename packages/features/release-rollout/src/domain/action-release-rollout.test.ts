import { describe, expect, it } from "vitest";
import {
  assertWorkflowActionSelection,
  commitSha,
  immutableActionRef,
  sha256,
  terminalCanaryReceiptIdentityDigest,
  verifiedActionReleaseV2,
  type FixedCanaryBindingInput,
  type VerifiedActionReleaseV2,
  type VerifiedFixedTerminalCanaryReceiptV4,
} from "./action-release-identity";
import {
  abortActionReleaseCandidate,
  acceptFixedTerminalCanaryReceipt,
  ActionReleaseRolloutPhase,
  armFixedActionReleaseCanary,
  authorizeFixedActionReleaseCanaryProvisioning,
  assertNoImplicitActionReleaseRollback,
  beginActionReleaseOverlapStaging,
  beginActionReleasePromotion,
  beginActionReleaseRecoveryAdmissionReopen,
  beginFixedTerminalCanaryReceiptVerification,
  beginPredecessorAdmissionClose,
  beginPredecessorRemoval,
  clearActionReleaseOverlapAfterDefiniteNoEffect,
  completeActionReleasePromotion,
  completeActionReleaseRecoveryAdmissionReopen,
  completePredecessorRemoval,
  confirmActionReleaseRecoveryAdmissionClosed,
  confirmFixedActionReleaseCanaryProvisioned,
  createSteadyActionReleaseRollout,
  deriveKnownActionRefs,
  enterActionReleaseRecoveryOnly,
  enterUncertainPromotionRecoveryOnly,
  exactProductionActionConfiguration,
  markActionReleasePromotionUncertain,
  markActionReleaseAdmissionEffectUncertain,
  markFixedActionReleaseCanaryProvisioningUncertain,
  markFixedTerminalCanaryReceiptVerificationUncertain,
  markPredecessorAdmissionCloseUncertain,
  markPredecessorRemovalUncertain,
  prepareActionReleasePromotion,
  recordPredecessorAdmissionFence,
  recordPredecessorZeroCapture,
  registerActionReleaseCandidate,
  resolveAttestedLiveNamespaceSelection,
  resolveIsolatedCandidateSelection,
  resolveProductionPrimarySelection,
  resumeFixedTerminalCanaryReceiptVerification,
  stageActionReleaseOverlap,
  type ActionReleaseRollout,
  type CanaryArmedActionReleaseRollout,
  type PromotionPreparedActionReleaseRollout,
  type SteadyActionReleaseRollout,
} from "./action-release-rollout";
import {
  assertZeroPredecessorReferenceCapture,
  completeLiveActionReferenceInventory,
  liveActionReferenceInventoryScopeDigest,
  LiveActionDatabaseCoverage,
  LiveActionReferenceKind,
  predecessorRemovalProof,
  productionActionConfigurationConsensusDigest,
  zeroPredecessorReferenceCapture,
  type LiveActionReferenceInventoryCaptureV1,
  type PredecessorAdmissionFence,
} from "./live-action-reference-inventory";

const digest = (character: string) => sha256(`sha256:${character.repeat(64)}`);
const sha = (character: string) => character.repeat(40);
const at = (seconds: number) =>
  new Date(Date.UTC(2026, 7, 30, 8, 0, seconds)).toISOString();

const repository = { repositoryId: "101", fullName: "acme/action" };

function release(
  character: string,
  version: number,
  objectType: "tag" | "commit" = "tag",
): VerifiedActionReleaseV2 {
  const commit = sha(character);
  const executableDigest = digest(character);
  return verifiedActionReleaseV2({
    repository,
    tag: `v1.0.${version}`,
    tagRef: {
      objectSha: sha(String((version % 8) + 1)),
      objectType,
      peeledCommitSha: commit,
    },
    commitTreeSha: sha("a"),
    actionManifest: { blobSha: sha("b"), main: "action-dist/index.cjs" },
    executable: {
      blobOid: sha("c"),
      mode: "100644",
      byteLength: 1024,
      sha256: executableDigest,
    },
    taggedSourceTreeSha256: digest("1"),
    buildRecipeSha256: digest("2"),
    lockfileSha256: digest("3"),
    toolchainSha256: digest("4"),
    dependencyInstallationSha256: digest("5"),
    rebuiltExecutableSha256: executableDigest,
    publishedBundle: {
      artifactId: `artifact-${version}`,
      artifactSha256: digest("6"),
      executableSha256: executableDigest,
    },
    release: {
      releaseId: `release-${version}`,
      immutable: true,
      digest: digest("7"),
    },
    attestation: {
      attestationId: `attestation-${version}`,
      digest: digest("8"),
      subjectBundleSha256: executableDigest,
    },
    trustedWorkflow: {
      path: ".github/workflows/release.yml",
      ref: "refs/heads/main",
      commitSha: sha("d"),
      runId: "9001",
      runAttempt: 1,
    },
    installer: {
      version: `1.0.${version}`,
      url: `https://artifacts.example/action/${commit}/installer.tgz`,
      sha256: digest("9"),
    },
  });
}

const A = release("a", 100);
const B = release("b", 101);
const C = release("c", 102);

function overlapConfiguration(
  observedAt = at(2),
  revision = 10n,
  bindingDigest: ReturnType<typeof digest> | null = null,
) {
  return exactProductionActionConfiguration({
    schemaVersion: 1,
    revision,
    observedAt,
    serviceIds: ["web", "worker", "api"],
    primaryRef: A.actionRef,
    installerRef: A.actionRef,
    installer: A.installer,
    reusableWorkflowRef: A.actionRef,
    runtimeRef: A.actionRef,
    refreshActionRef: A.actionRef,
    interactionRuntimeRef: A.actionRef,
    knownRefs: [B.actionRef, A.actionRef],
    isolatedCandidateAttemptId: "attempt-1",
    isolatedCandidateBindingDigest: bindingDigest,
  });
}

function preOverlapConfiguration() {
  return exactProductionActionConfiguration({
    ...overlapConfiguration(at(1), 9n),
    knownRefs: [A.actionRef],
    isolatedCandidateAttemptId: null,
    isolatedCandidateBindingDigest: null,
  });
}

function canaryBinding(
  overrides: Partial<FixedCanaryBindingInput> = {},
): FixedCanaryBindingInput {
  return {
    schemaVersion: 5,
    target: {
      githubRepositoryId: "777",
      githubRepositoryNodeId: "R_fixed",
      repositoryFullName: "777genius/review-router-saas-e2e",
      providerInstanceId: "provider-fixed",
      pullRequestNumber: 51,
      reviewWorkflowPath: ".github/workflows/reviewrouter-codex.yml",
      interactionWorkflowPath:
        ".github/workflows/reviewrouter-codex-interaction.yml",
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
    ...overrides,
  };
}

function registered() {
  return registerActionReleaseCandidate(
    createSteadyActionReleaseRollout({
      primaryRef: A.actionRef,
      channelVersion: 7n,
    }),
    {
      attemptId: "attempt-1",
      candidateRelease: B,
      policyRevision: 11n,
      registeredAt: at(0),
    },
  );
}

function staged() {
  const candidate = registered();
  const intent = beginActionReleaseOverlapStaging(candidate, {
    attemptId: "attempt-1",
    expectedConfiguration: preOverlapConfiguration(),
    effectId: "overlap-effect-1",
    effectEpoch: candidate.aggregateVersion + 1n,
    startedAt: at(1),
  });
  return stageActionReleaseOverlap(intent, {
    attemptId: "attempt-1",
    configuration: overlapConfiguration(),
  });
}

function armed() {
  const prepared = armFixedActionReleaseCanary(staged(), {
    attemptId: "attempt-1",
    binding: canaryBinding(),
  });
  const state = authorizeFixedActionReleaseCanaryProvisioning(prepared, {
    eligibility: {
      policyRevision: 11n,
      channelVersion: 7n,
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

function receiptFor(
  state: CanaryArmedActionReleaseRollout,
  overrides: Record<string, unknown> = {},
): VerifiedFixedTerminalCanaryReceiptV4 {
  return {
    schemaVersion: 4,
    receiptId: "receipt-1",
    canonicalPayloadDigest: digest("4"),
    artifactId: "evidence-artifact-1",
    artifactSha256: digest("5"),
    expectationDigest: state.expectation.expectationDigest,
    rolloutAttemptId: state.candidate.attemptId,
    candidateActionRef: state.candidate.candidateRelease.actionRef,
    challengeSha256: state.canary.challengeSha256,
    runId: "12345",
    runAttempt: 1,
    completedAt: at(4),
    ...overrides,
  } as unknown as VerifiedFixedTerminalCanaryReceiptV4;
}

function verified() {
  const state = verificationStarted();
  return acceptFixedTerminalCanaryReceipt(state, {
    attemptId: "attempt-1",
    receipt: receiptFor(state),
  });
}

function verificationStarted(state = armed()) {
  return beginFixedTerminalCanaryReceiptVerification(state, {
    attemptId: state.candidate.attemptId,
    locator: {
      artifactId: "evidence-artifact-1",
      artifactSha256: digest("5"),
    },
    effectId: "receipt-verification-1",
    effectEpoch: state.aggregateVersion + 1n,
    startedAt: at(3),
    leaseExpiresAt: at(5),
  });
}

function rawInventory(
  input: {
    capturedAt?: string;
    snapshot?: string;
    consensusDigest?: ReturnType<typeof digest>;
    references?: LiveActionReferenceInventoryCaptureV1["references"];
    completeness?: "complete" | "partial" | "unknown";
    databaseServerTime?: string;
    githubAppLogin?: string;
    githubWorkflows?: readonly string[];
    repositoryIds?: readonly string[];
    repositoryCohortRevision?: bigint;
    repositoryCohortDigest?: ReturnType<typeof digest>;
    policyRevision?: bigint;
  } = {},
): LiveActionReferenceInventoryCaptureV1 {
  const production = {
    serviceIds: ["api", "web", "worker"],
    deploymentIds: ["deploy-api", "deploy-web", "deploy-worker"],
    primaryRef: A.actionRef,
    installerRef: A.actionRef,
    installer: A.installer,
    reusableWorkflowRef: A.actionRef,
    runtimeRef: A.actionRef,
    refreshActionRef: A.actionRef,
    interactionRuntimeRef: A.actionRef,
    allowlistedRefs: [A.actionRef, B.actionRef],
  } as const;
  const repositoryIds = input.repositoryIds ?? ["777"];
  const workflows = input.githubWorkflows ?? [
    ".github/workflows/reviewrouter-codex.yml",
    ".github/workflows/reviewrouter-codex-interaction.yml",
  ];
  const statuses = ["queued", "in_progress"] as const;
  return {
    schemaVersion: 1,
    completeness: input.completeness ?? "complete",
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
      coveredTables: ["Namespace", "Lease"],
      rowCounts: { Lease: 0, Namespace: 0 },
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
      consensusDigest:
        input.consensusDigest ??
        productionActionConfigurationConsensusDigest(production),
    },
    references: input.references ?? [],
    capturedAt: input.capturedAt ?? at(5),
    maximumQueueLeaseWindowMs: 10_000,
  };
}

function rawRetainedInventory(
  input: Parameters<typeof rawInventory>[0] = {},
): LiveActionReferenceInventoryCaptureV1 {
  const capture = rawInventory(input);
  const production = {
    serviceIds: capture.production.serviceIds,
    deploymentIds: capture.production.deploymentIds,
    primaryRef: B.actionRef,
    installerRef: B.actionRef,
    installer: B.installer,
    reusableWorkflowRef: B.actionRef,
    runtimeRef: B.actionRef,
    refreshActionRef: B.actionRef,
    interactionRuntimeRef: B.actionRef,
    allowlistedRefs: [A.actionRef, B.actionRef],
  } as const;
  return {
    ...capture,
    production: {
      complete: true,
      ...production,
      consensusDigest: productionActionConfigurationConsensusDigest(production),
    },
  };
}

function prepared() {
  const state = verified();
  return prepareActionReleasePromotion(state, {
    attemptId: "attempt-1",
    inventory: completeLiveActionReferenceInventory(rawInventory()),
    configuration: overlapConfiguration(
      at(5),
      10n,
      state.expectation.expectationDigest,
    ),
    preparedAt: at(6),
    validUntil: at(20),
  });
}

function promoting() {
  const state = prepared();
  return beginActionReleasePromotion(state, {
    attemptId: "attempt-1",
    reservation: {
      reservationId: "reservation-1",
      ownerAttemptId: "attempt-1",
      receiptId: "receipt-1",
      artifactId: "evidence-artifact-1",
      canonicalPayloadDigest: state.receipt.canonicalPayloadDigest,
      artifactSha256: state.receipt.artifactSha256,
      expectationDigest: state.receipt.expectationDigest,
      receiptIdentityDigest: terminalCanaryReceiptIdentityDigest(state.receipt),
      reservedAt: at(7),
      epoch: state.aggregateVersion + 1n,
    },
    effectId: "promotion-effect-1",
    now: at(7),
  });
}

function promotedConfiguration(
  knownRefs = [A.actionRef, B.actionRef],
  observedAt = at(8),
  revision = 11n,
) {
  return exactProductionActionConfiguration({
    schemaVersion: 1,
    revision,
    observedAt,
    serviceIds: ["api", "web", "worker"],
    primaryRef: B.actionRef,
    installerRef: B.actionRef,
    installer: B.installer,
    reusableWorkflowRef: B.actionRef,
    runtimeRef: B.actionRef,
    refreshActionRef: B.actionRef,
    interactionRuntimeRef: B.actionRef,
    knownRefs,
    isolatedCandidateAttemptId: null,
    isolatedCandidateBindingDigest: null,
  });
}

function promotedSteady() {
  return completeActionReleasePromotion(promoting(), {
    attemptId: "attempt-1",
    configuration: promotedConfiguration(),
    completedAt: at(9),
  });
}

function withPredecessorAdmissionFence(
  state: SteadyActionReleaseRollout,
  fence: PredecessorAdmissionFence,
) {
  const pending = beginPredecessorAdmissionClose(state, {
    effectId: fence.fenceId,
    effectEpoch: state.aggregateVersion + 1n,
    fenceId: fence.fenceId,
    fenceEpoch: fence.epoch,
    startedAt: fence.closedAt,
  });
  return recordPredecessorAdmissionFence(pending, fence);
}

function verifiedRecovery(
  state: SteadyActionReleaseRollout,
  input: {
    readonly recoveryFenceId: string;
    readonly recoveryFenceEpoch: bigint;
    readonly failureDigest: ReturnType<typeof digest>;
    readonly enteredAt: string;
  },
) {
  const pending = enterActionReleaseRecoveryOnly(state, {
    ...input,
    effectId: input.recoveryFenceId,
    effectEpoch: state.aggregateVersion + 1n,
  });
  return confirmActionReleaseRecoveryAdmissionClosed(pending, {
    effectId: pending.recoveryAdmissionEffect.effectId,
    effectEpoch: pending.recoveryAdmissionEffect.epoch,
    fenceId: input.recoveryFenceId,
    fenceEpoch: input.recoveryFenceEpoch,
    currentPrimary: state.primaryRef,
    failureDigest: input.failureDigest,
    confirmedAt: input.enteredAt,
  });
}

describe("ActionReleaseRollout state machine", () => {
  it("performs every successful promotion transition and increments only the exact channel completion", () => {
    const initial = createSteadyActionReleaseRollout({
      primaryRef: A.actionRef,
      channelVersion: 7n,
    });
    const candidate = registered();
    const overlap = staged();
    const canary = armed();
    const terminal = verified();
    const ready = prepared();
    const dispatching = promoting();
    const complete = promotedSteady();

    expect([
      initial.phase,
      candidate.phase,
      overlap.phase,
      canary.phase,
      terminal.phase,
      ready.phase,
      dispatching.phase,
      complete.phase,
    ]).toEqual([
      "steady",
      "candidate_registered",
      "overlap_staged",
      "canary_armed",
      "canary_verified",
      "promotion_prepared",
      "promoting",
      "steady",
    ]);
    expect(candidate.channelVersion).toBe(7n);
    expect(dispatching.channelVersion).toBe(7n);
    expect(complete.channelVersion).toBe(8n);
    expect(complete.primaryRef).toEqual(B.actionRef);
    expect(complete.predecessorRetention?.predecessorRef).toEqual(A.actionRef);
  });

  it("keeps A primary for ordinary setup while B is staged and selects B only for the exact armed tuple", () => {
    const overlap = staged();
    expect(resolveProductionPrimarySelection(overlap).actionRef).toEqual(
      A.actionRef,
    );
    const attestedContext = {
      namespaceId: "already-attested-a",
      namespaceEpoch: 1n,
      workflowSourceDigest: digest("a"),
    } as const;
    expect(
      resolveAttestedLiveNamespaceSelection(overlap, {
        ...attestedContext,
        actionRef: A.actionRef,
      }).actionRef,
    ).toEqual(A.actionRef);
    expect(() =>
      resolveAttestedLiveNamespaceSelection(overlap, {
        ...attestedContext,
        actionRef: B.actionRef,
      }),
    ).toThrow("action_release_selection_rejected");
    const state = armed();
    const context = {
      schemaVersion: 5,
      rolloutAttemptId: "attempt-1",
      policyRevision: 11n,
      githubRepositoryId: "777",
      githubRepositoryNodeId: "R_fixed",
      repositoryFullName: "777genius/review-router-saas-e2e",
      providerInstanceId: "provider-fixed",
      pullRequestNumber: 51,
      reviewedHeadSha: sha("e"),
      namespaceId: "namespace-fresh",
      namespaceEpoch: 2n,
      challengeSha256: digest("c"),
      reviewWorkflowPath: ".github/workflows/reviewrouter-codex.yml",
      interactionWorkflowPath:
        ".github/workflows/reviewrouter-codex-interaction.yml",
      reviewSource: state.canary.reviewSource,
      interactionSource: state.canary.interactionSource,
      bindingDigest: state.canary.bindingDigest,
    } as const;
    expect(resolveIsolatedCandidateSelection(state, context).actionRef).toEqual(
      B.actionRef,
    );
    for (const wrong of [
      { githubRepositoryId: "778" },
      { githubRepositoryNodeId: "R_other" },
      { repositoryFullName: "other/repository" },
      { providerInstanceId: "provider-other" },
      { pullRequestNumber: 37 },
      { reviewedHeadSha: commitSha(sha("f")) },
      { namespaceId: "namespace-other" },
      { namespaceEpoch: 3n },
      { challengeSha256: digest("d") },
      { rolloutAttemptId: "attempt-2" },
      { policyRevision: 12n },
      { reviewWorkflowPath: ".github/workflows/ordinary.yml" },
      { interactionWorkflowPath: ".github/workflows/ordinary.yml" },
      {
        reviewSource: {
          ...state.canary.reviewSource,
          semanticSha256: digest("f"),
        },
      },
      {
        interactionSource: {
          ...state.canary.interactionSource,
          blobSha: commitSha(sha("f")),
        },
      },
      { bindingDigest: digest("f") },
    ])
      expect(() =>
        resolveIsolatedCandidateSelection(state, { ...context, ...wrong }),
      ).toThrow("action_release_selection_rejected");
    expect(() =>
      resolveAttestedLiveNamespaceSelection(state, {
        ...attestedContext,
        actionRef: B.actionRef,
      }),
    ).toThrow("action_release_selection_rejected");
    expect(
      resolveAttestedLiveNamespaceSelection(promotedSteady(), {
        ...attestedContext,
        actionRef: B.actionRef,
      }).actionRef,
    ).toEqual(B.actionRef);

    const mixedCase = armFixedActionReleaseCanary(staged(), {
      attemptId: "attempt-1",
      binding: canaryBinding({
        target: {
          ...canaryBinding().target,
          repositoryFullName: "777Genius/Review-Router-SaaS-E2E",
        },
      }),
    });
    expect(mixedCase.canary.target.repositoryFullName).toBe(
      "777genius/review-router-saas-e2e",
    );
  });

  it("clears only a proven no-effect overlap intent before retry or abort", () => {
    const candidate = registered();
    const intent = beginActionReleaseOverlapStaging(candidate, {
      attemptId: "attempt-1",
      expectedConfiguration: preOverlapConfiguration(),
      effectId: "overlap-effect-no-effect",
      effectEpoch: candidate.aggregateVersion + 1n,
      startedAt: at(1),
    });
    const cleared = clearActionReleaseOverlapAfterDefiniteNoEffect(intent, {
      attemptId: "attempt-1",
      configuration: preOverlapConfiguration(),
      clearedAt: at(2),
    });
    expect(cleared.overlapEffect).toBeNull();
    expect(
      abortActionReleaseCandidate(cleared, {
        attemptId: "attempt-1",
        abortedAt: at(3),
        reasonDigest: digest("a"),
      }).phase,
    ).toBe("candidate_aborted");
  });

  it("rejects structural Action-ref selections and closes normal admission while promotion is uncertain", () => {
    expect(() =>
      assertWorkflowActionSelection({
        kind: "isolated_candidate",
        schemaVersion: 5,
        rolloutAttemptId: "forged-attempt",
        policyRevision: 11n,
        actionRef: C.actionRef,
        githubRepositoryId: "777",
        githubRepositoryNodeId: "R_fixed",
        repositoryFullName: "777genius/review-router-saas-e2e",
        providerInstanceId: "provider-fixed",
        namespaceId: "namespace-fresh",
        namespaceEpoch: 2n,
        challengeSha256: digest("c"),
        bindingDigest: digest("d"),
      } as never),
    ).toThrow("workflow_action_selection_unbranded");
    expect(() => resolveProductionPrimarySelection(promoting())).toThrow(
      "action_release_promotion_reconcile_only",
    );
    const uncertain = markActionReleasePromotionUncertain(promoting(), {
      attemptId: "attempt-1",
      observationDigest: digest("f"),
      observedAt: at(8),
    });
    expect(() => resolveProductionPrimarySelection(uncertain)).toThrow(
      "action_release_promotion_reconcile_only",
    );
  });

  it("requires exact known-ref sets and never trusts an unstaged candidate", () => {
    expect(deriveKnownActionRefs(registered())).toEqual([A.actionRef]);
    const candidate = registered();
    const intent = beginActionReleaseOverlapStaging(candidate, {
      attemptId: "attempt-1",
      expectedConfiguration: preOverlapConfiguration(),
      effectId: "overlap-effect-invalid-known-ref",
      effectEpoch: candidate.aggregateVersion + 1n,
      startedAt: at(1),
    });
    expect(() =>
      stageActionReleaseOverlap(intent, {
        attemptId: "attempt-1",
        configuration: exactProductionActionConfiguration({
          ...overlapConfiguration(),
          knownRefs: [A.actionRef, B.actionRef, C.actionRef],
        }),
      }),
    ).toThrow("action_release_overlap_invalid");
    const lateIntent = beginActionReleaseOverlapStaging(candidate, {
      attemptId: "attempt-1",
      expectedConfiguration: preOverlapConfiguration(),
      effectId: "overlap-effect-late-observation",
      effectEpoch: candidate.aggregateVersion + 1n,
      startedAt: at(3),
    });
    expect(() =>
      stageActionReleaseOverlap(lateIntent, {
        attemptId: "attempt-1",
        configuration: overlapConfiguration(at(2)),
      }),
    ).toThrow("action_release_overlap_invalid");
    expect(() =>
      completeActionReleasePromotion(promoting(), {
        attemptId: "attempt-1",
        configuration: promotedConfiguration([
          A.actionRef,
          B.actionRef,
          C.actionRef,
        ]),
        completedAt: at(9),
      }),
    ).toThrow("action_release_promotion_readback_invalid");
    expect(() =>
      completeActionReleasePromotion(promoting(), {
        attemptId: "attempt-1",
        configuration: exactProductionActionConfiguration({
          ...promotedConfiguration(),
          installer: { ...B.installer, sha256: digest("f") },
        }),
        completedAt: at(9),
      }),
    ).toThrow("action_release_promotion_readback_invalid");
  });

  it("rejects mutable/short refs, same-release candidates, repository substitution, and wrong four-ref binding", () => {
    expect(() => release("d", 103, "tree" as never)).toThrow(
      "action_release_tag_object_type_invalid",
    );
    expect(() => immutableActionRef({ repository, commitSha: "main" })).toThrow(
      "action_ref_commit_sha_invalid",
    );
    expect(() =>
      registerActionReleaseCandidate(
        createSteadyActionReleaseRollout({
          primaryRef: B.actionRef,
          channelVersion: 1n,
        }),
        {
          attemptId: "attempt-x",
          candidateRelease: B,
          policyRevision: 1n,
          registeredAt: at(0),
        },
      ),
    ).toThrow("action_release_candidate_already_primary");
    expect(() =>
      registerActionReleaseCandidate(
        createSteadyActionReleaseRollout({
          primaryRef: immutableActionRef({
            repository: { repositoryId: "555", fullName: "other/action" },
            commitSha: sha("a"),
          }),
          channelVersion: 1n,
        }),
        {
          attemptId: "attempt-x",
          candidateRelease: B,
          policyRevision: 1n,
          registeredAt: at(0),
        },
      ),
    ).toThrow("action_release_repository_mismatch");
    for (const refField of [
      "reusableWorkflowRef",
      "runtimeRef",
      "refreshActionRef",
      "interactionRuntimeRef",
    ] as const)
      expect(() =>
        armFixedActionReleaseCanary(staged(), {
          attemptId: "attempt-1",
          binding: canaryBinding({ [refField]: A.actionRef }),
        }),
      ).toThrow("action_release_canary_binding_invalid");
  });

  it("rejects wrong and duplicate receipts and preserves one-shot identity through abort", () => {
    const state = verificationStarted();
    expect(() =>
      acceptFixedTerminalCanaryReceipt(state, {
        attemptId: "attempt-1",
        receipt: receiptFor(state, { candidateActionRef: A.actionRef }),
      }),
    ).toThrow("action_release_receipt_invalid");
    const verifierReceipt = receiptFor(state);
    const accepted = acceptFixedTerminalCanaryReceipt(state, {
      attemptId: "attempt-1",
      receipt: verifierReceipt,
    });
    expect(accepted.receipt).not.toBe(verifierReceipt);
    expect(Object.isFrozen(accepted.receipt)).toBe(true);
    (verifierReceipt as unknown as { receiptId: string }).receiptId =
      "mutated-after-acceptance";
    expect(accepted.receipt.receiptId).toBe("receipt-1");
    expect(() =>
      acceptFixedTerminalCanaryReceipt(
        accepted as unknown as CanaryArmedActionReleaseRollout,
        { attemptId: "attempt-1", receipt: receiptFor(state) },
      ),
    ).toThrow("action_release_rollout_invalid_phase");
    const aborted = abortActionReleaseCandidate(accepted, {
      attemptId: "attempt-1",
      abortedAt: at(6),
      reasonDigest: digest("a"),
    });
    expect(aborted.receiptIdentity).toEqual({
      receiptId: "receipt-1",
      artifactId: "evidence-artifact-1",
    });
    expect(() =>
      registerActionReleaseCandidate(aborted, {
        attemptId: "attempt-1",
        candidateRelease: A,
        policyRevision: 12n,
        registeredAt: at(7),
      }),
    ).toThrow("action_release_attempt_replay");
  });

  it("persists one exact receipt-verification tuple and fences reconciliation by lease and epoch", () => {
    const started = verificationStarted();
    expect(started.receiptVerification?.locator).toEqual({
      artifactId: "evidence-artifact-1",
      artifactSha256: digest("5"),
    });
    expect(() =>
      beginFixedTerminalCanaryReceiptVerification(started, {
        attemptId: "attempt-1",
        locator: {
          artifactId: "different-artifact",
          artifactSha256: digest("6"),
        },
        effectId: "receipt-verification-2",
        effectEpoch: started.aggregateVersion + 1n,
        startedAt: at(4),
        leaseExpiresAt: at(6),
      }),
    ).toThrow("action_release_promotion_reconcile_only");
    expect(() =>
      resumeFixedTerminalCanaryReceiptVerification(started, {
        attemptId: "attempt-1",
        resumedAt: at(4),
        leaseExpiresAt: at(6),
      }),
    ).toThrow("action_release_promotion_reconcile_only");

    const uncertain = markFixedTerminalCanaryReceiptVerificationUncertain(
      started,
      {
        attemptId: "attempt-1",
        observationDigest: digest("f"),
        observedAt: at(4),
      },
    );
    const resumed = resumeFixedTerminalCanaryReceiptVerification(uncertain, {
      attemptId: "attempt-1",
      resumedAt: at(4),
      leaseExpiresAt: at(6),
    });
    expect(resumed.receiptVerification).toMatchObject({
      state: "dispatching",
      epoch: uncertain.aggregateVersion + 1n,
      locator: started.receiptVerification?.locator,
    });
    expect(
      acceptFixedTerminalCanaryReceipt(resumed, {
        attemptId: "attempt-1",
        receipt: receiptFor(resumed),
      }).receiptVerification.state,
    ).toBe("verified");

    const expired = resumeFixedTerminalCanaryReceiptVerification(started, {
      attemptId: "attempt-1",
      resumedAt: at(5),
      leaseExpiresAt: at(7),
    });
    expect(expired.receiptVerification?.epoch).toBe(
      started.aggregateVersion + 1n,
    );
  });

  it("records uncertain canary provisioning as an abortable, non-verifiable checkpoint", () => {
    const prepared = armFixedActionReleaseCanary(staged(), {
      attemptId: "attempt-1",
      binding: canaryBinding(),
    });
    const dispatching = authorizeFixedActionReleaseCanaryProvisioning(
      prepared,
      {
        eligibility: {
          policyRevision: 11n,
          channelVersion: 7n,
          selectionDigest: digest("c"),
          contextDigest: digest("d"),
          decisionDigest: digest("e"),
        },
        authorizedAt: at(3),
      },
    );
    const uncertain = markFixedActionReleaseCanaryProvisioningUncertain(
      dispatching,
      {
        observationDigest: digest("f"),
        observedAt: at(3),
      },
    );
    expect(uncertain.provisioning).toMatchObject({
      state: "uncertain",
      eligibility: { decisionDigest: digest("e") },
      observationDigest: digest("f"),
    });
    expect(() => verificationStarted(uncertain)).toThrow(
      "action_release_canary_binding_invalid",
    );
    expect(
      abortActionReleaseCandidate(uncertain, {
        attemptId: "attempt-1",
        abortedAt: at(4),
        reasonDigest: digest("a"),
      }).phase,
    ).toBe("candidate_aborted");
  });

  it("allows abort from every pre-promotion phase and rejects abort after receipt consumption", () => {
    const abortable = [registered(), staged(), armed(), verified(), prepared()];
    for (const state of abortable) {
      const aborted = abortActionReleaseCandidate(state, {
        attemptId: "attempt-1",
        abortedAt: at(10),
        reasonDigest: digest("a"),
      });
      expect(aborted.phase).toBe(ActionReleaseRolloutPhase.CandidateAborted);
      expect(aborted.primaryRef).toEqual(A.actionRef);
    }
    const afterPromotionStarted = [
      promoting(),
      markActionReleasePromotionUncertain(promoting(), {
        attemptId: "attempt-1",
        observationDigest: digest("f"),
        observedAt: at(8),
      }),
      promotedSteady(),
    ];
    for (const state of afterPromotionStarted)
      expect(() =>
        abortActionReleaseCandidate(
          state as unknown as Parameters<typeof abortActionReleaseCandidate>[0],
          {
            attemptId: "attempt-1",
            abortedAt: at(10),
            reasonDigest: digest("a"),
          },
        ),
      ).toThrow("action_release_abort_forbidden");
  });

  it("moves unknown effects into reconcile-only state without releasing the receipt", () => {
    expect(() =>
      markActionReleasePromotionUncertain(promoting(), {
        attemptId: "attempt-1",
        observationDigest: digest("e"),
        observedAt: at(6),
      }),
    ).toThrow("action_release_promotion_readback_invalid");
    const uncertain = markActionReleasePromotionUncertain(promoting(), {
      attemptId: "attempt-1",
      observationDigest: digest("f"),
      observedAt: at(8),
    });
    expect(uncertain.phase).toBe("promotion_uncertain");
    expect(uncertain.reservation.receiptId).toBe("receipt-1");
    expect(() =>
      beginActionReleasePromotion(
        uncertain as unknown as PromotionPreparedActionReleaseRollout,
        {
          attemptId: "attempt-1",
          reservation: uncertain.reservation,
          effectId: "retry-effect",
          now: at(9),
        },
      ),
    ).toThrow("action_release_rollout_invalid_phase");
    expect(
      completeActionReleasePromotion(uncertain, {
        attemptId: "attempt-1",
        configuration: promotedConfiguration(),
        completedAt: at(9),
      }).phase,
    ).toBe("steady");
  });

  it("fails closed for incomplete, mismatched, and stale promotion inventories", () => {
    for (const completeness of ["partial", "unknown"] as const)
      expect(() =>
        completeLiveActionReferenceInventory(rawInventory({ completeness })),
      ).toThrow("live_action_reference_inventory_incomplete");
    const state = verified();
    expect(() =>
      prepareActionReleasePromotion(state, {
        attemptId: "attempt-1",
        inventory: completeLiveActionReferenceInventory(
          rawInventory({ capturedAt: at(10) }),
        ),
        configuration: overlapConfiguration(),
        preparedAt: at(6),
        validUntil: at(20),
      }),
    ).toThrow("action_release_promotion_preparation_invalid");
    expect(() =>
      prepareActionReleasePromotion(state, {
        attemptId: "attempt-1",
        inventory: completeLiveActionReferenceInventory(
          rawInventory({ consensusDigest: digest("f") }),
        ),
        configuration: overlapConfiguration(),
        preparedAt: at(6),
        validUntil: at(20),
      }),
    ).toThrow("inventory_production_consensus_mismatch");

    const exactConfiguration = overlapConfiguration(
      at(5),
      10n,
      state.expectation.expectationDigest,
    );
    for (const invalidInventory of [
      rawInventory({
        capturedAt: at(5),
        databaseServerTime: at(3),
      }),
      rawInventory({
        githubWorkflows: [".github/workflows/reviewrouter-codex.yml"],
      }),
      rawInventory({ githubAppLogin: "different-app[bot]" }),
      rawInventory({ repositoryIds: ["778"] }),
    ])
      expect(() =>
        prepareActionReleasePromotion(state, {
          attemptId: "attempt-1",
          inventory: completeLiveActionReferenceInventory(invalidInventory),
          configuration: exactConfiguration,
          preparedAt: at(6),
          validUntil: at(20),
        }),
      ).toThrow("action_release_promotion_preparation_invalid");

    const foreignRef = immutableActionRef({
      repository: { repositoryId: "202", fullName: "other/action" },
      commitSha: sha("f"),
    });
    const foreignRaw = rawInventory();
    const foreignProduction = {
      ...foreignRaw.production,
      allowlistedRefs: [A.actionRef, B.actionRef, foreignRef],
    };
    expect(() =>
      completeLiveActionReferenceInventory({
        ...foreignRaw,
        production: {
          ...foreignProduction,
          consensusDigest:
            productionActionConfigurationConsensusDigest(foreignProduction),
        },
        references: [
          {
            kind: LiveActionReferenceKind.OAuthLeaseOrWriteback,
            holderId: "foreign-action-reference",
            actionRef: foreignRef,
            githubRepositoryId: "777",
            repositoryFullName: "777genius/review-router-saas-e2e",
            sourceIdentityDigest: digest("e"),
            details: {
              kind: "durable_reference",
              sourceSchema: "oauth-lease-v1",
              expiresAt: null,
            },
          },
        ],
      }),
    ).toThrow("inventory_action_repository_mismatch");
  });

  it("rejects stale promotion reservations and non-exact split readback", () => {
    const ready = prepared();
    expect(() =>
      beginActionReleasePromotion(ready, {
        attemptId: "attempt-1",
        reservation: {
          reservationId: "reservation-x",
          ownerAttemptId: "attempt-1",
          receiptId: "receipt-1",
          artifactId: "evidence-artifact-1",
          canonicalPayloadDigest: ready.receipt.canonicalPayloadDigest,
          artifactSha256: ready.receipt.artifactSha256,
          expectationDigest: ready.receipt.expectationDigest,
          receiptIdentityDigest: terminalCanaryReceiptIdentityDigest(
            ready.receipt,
          ),
          reservedAt: at(21),
          epoch: ready.aggregateVersion + 1n,
        },
        effectId: "effect-x",
        now: at(21),
      }),
    ).toThrow("action_release_promotion_preparation_invalid");
    expect(() =>
      completeActionReleasePromotion(promoting(), {
        attemptId: "attempt-1",
        configuration: exactProductionActionConfiguration({
          ...promotedConfiguration(),
          runtimeRef: A.actionRef,
        }),
        completedAt: at(9),
      }),
    ).toThrow("action_release_promotion_readback_invalid");
  });

  it("never treats historical fromRelease as an implicit rollback", () => {
    const complete = promotedSteady();
    expect(() =>
      assertNoImplicitActionReleaseRollback(complete, A.actionRef),
    ).toThrow("action_release_promotion_readback_invalid");
    expect(() =>
      enterActionReleaseRecoveryOnly(
        createSteadyActionReleaseRollout({
          primaryRef: A.actionRef,
          channelVersion: 1n,
        }),
        {
          effectId: "fence-1",
          effectEpoch: 2n,
          recoveryFenceId: "fence-1",
          recoveryFenceEpoch: 1n,
          failureDigest: digest("a"),
          enteredAt: at(10),
        },
      ),
    ).toThrow("action_release_recovery_forbidden");
    const recovery = verifiedRecovery(complete, {
      recoveryFenceId: "fence-1",
      recoveryFenceEpoch: 1n,
      failureDigest: digest("a"),
      enteredAt: at(10),
    });
    expect(() => resolveProductionPrimarySelection(recovery)).toThrow(
      "action_release_admission_closed",
    );
    expect(recovery.primaryRef).toEqual(B.actionRef);
  });

  it("requires exact durable recovery admission close and reopen checkpoints", () => {
    const promoted = promotedSteady();
    const pendingClose = enterActionReleaseRecoveryOnly(promoted, {
      effectId: "recovery-close",
      effectEpoch: promoted.aggregateVersion + 1n,
      recoveryFenceId: "recovery-close",
      recoveryFenceEpoch: 3n,
      failureDigest: digest("f"),
      enteredAt: at(10),
    });
    expect(() =>
      registerActionReleaseCandidate(pendingClose, {
        attemptId: "attempt-return-pending",
        candidateRelease: A,
        policyRevision: 12n,
        registeredAt: at(11),
      }),
    ).toThrow("action_release_admission_effect_invalid");
    const uncertainClose = markActionReleaseAdmissionEffectUncertain(
      pendingClose,
      {
        effectId: "recovery-close",
        effectEpoch: promoted.aggregateVersion + 1n,
        observationDigest: digest("e"),
        observedAt: at(11),
      },
    );
    expect(uncertainClose.recoveryAdmissionEffect.state).toBe("uncertain");
    const closed = confirmActionReleaseRecoveryAdmissionClosed(uncertainClose, {
      effectId: "recovery-close",
      effectEpoch: promoted.aggregateVersion + 1n,
      fenceId: "recovery-close",
      fenceEpoch: 3n,
      currentPrimary: B.actionRef,
      failureDigest: digest("f"),
      confirmedAt: at(12),
    });
    expect(closed.recoveryAdmissionEffect.state).toBe("verified");

    const base = promoting();
    const recoveryOrigin = Object.freeze({
      ...base,
      admissionMode: "recovery_only" as const,
      recoveryAdmissionEffect: Object.freeze({
        operation: "close_recovery_admission" as const,
        effectId: "origin-close",
        epoch: 4n,
        state: "verified" as const,
        currentPrimary: base.primaryRef,
        failureDigest: digest("d"),
        fenceId: "origin-close",
        fenceEpoch: 2n,
        observationDigest: null,
        updatedAt: at(6),
      }),
      candidate: Object.freeze({
        ...base.candidate,
        originAdmissionMode: "recovery_only" as const,
        originRecoveryFence: Object.freeze({
          fenceId: "origin-close",
          epoch: 2n,
        }),
      }),
    });
    expect(() =>
      completeActionReleasePromotion(recoveryOrigin, {
        attemptId: "attempt-1",
        configuration: promotedConfiguration(),
        completedAt: at(9),
      }),
    ).toThrow("action_release_admission_effect_invalid");
    const reopening = beginActionReleaseRecoveryAdmissionReopen(
      recoveryOrigin,
      {
        attemptId: "attempt-1",
        configuration: promotedConfiguration(),
        effectId: "reopen-effect",
        effectEpoch: recoveryOrigin.aggregateVersion + 1n,
        observationDigest: digest("c"),
        startedAt: at(9),
      },
    );
    expect(reopening.phase).toBe("promotion_uncertain");
    expect(() =>
      completeActionReleaseRecoveryAdmissionReopen(reopening, {
        effectId: "wrong-effect",
        effectEpoch: recoveryOrigin.aggregateVersion + 1n,
        fenceId: "origin-close",
        fenceEpoch: 2n,
        ownerAttemptId: "attempt-1",
        promotedPrimary: B.actionRef,
        configurationDigest: promotedConfiguration().configurationDigest,
        openedEpoch: 3n,
        completedAt: at(10),
      }),
    ).toThrow("action_release_admission_effect_invalid");
    const steady = completeActionReleaseRecoveryAdmissionReopen(reopening, {
      effectId: "reopen-effect",
      effectEpoch: recoveryOrigin.aggregateVersion + 1n,
      fenceId: "origin-close",
      fenceEpoch: 2n,
      ownerAttemptId: "attempt-1",
      promotedPrimary: B.actionRef,
      configurationDigest: promotedConfiguration().configurationDigest,
      openedEpoch: 3n,
      completedAt: at(10),
    });
    expect(steady.phase).toBe("steady");
    expect(steady.admissionMode).toBe("normal");
  });

  it("enters RecoveryOnly from a reconciled promoted failure without manufacturing Steady(B)", () => {
    const uncertain = markActionReleasePromotionUncertain(promoting(), {
      attemptId: "attempt-1",
      observationDigest: digest("f"),
      observedAt: at(8),
    });
    expect(() =>
      enterUncertainPromotionRecoveryOnly(uncertain, {
        effectId: "recovery-fence",
        effectEpoch: uncertain.aggregateVersion + 1n,
        recoveryFenceId: "recovery-fence",
        recoveryFenceEpoch: 2n,
        failureDigest: digest("a"),
        promotedConfiguration: exactProductionActionConfiguration({
          ...promotedConfiguration(),
          serviceIds: ["api", "web"],
        }),
        enteredAt: at(9),
      }),
    ).toThrow("action_release_recovery_forbidden");
    expect(() =>
      enterUncertainPromotionRecoveryOnly(uncertain, {
        effectId: "recovery-fence",
        effectEpoch: uncertain.aggregateVersion + 1n,
        recoveryFenceId: "recovery-fence",
        recoveryFenceEpoch: 2n,
        failureDigest: digest("a"),
        promotedConfiguration: promotedConfiguration(),
        enteredAt: at(7),
      }),
    ).toThrow("action_release_recovery_forbidden");
    const recovery = enterUncertainPromotionRecoveryOnly(uncertain, {
      effectId: "recovery-fence",
      effectEpoch: uncertain.aggregateVersion + 1n,
      recoveryFenceId: "recovery-fence",
      recoveryFenceEpoch: 2n,
      failureDigest: digest("a"),
      promotedConfiguration: promotedConfiguration(),
      enteredAt: at(9),
    });
    expect(recovery.phase).toBe("recovery_only");
    expect(recovery.primaryRef).toEqual(B.actionRef);
    expect(recovery.channelVersion).toBe(7n);
    expect(recovery.predecessorRetention?.predecessorRef).toEqual(A.actionRef);
  });

  it("requires a new attempt for aborted candidates and every B-to-A reintroduction", () => {
    const firstStagedAttempt = staged();
    const aborted = abortActionReleaseCandidate(firstStagedAttempt, {
      attemptId: "attempt-1",
      abortedAt: at(4),
      reasonDigest: digest("a"),
    });
    expect(deriveKnownActionRefs(aborted)).toEqual([A.actionRef, B.actionRef]);
    const retry = registerActionReleaseCandidate(aborted, {
      attemptId: "attempt-2",
      candidateRelease: B,
      policyRevision: 12n,
      registeredAt: at(5),
    });
    expect(retry.candidate.attemptId).toBe("attempt-2");
    expect(
      resolveAttestedLiveNamespaceSelection(retry, {
        actionRef: B.actionRef,
        namespaceId: "retired-attempt-namespace",
        namespaceEpoch: 1n,
        workflowSourceDigest: digest("f"),
      }).actionRef,
    ).toEqual(B.actionRef);
    const retiredAttemptConfiguration = exactProductionActionConfiguration({
      ...firstStagedAttempt.overlapConfiguration,
      isolatedCandidateBindingDigest: digest("f"),
    });
    const retryIntent = beginActionReleaseOverlapStaging(retry, {
      attemptId: "attempt-2",
      expectedConfiguration: retiredAttemptConfiguration,
      effectId: "retry-overlap",
      effectEpoch: retry.aggregateVersion + 1n,
      startedAt: at(5),
    });
    expect(
      stageActionReleaseOverlap(retryIntent, {
        attemptId: "attempt-2",
        configuration: exactProductionActionConfiguration({
          ...retiredAttemptConfiguration,
          revision: retiredAttemptConfiguration.revision + 1n,
          observedAt: at(6),
          isolatedCandidateAttemptId: "attempt-2",
          isolatedCandidateBindingDigest: null,
        }),
      }).phase,
    ).toBe("overlap_staged");
    const secondAbort = abortActionReleaseCandidate(retry, {
      attemptId: "attempt-2",
      abortedAt: at(6),
      reasonDigest: digest("b"),
    });
    expect(() =>
      registerActionReleaseCandidate(secondAbort, {
        attemptId: "attempt-1",
        candidateRelease: C,
        policyRevision: 13n,
        registeredAt: at(7),
      }),
    ).toThrow("action_release_attempt_replay");

    const promoted = promotedSteady();
    const recovery = verifiedRecovery(promoted, {
      recoveryFenceId: "recovery-fence",
      recoveryFenceEpoch: 2n,
      failureDigest: digest("b"),
      enteredAt: at(10),
    });
    expect(() =>
      registerActionReleaseCandidate(recovery, {
        attemptId: "attempt-unrelated-c",
        candidateRelease: C,
        policyRevision: 12n,
        registeredAt: at(11),
      }),
    ).toThrow("action_release_predecessor_retention_invalid");
    expect(() =>
      assertNoImplicitActionReleaseRollback(recovery, A.actionRef),
    ).toThrow("action_release_promotion_readback_invalid");
    const reintroduction = registerActionReleaseCandidate(recovery, {
      attemptId: "attempt-return-a",
      candidateRelease: A,
      policyRevision: 12n,
      registeredAt: at(11),
    });
    expect(reintroduction.primaryRef).toEqual(B.actionRef);
    expect(reintroduction.candidate.fromRelease).toEqual(B.actionRef);
    expect(reintroduction.candidate.candidateRelease.actionRef).toEqual(
      A.actionRef,
    );
    expect(reintroduction.candidate.originRecoveryFence).toEqual({
      fenceId: "recovery-fence",
      epoch: 2n,
    });
    const beforeReintroductionOverlap = exactProductionActionConfiguration({
      schemaVersion: 1,
      revision: 12n,
      observedAt: at(11),
      serviceIds: ["api", "web", "worker"],
      primaryRef: B.actionRef,
      installerRef: B.actionRef,
      installer: B.installer,
      reusableWorkflowRef: B.actionRef,
      runtimeRef: B.actionRef,
      refreshActionRef: B.actionRef,
      interactionRuntimeRef: B.actionRef,
      knownRefs: [A.actionRef, B.actionRef],
      isolatedCandidateAttemptId: null,
      isolatedCandidateBindingDigest: null,
    });
    const reintroductionIntent = beginActionReleaseOverlapStaging(
      reintroduction,
      {
        attemptId: "attempt-return-a",
        expectedConfiguration: beforeReintroductionOverlap,
        effectId: "reintroduction-overlap",
        effectEpoch: reintroduction.aggregateVersion + 1n,
        startedAt: at(11),
      },
    );
    const stagedReintroduction = stageActionReleaseOverlap(
      reintroductionIntent,
      {
        attemptId: "attempt-return-a",
        configuration: exactProductionActionConfiguration({
          ...beforeReintroductionOverlap,
          revision: 13n,
          observedAt: at(12),
          isolatedCandidateAttemptId: "attempt-return-a",
        }),
      },
    );
    expect(stagedReintroduction.predecessorRetention).toBeNull();
    const recoveryAbort = abortActionReleaseCandidate(reintroduction, {
      attemptId: "attempt-return-a",
      abortedAt: at(12),
      reasonDigest: digest("c"),
    });
    const abortedRetentionPending = beginPredecessorAdmissionClose(
      recoveryAbort,
      {
        effectId: "aborted-predecessor-close",
        effectEpoch: recoveryAbort.aggregateVersion + 1n,
        fenceId: "aborted-predecessor-close",
        fenceEpoch: 3n,
        startedAt: at(12),
      },
    );
    const abortedRetentionFenced = recordPredecessorAdmissionFence(
      abortedRetentionPending,
      {
        fenceId: "aborted-predecessor-close",
        epoch: 3n,
        predecessorRef: A.actionRef,
        repositoryCohortRevision: 20n,
        repositoryCohortDigest: digest("1"),
        githubRepositoryIds: ["777"],
        policyRevision: 11n,
        inventoryScopeDigest:
          recoveryAbort.predecessorRetention!.inventoryScopeDigest,
        requiredWindowMs: 10_000,
        authorityEstablishedAt: at(9),
        closedAt: at(13),
      },
    );
    expect(abortedRetentionFenced.phase).toBe("candidate_aborted");
    expect(abortedRetentionFenced.predecessorRetention?.fence).not.toBeNull();
    const recoveryRetry = registerActionReleaseCandidate(recoveryAbort, {
      attemptId: "attempt-return-a-2",
      candidateRelease: A,
      policyRevision: 13n,
      registeredAt: at(13),
    });
    expect(recoveryRetry.candidate.originRecoveryFence).toEqual({
      fenceId: "recovery-fence",
      epoch: 2n,
    });
  });
});

describe("complete live Action inventory and predecessor retention", () => {
  it("canonicalizes count-free reference sets and derives trust without a retain window", () => {
    const references = [
      {
        kind: LiveActionReferenceKind.InFlightWorkflowRun,
        holderId: "run-1-attempt-1",
        actionRef: A.actionRef,
        githubRepositoryId: "777",
        repositoryFullName: "777genius/review-router-saas-e2e",
        sourceIdentityDigest: digest("a"),
        details: {
          kind: "workflow_run",
          workflowPath: ".github/workflows/reviewrouter-codex.yml",
          status: "queued",
          runId: "1001",
          runAttempt: 1,
          workflowCommitSha: sha("1"),
          workflowBlobSha: sha("2"),
          workflowSemanticSha256: digest("1"),
        },
      },
      {
        kind: LiveActionReferenceKind.ActiveNamespaceWorkflow,
        holderId: "namespace-1",
        actionRef: B.actionRef,
        githubRepositoryId: "777",
        repositoryFullName: "777genius/review-router-saas-e2e",
        sourceIdentityDigest: digest("b"),
        details: {
          kind: "active_namespace",
          namespaceId: "namespace-1",
          namespaceEpoch: 1n,
          workflowCommitSha: sha("3"),
          workflowBlobSha: sha("4"),
          workflowSemanticSha256: digest("2"),
        },
      },
    ] as const;
    const first = completeLiveActionReferenceInventory(
      rawInventory({ references }),
    );
    const second = completeLiveActionReferenceInventory(
      rawInventory({ references: [...references].reverse() }),
    );
    expect(first.inventoryDigest).toBe(second.inventoryDigest);
    const state: ActionReleaseRollout = {
      ...createSteadyActionReleaseRollout({
        primaryRef: B.actionRef,
        channelVersion: 2n,
      }),
      latestInventory: {
        inventoryDigest: first.inventoryDigest,
        inventoryScopeDigest: liveActionReferenceInventoryScopeDigest(first),
        capturedAt: first.capturedAt,
        repositoryCohortRevision: first.repositoryCohort.revision,
        repositoryCohortDigest: first.repositoryCohort.digest,
        githubRepositoryIds: first.repositoryCohort.githubRepositoryIds,
        policyRevision: first.policyRevision,
        exactRefs: references.map((reference) => reference.actionRef),
        maximumQueueLeaseWindowMs: first.maximumQueueLeaseWindowMs,
      },
    };
    expect(deriveKnownActionRefs(state).map((ref) => ref.canonical)).toEqual([
      A.actionRef.canonical,
      B.actionRef.canonical,
    ]);
  });

  it("brands inventory only with exact logical coverage and status-complete pagination", () => {
    const capture = rawInventory();
    expect(() =>
      completeLiveActionReferenceInventory({
        ...capture,
        database: {
          ...capture.database,
          coveredScopes: capture.database.coveredScopes.slice(1),
        },
      }),
    ).toThrow("inventory_database_coverage_incomplete");
    expect(() =>
      completeLiveActionReferenceInventory({
        ...capture,
        github: {
          ...capture.github,
          pages: capture.github.pages.filter(
            (page) => page.status !== "in_progress",
          ),
        },
      }),
    ).toThrow("inventory_github_pagination_incomplete");
    expect(() =>
      completeLiveActionReferenceInventory({
        ...capture,
        database: { ...capture.database, serverTime: at(6) },
      }),
    ).toThrow("inventory_database_snapshot_after_capture");
    expect(() =>
      completeLiveActionReferenceInventory({
        ...capture,
        references: [
          {
            kind: "future_unknown_holder",
            holderId: "unknown-1",
            actionRef: A.actionRef,
            githubRepositoryId: "777",
            repositoryFullName: "777genius/review-router-saas-e2e",
            sourceIdentityDigest: digest("a"),
            details: {
              kind: "durable_reference",
              sourceSchema: "future-v2",
              expiresAt: null,
            },
          } as never,
        ],
      }),
    ).toThrow("live_action_reference_invalid");
    expect(() =>
      completeLiveActionReferenceInventory({
        ...capture,
        references: [
          {
            kind: LiveActionReferenceKind.OAuthLeaseOrWriteback,
            holderId: "unknown-schema-1",
            actionRef: A.actionRef,
            githubRepositoryId: "777",
            repositoryFullName: "777genius/review-router-saas-e2e",
            sourceIdentityDigest: digest("a"),
            details: {
              kind: "durable_reference",
              sourceSchema: "future-v2",
              expiresAt: null,
            },
          } as never,
        ],
      }),
    ).toThrow("live_action_durable_source_schema_unknown");
    const exactRunReference = {
      kind: LiveActionReferenceKind.InFlightWorkflowRun,
      holderId: "run-scope-1",
      actionRef: A.actionRef,
      githubRepositoryId: "777",
      repositoryFullName: "777genius/review-router-saas-e2e",
      sourceIdentityDigest: digest("a"),
      details: {
        kind: "workflow_run",
        workflowPath: ".github/workflows/reviewrouter-codex.yml",
        status: "queued",
        runId: "1001",
        runAttempt: 1,
        workflowCommitSha: sha("1"),
        workflowBlobSha: sha("2"),
        workflowSemanticSha256: digest("1"),
      },
    } as const;
    expect(() =>
      completeLiveActionReferenceInventory({
        ...capture,
        references: [
          {
            ...exactRunReference,
            details: {
              ...exactRunReference.details,
              workflowPath: ".github/workflows/unscanned.yml",
            },
          },
        ],
      }),
    ).toThrow("live_action_workflow_run_reference_invalid");
    expect(() =>
      completeLiveActionReferenceInventory({
        ...capture,
        references: [
          {
            ...exactRunReference,
            details: {
              ...exactRunReference.details,
              status: "completed",
            },
          } as never,
        ],
      }),
    ).toThrow("live_action_workflow_run_reference_invalid");
  });

  it("requires two independent zero captures after the fence and the complete queue/lease window", () => {
    let state = promotedSteady();
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
    state = withPredecessorAdmissionFence(state, fence);
    for (const drifted of [
      rawRetainedInventory({ capturedAt: at(11), policyRevision: 12n }),
      rawRetainedInventory({
        capturedAt: at(11),
        repositoryCohortRevision: 21n,
      }),
      rawRetainedInventory({ capturedAt: at(11), repositoryIds: ["778"] }),
      rawRetainedInventory({
        capturedAt: at(11),
        githubWorkflows: [".github/workflows/reviewrouter-codex.yml"],
      }),
    ])
      expect(() =>
        zeroPredecessorReferenceCapture({
          inventory: completeLiveActionReferenceInventory(drifted),
          predecessorRef: A.actionRef,
          successorRef: B.actionRef,
          expectedInstaller: B.installer,
          expectedServiceIds: ["api", "web", "worker"],
          fence,
          observedNow: at(12),
          maximumCaptureAgeMs: 30_000,
        }),
      ).toThrow("predecessor_inventory_fence_binding_mismatch");
    expect(() =>
      zeroPredecessorReferenceCapture({
        inventory: completeLiveActionReferenceInventory(
          rawInventory({
            capturedAt: at(11),
            snapshot: "snapshot-rolled-back",
          }),
        ),
        predecessorRef: A.actionRef,
        successorRef: B.actionRef,
        expectedInstaller: B.installer,
        expectedServiceIds: ["api", "web", "worker"],
        fence,
        observedNow: at(12),
        maximumCaptureAgeMs: 30_000,
      }),
    ).toThrow("predecessor_inventory_successor_binding_mismatch");
    const preFenceSnapshot = rawRetainedInventory({
      capturedAt: at(11),
      snapshot: "snapshot-pre-fence",
    });
    expect(() =>
      zeroPredecessorReferenceCapture({
        inventory: completeLiveActionReferenceInventory({
          ...preFenceSnapshot,
          database: { ...preFenceSnapshot.database, serverTime: at(9) },
        }),
        predecessorRef: A.actionRef,
        successorRef: B.actionRef,
        expectedInstaller: B.installer,
        expectedServiceIds: ["api", "web", "worker"],
        fence,
        observedNow: at(12),
        maximumCaptureAgeMs: 30_000,
      }),
    ).toThrow("predecessor_inventory_capture_stale");
    const firstInventory = completeLiveActionReferenceInventory(
      rawRetainedInventory({ capturedAt: at(11), snapshot: "snapshot-first" }),
    );
    const first = zeroPredecessorReferenceCapture({
      inventory: firstInventory,
      predecessorRef: A.actionRef,
      successorRef: B.actionRef,
      expectedInstaller: B.installer,
      expectedServiceIds: ["api", "web", "worker"],
      fence,
      observedNow: at(12),
      maximumCaptureAgeMs: 30_000,
    });
    expect(first).not.toBeNull();
    const contradictoryInventory = completeLiveActionReferenceInventory(
      rawRetainedInventory({
        capturedAt: at(11),
        snapshot: "snapshot-contradictory",
      }),
    );
    expect(() =>
      recordPredecessorZeroCapture(state, first, contradictoryInventory),
    ).toThrow("action_release_predecessor_retention_invalid");
    const forgedSecond = {
      ...first!,
      capturedAt: at(21),
      inventoryDigest: digest("f"),
      databaseSnapshotIdentity: "forged-snapshot",
    } as typeof first;
    expect(() =>
      assertZeroPredecessorReferenceCapture(forgedSecond!, fence),
    ).toThrow("predecessor_zero_capture_binding_invalid");
    state = recordPredecessorZeroCapture(state, first);
    const earlyInventory = completeLiveActionReferenceInventory(
      rawRetainedInventory({ capturedAt: at(15), snapshot: "snapshot-early" }),
    );
    const early = zeroPredecessorReferenceCapture({
      inventory: earlyInventory,
      predecessorRef: A.actionRef,
      successorRef: B.actionRef,
      expectedInstaller: B.installer,
      expectedServiceIds: ["api", "web", "worker"],
      fence,
      observedNow: at(16),
      maximumCaptureAgeMs: 30_000,
    });
    expect(() =>
      predecessorRemovalProof({
        predecessorRef: A.actionRef,
        successorRef: B.actionRef,
        fence,
        first: first!,
        second: early!,
      }),
    ).toThrow("predecessor_two_capture_window_unproven");
    const earlyDatabaseSnapshot = rawRetainedInventory({
      capturedAt: at(21),
      snapshot: "snapshot-db-too-early",
    });
    const captureFinishedLate = zeroPredecessorReferenceCapture({
      inventory: completeLiveActionReferenceInventory({
        ...earlyDatabaseSnapshot,
        database: {
          ...earlyDatabaseSnapshot.database,
          serverTime: at(20),
        },
      }),
      predecessorRef: A.actionRef,
      successorRef: B.actionRef,
      expectedInstaller: B.installer,
      expectedServiceIds: ["api", "web", "worker"],
      fence,
      observedNow: at(22),
      maximumCaptureAgeMs: 30_000,
    });
    expect(() =>
      predecessorRemovalProof({
        predecessorRef: A.actionRef,
        successorRef: B.actionRef,
        fence,
        first: first!,
        second: captureFinishedLate!,
      }),
    ).toThrow("predecessor_two_capture_window_unproven");
    const secondInventory = completeLiveActionReferenceInventory(
      rawRetainedInventory({ capturedAt: at(21), snapshot: "snapshot-second" }),
    );
    const second = zeroPredecessorReferenceCapture({
      inventory: secondInventory,
      predecessorRef: A.actionRef,
      successorRef: B.actionRef,
      expectedInstaller: B.installer,
      expectedServiceIds: ["api", "web", "worker"],
      fence,
      observedNow: at(22),
      maximumCaptureAgeMs: 30_000,
    });
    const proof = predecessorRemovalProof({
      predecessorRef: A.actionRef,
      successorRef: B.actionRef,
      fence,
      first: first!,
      second: second!,
    });
    expect(() =>
      beginPredecessorRemoval(state, {
        proof: { ...proof, proofDigest: digest("f") },
        effectId: "tampered-removal-effect",
        effectEpoch: state.aggregateVersion + 1n,
        startedAt: at(23),
      }),
    ).toThrow("action_release_predecessor_removal_not_ready");
    state = beginPredecessorRemoval(state, {
      proof,
      effectId: "remove-predecessor-effect",
      effectEpoch: state.aggregateVersion + 1n,
      startedAt: at(23),
    });
    expect(() =>
      registerActionReleaseCandidate(state, {
        attemptId: "attempt-racing-removal",
        candidateRelease: A,
        policyRevision: 12n,
        registeredAt: at(23),
      }),
    ).toThrow("action_release_admission_effect_invalid");
    state = markPredecessorRemovalUncertain(state, {
      observationDigest: digest("e"),
      observedAt: at(23),
    });
    expect(state.predecessorRetention?.removalEffect?.state).toBe("uncertain");
    expect(() =>
      completePredecessorRemoval(state, {
        proof,
        configuration: exactProductionActionConfiguration({
          ...promotedConfiguration([B.actionRef], at(24), 12n),
          isolatedCandidateAttemptId: "forged-isolated-candidate",
          isolatedCandidateBindingDigest: digest("f"),
        }),
      }),
    ).toThrow("action_release_predecessor_removal_not_ready");
    state = completePredecessorRemoval(state, {
      proof,
      configuration: promotedConfiguration([B.actionRef], at(24), 12n),
    });
    expect(state.predecessorRetention).toBeNull();
    expect(deriveKnownActionRefs(state)).toEqual([B.actionRef]);
  });

  it("accepts an exact predecessor fence completed before a later uncertainty observation", () => {
    const state = promotedSteady();
    const pending = beginPredecessorAdmissionClose(state, {
      effectId: "lost-predecessor-close",
      effectEpoch: state.aggregateVersion + 1n,
      fenceId: "lost-predecessor-close",
      fenceEpoch: 7n,
      startedAt: at(10),
    });
    const uncertain = markPredecessorAdmissionCloseUncertain(pending, {
      effectId: "lost-predecessor-close",
      effectEpoch: state.aggregateVersion + 1n,
      observationDigest: digest("f"),
      observedAt: at(12),
    });
    const reconciled = recordPredecessorAdmissionFence(uncertain, {
      fenceId: "lost-predecessor-close",
      epoch: 7n,
      predecessorRef: A.actionRef,
      repositoryCohortRevision: 20n,
      repositoryCohortDigest: digest("1"),
      githubRepositoryIds: ["777"],
      policyRevision: 11n,
      inventoryScopeDigest: state.predecessorRetention!.inventoryScopeDigest,
      requiredWindowMs: 10_000,
      authorityEstablishedAt: at(9),
      closedAt: at(11),
    });
    expect(reconciled.predecessorRetention?.fence?.closedAt).toBe(at(11));
    expect(reconciled.predecessorRetention?.admissionEffect).toBeNull();
  });

  it("resets drain proof on A reappearance and rejects stale/divergent capture races", () => {
    let state = promotedSteady();
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
    state = withPredecessorAdmissionFence(state, fence);
    const first = zeroPredecessorReferenceCapture({
      inventory: completeLiveActionReferenceInventory(
        rawRetainedInventory({
          capturedAt: at(11),
          snapshot: "snapshot-first",
        }),
      ),
      predecessorRef: A.actionRef,
      successorRef: B.actionRef,
      expectedInstaller: B.installer,
      expectedServiceIds: ["api", "web", "worker"],
      fence,
      observedNow: at(12),
      maximumCaptureAgeMs: 30_000,
    });
    state = recordPredecessorZeroCapture(state, first);
    const divergentRaw = rawRetainedInventory({
      capturedAt: at(21),
      snapshot: "snapshot-divergent-cohort",
    });
    expect(() =>
      zeroPredecessorReferenceCapture({
        inventory: completeLiveActionReferenceInventory({
          ...divergentRaw,
          repositoryCohort: {
            ...divergentRaw.repositoryCohort,
            digest: digest("f"),
          },
        }),
        predecessorRef: A.actionRef,
        successorRef: B.actionRef,
        expectedInstaller: B.installer,
        expectedServiceIds: ["api", "web", "worker"],
        fence,
        observedNow: at(22),
        maximumCaptureAgeMs: 30_000,
      }),
    ).toThrow("predecessor_inventory_fence_binding_mismatch");
    const reintroduced = completeLiveActionReferenceInventory(
      rawRetainedInventory({
        capturedAt: at(21),
        snapshot: "snapshot-reintroduced",
        references: [
          {
            kind: LiveActionReferenceKind.OAuthLeaseOrWriteback,
            holderId: "lease-1",
            actionRef: A.actionRef,
            githubRepositoryId: "777",
            repositoryFullName: "777genius/review-router-saas-e2e",
            sourceIdentityDigest: digest("a"),
            details: {
              kind: "durable_reference",
              sourceSchema: "oauth-lease-v1",
              expiresAt: at(30),
            },
          },
        ],
      }),
    );
    expect(
      zeroPredecessorReferenceCapture({
        inventory: reintroduced,
        predecessorRef: A.actionRef,
        successorRef: B.actionRef,
        expectedInstaller: B.installer,
        expectedServiceIds: ["api", "web", "worker"],
        fence,
        observedNow: at(22),
        maximumCaptureAgeMs: 30_000,
      }),
    ).toBeNull();
    state = recordPredecessorZeroCapture(state, null, reintroduced);
    expect(state.predecessorRetention?.firstZeroCapture).toBeNull();
    expect(() =>
      zeroPredecessorReferenceCapture({
        inventory: completeLiveActionReferenceInventory(
          rawRetainedInventory({
            capturedAt: at(11),
            snapshot: "snapshot-stale",
          }),
        ),
        predecessorRef: A.actionRef,
        successorRef: B.actionRef,
        expectedInstaller: B.installer,
        expectedServiceIds: ["api", "web", "worker"],
        fence,
        observedNow: at(50),
        maximumCaptureAgeMs: 5_000,
      }),
    ).toThrow("predecessor_inventory_capture_stale");
  });
});
