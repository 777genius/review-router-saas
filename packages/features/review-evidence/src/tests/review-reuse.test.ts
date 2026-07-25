import { describe, expect, it } from "vitest";
import {
  ActualModelCompatibilityMode,
  LookupReviewEvidence,
  LookupReviewEvidenceStatus,
  ProviderExecutionProfile,
  ReuseEligibility,
  ReviewObservationQualityFlag,
  ReviewReuseDenialReason,
  ReviewReuseEffectMode,
  ReviewReuseTier,
  ReviewTaskKind,
  ReviewTrustDomain,
  decideReviewReuseEligibility,
  selectDeterministicReviewObservations,
  type ReviewEvidenceLookupTarget,
  type ReviewReuseCompatibilityPolicy,
} from "../index";
import {
  InMemoryReviewEvidenceSafetyPort,
  InMemoryReviewObservationStore,
  NodeSha256DigestAdapter,
} from "../testing";
import {
  dayMs,
  defaultManifestKey,
  defaultProviderInvocationKey,
  gitSha,
  hash,
  manifest,
  nowMs,
  observation,
  revision,
  scope,
} from "./fixtures";

describe("ReviewReuseEligibilityPolicy", () => {
  it("loads accepted observations by id without exposing mutable state", async () => {
    const store = new InMemoryReviewObservationStore();
    const accepted = observation();
    await store.acceptObservation(accepted);

    const restored = await store.findById(accepted.observationId);
    expect(restored).toEqual(accepted);
    expect(restored).not.toBe(accepted);
    expect(await store.findById("observation-missing")).toBeNull();
  });

  it("allows T0 for the exact base, merge-base, head, revision, plan and invocation", () => {
    const candidate = observation();
    const decision = decideReviewReuseEligibility(candidate, target());

    expect(decision).toMatchObject({
      eligibility: ReuseEligibility.ExactRevision,
      tier: ReviewReuseTier.T0ExactRevision,
      reason: ReviewReuseDenialReason.None,
      canAttach: true,
      reuseSafetyDecisionHash: hash("f"),
    });
  });

  it.each([
    ["base", { baseSha: gitSha("d") }],
    ["merge-base", { mergeBaseSha: gitSha("d") }],
    ["head", { headSha: gitSha("d") }],
    ["revision hash", { reviewRevisionHash: hash("d") }],
  ])("does not classify %s movement as T0", (_label, revisionChange) => {
    const decision = decideReviewReuseEligibility(
      observation(),
      target({ revision: revision(revisionChange) }),
    );

    expect(decision.eligibility).not.toBe(ReuseEligibility.ExactRevision);
    expect(decision.canAttach).toBe(false);
  });

  it("denies an exact revision with a different plan", () => {
    const decision = decideReviewReuseEligibility(
      observation(),
      target({ planHash: hash("0") }),
    );

    expect(decision).toMatchObject({
      tier: ReviewReuseTier.T0ExactRevision,
      reason: ReviewReuseDenialReason.PlanMismatch,
      canAttach: false,
    });
  });

  it("denies T1 because the legacy prompt-only profile does not prove confinement", () => {
    const promptManifest = manifest({
      executionProfile: ProviderExecutionProfile.PromptOnlyEnvelopeV1,
    });
    const candidate = observation({
      executionProfile: ProviderExecutionProfile.PromptOnlyEnvelopeV1,
    });
    const decision = decideReviewReuseEligibility(
      candidate,
      target({
        revision: revision({
          headSha: gitSha("d"),
          reviewRevisionHash: hash("0"),
        }),
        manifest: promptManifest,
      }),
    );

    expect(decision).toMatchObject({
      eligibility: ReuseEligibility.DeniedExecutionProfile,
      tier: ReviewReuseTier.T1PromptOnlyCrossRevision,
      reason: ReviewReuseDenialReason.PromptOnlyConfinementNotProven,
      canAttach: false,
    });
  });

  it("never upgrades agentic Codex to T1 from reported behavior", () => {
    const decision = decideReviewReuseEligibility(
      observation(),
      target({
        revision: revision({
          headSha: gitSha("d"),
          reviewRevisionHash: hash("0"),
        }),
      }),
    );

    expect(decision).toMatchObject({
      eligibility: ReuseEligibility.DeniedExecutionProfile,
      reason: ReviewReuseDenialReason.ExecutionProfileDenied,
      canAttach: false,
    });
  });

  it("denies the legacy prompt-only profile before considering lifecycle input", () => {
    const lifecycleManifest = manifest({
      executionProfile: ProviderExecutionProfile.PromptOnlyEnvelopeV1,
      taskKindSet: [
        ReviewTaskKind.FindingDiscovery,
        ReviewTaskKind.LifecycleRevalidation,
      ],
      lifecycleTargetSetHash: hash("8"),
      liveLifecycleStateHash: hash("9"),
    });
    const decision = decideReviewReuseEligibility(
      observation({
        executionProfile: ProviderExecutionProfile.PromptOnlyEnvelopeV1,
        taskKindSet: lifecycleManifest.taskKindSet,
      }),
      target({
        revision: revision({
          headSha: gitSha("d"),
          reviewRevisionHash: hash("0"),
        }),
        manifest: lifecycleManifest,
      }),
    );

    expect(decision).toMatchObject({
      tier: ReviewReuseTier.T1PromptOnlyCrossRevision,
      reason: ReviewReuseDenialReason.PromptOnlyConfinementNotProven,
      canAttach: false,
    });
  });

  it("requires the exact live lifecycle hashes even for same-head lifecycle reuse", () => {
    const lifecycleManifest = manifest({
      taskKindSet: [ReviewTaskKind.LifecycleRevalidation],
      lifecycleTargetSetHash: null,
      liveLifecycleStateHash: null,
    });
    const decision = decideReviewReuseEligibility(
      observation({ taskKindSet: lifecycleManifest.taskKindSet }),
      target({ manifest: lifecycleManifest }),
    );

    expect(decision.reason).toBe(
      ReviewReuseDenialReason.LifecycleStateIncomplete,
    );
  });

  it.each([
    [
      "scope",
      observation({ scope: scope({ workspaceId: "workspace-other" }) }),
      ReviewReuseDenialReason.ScopeMismatch,
    ],
    [
      "trust domain",
      observation({ trustDomain: ReviewTrustDomain.UntrustedContribution }),
      ReviewReuseDenialReason.TrustDomainMismatch,
    ],
    [
      "expiry",
      observation({ createdAtMs: nowMs - dayMs, reuseExpiresAtMs: nowMs }),
      ReviewReuseDenialReason.Expired,
    ],
    [
      "manifest",
      observation({ manifestKey: hash("0") }),
      ReviewReuseDenialReason.ManifestMismatch,
    ],
  ])("fails closed on %s mismatch", (_label, candidate, reason) => {
    expect(decideReviewReuseEligibility(candidate, target())).toMatchObject({
      reason,
      canAttach: false,
    });
  });

  it.each([
    [
      "unregistered release",
      { registeredProducerReleaseIds: [] },
      ReviewReuseDenialReason.ProducerReleaseUnregistered,
    ],
    [
      "capability",
      { trustedCapabilityProfiles: [] },
      ReviewReuseDenialReason.CapabilityProfileIncompatible,
    ],
    [
      "runtime",
      { compatibleProviderRuntimeVersions: [] },
      ReviewReuseDenialReason.RuntimeIncompatible,
    ],
  ])("fails closed on incompatible %s", (_label, policyChange, reason) => {
    const decision = decideReviewReuseEligibility(
      observation(),
      target({ compatibility: { ...compatibility(), ...policyChange } }),
    );
    expect(decision).toMatchObject({ reason, canAttach: false });
  });

  it("requires explicit actual-model compatibility for a fallback", () => {
    const candidate = observation({ actualModel: "fallback-model" });
    expect(decideReviewReuseEligibility(candidate, target()).reason).toBe(
      ReviewReuseDenialReason.ActualModelIncompatible,
    );
    expect(
      decideReviewReuseEligibility(
        candidate,
        target({
          compatibility: {
            ...compatibility(),
            actualModelMode: ActualModelCompatibilityMode.Allowlisted,
            compatibleActualModels: ["fallback-model"],
          },
        }),
      ).canAttach,
    ).toBe(true);
  });

  it("returns T2 shadow candidates without attachment authority", () => {
    const gatewayManifest = manifest({
      executionProfile: ProviderExecutionProfile.ContextGatewayV1,
    });
    const decision = decideReviewReuseEligibility(
      observation({
        executionProfile: ProviderExecutionProfile.ContextGatewayV1,
        qualityFlags: [],
      }),
      target({
        revision: revision({
          headSha: gitSha("d"),
          reviewRevisionHash: hash("0"),
        }),
        manifest: gatewayManifest,
        safetyDecision: {
          evidenceReuseMode: ReviewReuseEffectMode.Enabled,
          promptOnlyReuseMode: ReviewReuseEffectMode.Disabled,
          contextGatewayReuseMode: ReviewReuseEffectMode.Shadow,
          safetyDecisionHash: hash("f"),
        },
      }),
    );

    expect(decision).toMatchObject({
      eligibility: ReuseEligibility.CandidateOnly,
      reason: ReviewReuseDenialReason.ContextGatewayReuseShadow,
      canAttach: false,
      reuseSafetyDecisionHash: null,
    });
  });

  it("denies cross-revision reuse when a fresh gateway result has no attestation", () => {
    const gatewayManifest = manifest({
      executionProfile: ProviderExecutionProfile.ContextGatewayV1,
    });
    const decision = decideReviewReuseEligibility(
      observation({
        executionProfile: ProviderExecutionProfile.ContextGatewayV1,
        qualityFlags: [],
        contextDependencyAttestationId: null,
        contextDependencyAttestationHash: null,
      }),
      target({
        revision: revision({
          headSha: gitSha("d"),
          reviewRevisionHash: hash("0"),
        }),
        manifest: gatewayManifest,
        safetyDecision: {
          evidenceReuseMode: ReviewReuseEffectMode.Enabled,
          promptOnlyReuseMode: ReviewReuseEffectMode.Disabled,
          contextGatewayReuseMode: ReviewReuseEffectMode.Enabled,
          safetyDecisionHash: hash("f"),
        },
      }),
    );

    expect(decision).toMatchObject({
      eligibility: ReuseEligibility.DeniedIncompatible,
      tier: ReviewReuseTier.T2ContextGatewayCrossRevision,
      reason: ReviewReuseDenialReason.ContextAttestationMissing,
      canAttach: false,
    });
  });

  it("requires same-execution restore/adoption instead of cross-execution lookup", () => {
    const decision = decideReviewReuseEligibility(
      observation(),
      target({ executionId: "execution-source-1" }),
    );
    expect(decision.reason).toBe(
      ReviewReuseDenialReason.SameExecutionRequiresAdoption,
    );
  });

  it("selects deterministically and permits one observation per vote identity", () => {
    const targetFacts = target();
    const candidates = [
      observation({
        observationId: "observation-warning",
        attemptId: "attempt-warning",
        createdAtMs: nowMs + 3,
        qualityFlags: [ReviewObservationQualityFlag.ProviderWarning],
        payloadHash: hash("3"),
      }),
      observation({
        observationId: "observation-clean-old",
        attemptId: "attempt-clean-old",
        createdAtMs: nowMs + 1,
        qualityFlags: [],
        payloadHash: hash("2"),
      }),
      observation({
        observationId: "observation-clean-new",
        attemptId: "attempt-clean-new",
        createdAtMs: nowMs + 2,
        qualityFlags: [],
        payloadHash: hash("1"),
      }),
    ];
    const decisions = candidates.map((candidate) =>
      decideReviewReuseEligibility(candidate, targetFacts),
    );

    const first = selectDeterministicReviewObservations(decisions);
    const reversed = selectDeterministicReviewObservations(
      [...decisions].reverse(),
    );

    expect(first).toHaveLength(1);
    expect(first[0]?.observation.observationId).toBe("observation-clean-new");
    expect(reversed[0]?.observation.observationId).toBe(
      "observation-clean-new",
    );
  });
});

describe("LookupReviewEvidence", () => {
  it("queries bounded candidates and returns the deterministic eligible hit", async () => {
    const store = new InMemoryReviewObservationStore();
    await store.acceptObservation(
      observation({
        observationId: "observation-old",
        attemptId: "attempt-old",
      }),
    );
    await store.acceptObservation(
      observation({
        observationId: "observation-new",
        attemptId: "attempt-new",
        createdAtMs: nowMs + 1,
        qualityFlags: [],
        payloadHash: hash("1"),
      }),
    );
    const policy = new InMemoryReviewEvidenceSafetyPort(
      { effectAllowed: true, safetyDecisionHash: hash("e") },
      {
        safetyDecision: target().safetyDecision,
        compatibility: compatibility(),
      },
    );
    const useCase = new LookupReviewEvidence({
      observations: store,
      policy,
      digest: new NodeSha256DigestAdapter(),
      nowMs: () => nowMs,
    });

    const result = await useCase.execute(query());

    expect(result.status).toBe(LookupReviewEvidenceStatus.Hit);
    expect(result.selected?.observation.observationId).toBe("observation-new");
    expect(result.considered).toBe(2);
  });

  it("fails closed when the server cannot resolve reuse policy", async () => {
    const policy = new InMemoryReviewEvidenceSafetyPort(
      { effectAllowed: true, safetyDecisionHash: hash("e") },
      null,
    );
    const useCase = new LookupReviewEvidence({
      observations: new InMemoryReviewObservationStore(),
      policy,
      digest: new NodeSha256DigestAdapter(),
      nowMs: () => nowMs,
    });

    await expect(useCase.execute(query())).resolves.toEqual({
      status: LookupReviewEvidenceStatus.Miss,
      selected: null,
      considered: 0,
      denialReasons: [ReviewReuseDenialReason.UnknownCompatibility],
    });
  });

  it("rejects client-claimed invocation keys that do not match canonical facts", async () => {
    const policy = new InMemoryReviewEvidenceSafetyPort(
      { effectAllowed: true, safetyDecisionHash: hash("e") },
      {
        safetyDecision: target().safetyDecision,
        compatibility: compatibility(),
      },
    );
    const useCase = new LookupReviewEvidence({
      observations: new InMemoryReviewObservationStore(),
      policy,
      digest: new NodeSha256DigestAdapter(),
      nowMs: () => nowMs,
    });

    await expect(
      useCase.execute({ ...query(), providerInvocationKey: hash("0") }),
    ).resolves.toEqual({
      status: LookupReviewEvidenceStatus.Miss,
      selected: null,
      considered: 0,
      denialReasons: [ReviewReuseDenialReason.ManifestMismatch],
    });
  });
});

function compatibility(): ReviewReuseCompatibilityPolicy {
  return {
    registeredProducerReleaseIds: ["release-1"],
    trustedCapabilityProfiles: ["trusted-capability-v1"],
    compatibleProviderRuntimeVersions: ["runtime-v1"],
    actualModelMode: ActualModelCompatibilityMode.Exact,
    compatibleActualModels: [],
  };
}

function target(
  overrides: Partial<ReviewEvidenceLookupTarget> = {},
): ReviewEvidenceLookupTarget {
  return {
    scope: scope(),
    revision: revision(),
    planHash: hash("9"),
    executionId: "execution-target-1",
    manifest: manifest(),
    manifestKey: defaultManifestKey,
    providerInvocationKey: defaultProviderInvocationKey,
    providerVoteIdentityHash: hash("c"),
    trustDomain: ReviewTrustDomain.TrustedManaged,
    nowMs,
    safetyDecision: {
      evidenceReuseMode: ReviewReuseEffectMode.Enabled,
      promptOnlyReuseMode: ReviewReuseEffectMode.Enabled,
      contextGatewayReuseMode: ReviewReuseEffectMode.Disabled,
      safetyDecisionHash: hash("f"),
    },
    compatibility: compatibility(),
    ...overrides,
  };
}

function query() {
  const targetFacts = target();
  return {
    scope: targetFacts.scope,
    revision: targetFacts.revision,
    planHash: targetFacts.planHash,
    executionId: targetFacts.executionId,
    manifest: targetFacts.manifest,
    manifestKey: targetFacts.manifestKey,
    providerInvocationKey: targetFacts.providerInvocationKey,
    providerVoteIdentityHash: targetFacts.providerVoteIdentityHash,
    trustDomain: targetFacts.trustDomain,
  };
}
