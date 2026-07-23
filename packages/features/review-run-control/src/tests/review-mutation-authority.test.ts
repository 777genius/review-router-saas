import { describe, expect, it } from "vitest";
import {
  abortReviewMutationDrain,
  activateReviewMutationEpoch,
  beginReviewMutationDrain,
  initializeDirectV2ReviewMutationAuthority,
  initializeReviewMutationAuthority,
  pauseReviewMutation,
  resumeReviewMutationEpoch,
  ReviewMutationTransitionKind,
  type ReviewMutationAuthority,
} from "../domain/review-mutation-authority";
import {
  ReviewMutationAuthorityProofKind,
  ReviewMutationAuthorityProofVersion,
  sealReviewMutationAuthorityProof,
  type ReviewMutationAbortProofFacts,
  type ReviewMutationActivationProofFacts,
  type ReviewMutationDirectV2InitializationProofFacts,
  type ReviewMutationResumeProofFacts,
} from "../domain/review-mutation-authority-proof";
import {
  ReviewMutationLaneKind,
  ReviewMutationMode,
  ReviewRunControlErrorCode,
} from "../domain/review-run-control-types";
import { hashA, hashB } from "./fixtures";

const t0 = new Date("2026-01-01T00:00:00.000Z");

describe("ReviewMutationAuthority", () => {
  it("defaults to v1_open and requires ready server proof for direct V2", () => {
    const initialized = initializeReviewMutationAuthority({
      scmRepositoryIdentityId: "scm-1",
      initializedAt: t0,
    });
    expect(initialized.authority).toMatchObject({
      mode: ReviewMutationMode.V1Open,
      epoch: 0n,
      version: 1,
    });
    expect(() =>
      initializeDirectV2ReviewMutationAuthority({
        scmRepositoryIdentityId: "scm-1",
        proof: directV2Proof({ noLegacyCapabilityEverIssued: false }),
      }),
    ).toThrowError(
      expect.objectContaining({
        code: ReviewRunControlErrorCode.ProofRequired,
      }),
    );
    expect(() =>
      initializeDirectV2ReviewMutationAuthority({
        scmRepositoryIdentityId: "scm-1",
        proof: directV2Proof({ dispatchCapabilityAvailable: false }),
      }),
    ).toThrowError(
      expect.objectContaining({
        code: ReviewRunControlErrorCode.ProofRequired,
      }),
    );
    expect(
      initializeDirectV2ReviewMutationAuthority({
        scmRepositoryIdentityId: "scm-1",
        proof: directV2Proof(),
      }).authority,
    ).toMatchObject({
      mode: ReviewMutationMode.V2Active,
      epoch: 1n,
      managedWorkflowInventoryHash: hashA,
      activationSafetyDecisionHash: hashB,
    });
  });

  it("drains, only extends the cutoff, activates once, pauses, and resumes with a new epoch", () => {
    const initial = authority(ReviewMutationMode.V1Open, 0n, 1);
    const draining = beginReviewMutationDrain(initial, {
      expectedVersion: 1,
      drainPolicyVersion: 1,
      drainWindowMs: 60_000,
      now: t0,
    });
    expect(draining.authority.drainNotBefore?.toISOString()).toBe(
      "2026-01-01T00:01:00.000Z",
    );
    const shorterRetry = beginReviewMutationDrain(draining.authority, {
      expectedVersion: 1,
      drainPolicyVersion: 1,
      drainWindowMs: 30_000,
      now: t0,
    });
    expect(shorterRetry.kind).toBe(ReviewMutationTransitionKind.Idempotent);
    expect(shorterRetry.authority.version).toBe(2);

    const activated = activateReviewMutationEpoch(draining.authority, {
      expectedVersion: 2,
      proof: activationProof(2, "2026-01-01T00:01:00.000Z"),
    });
    expect(activated.authority).toMatchObject({
      mode: ReviewMutationMode.V2Active,
      epoch: 1n,
      version: 3,
    });
    const activationRetry = activateReviewMutationEpoch(activated.authority, {
      expectedVersion: 2,
      proof: activationProof(2, "2026-01-01T00:01:00.000Z"),
    });
    expect(activationRetry.kind).toBe(ReviewMutationTransitionKind.Idempotent);
    expect(activationRetry.authority.epoch).toBe(1n);

    const paused = pauseReviewMutation(activated.authority, {
      expectedVersion: 3,
      pausedAt: new Date("2026-01-01T00:02:00.000Z"),
    });
    expect(() =>
      resumeReviewMutationEpoch(paused.authority, {
        expectedVersion: 4,
        proof: resumeProof(4, "2026-01-01T00:03:00.000Z", {
          dispatchCapabilityAvailable: false,
        }),
      }),
    ).toThrowError(
      expect.objectContaining({
        code: ReviewRunControlErrorCode.ProofRequired,
      }),
    );
    const resumed = resumeReviewMutationEpoch(paused.authority, {
      expectedVersion: 4,
      proof: resumeProof(4, "2026-01-01T00:03:00.000Z"),
    });
    expect(resumed.authority).toMatchObject({
      mode: ReviewMutationMode.V2Active,
      epoch: 2n,
      version: 5,
    });
  });

  it("rejects every command from every unsupported source mode", () => {
    const commands = [
      {
        allowed: [ReviewMutationMode.V1Open, ReviewMutationMode.V1Draining],
        run: (root: ReviewMutationAuthority) =>
          beginReviewMutationDrain(root, {
            expectedVersion: root.version,
            drainPolicyVersion: 1,
            drainWindowMs: 1_000,
            now: t0,
          }),
      },
      {
        allowed: [ReviewMutationMode.V1Open, ReviewMutationMode.V1Draining],
        run: (root: ReviewMutationAuthority) =>
          abortReviewMutationDrain(root, {
            expectedVersion: root.version,
            proof: abortProof(root.version),
          }),
      },
      {
        allowed: [ReviewMutationMode.V1Draining, ReviewMutationMode.V2Active],
        run: (root: ReviewMutationAuthority) =>
          activateReviewMutationEpoch(root, {
            expectedVersion: root.version,
            proof: activationProof(root.version, "2026-01-01T01:00:00.000Z"),
          }),
      },
      {
        allowed: [ReviewMutationMode.V2Active, ReviewMutationMode.Paused],
        run: (root: ReviewMutationAuthority) =>
          pauseReviewMutation(root, {
            expectedVersion: root.version,
            pausedAt: t0,
          }),
      },
      {
        allowed: [ReviewMutationMode.Paused],
        run: (root: ReviewMutationAuthority) =>
          resumeReviewMutationEpoch(root, {
            expectedVersion: root.version,
            proof: resumeProof(root.version, t0.toISOString()),
          }),
      },
    ];
    for (const command of commands) {
      for (const mode of Object.values(ReviewMutationMode)) {
        if (command.allowed.includes(mode)) {
          continue;
        }
        expect(() =>
          command.run(
            authority(mode, mode === ReviewMutationMode.V1Open ? 0n : 1n, 1),
          ),
        ).toThrowError(
          expect.objectContaining({
            code: ReviewRunControlErrorCode.InvalidTransition,
          }),
        );
      }
    }
  });

  it("fails activation closed for time, activity, inventory, and safety proof", () => {
    const draining = beginReviewMutationDrain(
      authority(ReviewMutationMode.V1Open, 0n, 1),
      {
        expectedVersion: 1,
        drainPolicyVersion: 1,
        drainWindowMs: 60_000,
        now: t0,
      },
    ).authority;
    for (const [observedAt, override] of [
      ["2026-01-01T00:00:59.999Z", {}],
      ["2026-01-01T00:01:00.000Z", { noTrackedLegacyActivity: false }],
      ["2026-01-01T00:01:00.000Z", { workflowInventoryCompatible: false }],
      ["2026-01-01T00:01:00.000Z", { registeredReleaseSelected: false }],
      ["2026-01-01T00:01:00.000Z", { completionWorkerConfigured: false }],
      ["2026-01-01T00:01:00.000Z", { dispatchCapabilityAvailable: false }],
      ["2026-01-01T00:01:00.000Z", { safetyDecisionEnabled: false }],
    ]) {
      expect(() =>
        activateReviewMutationEpoch(draining, {
          expectedVersion: draining.version,
          proof: activationProof(
            draining.version,
            observedAt as string,
            override as Partial<ReviewMutationActivationProofFacts>,
          ),
        }),
      ).toThrowError(
        expect.objectContaining({
          code: ReviewRunControlErrorCode.ProofRequired,
        }),
      );
    }
  });

  it("increments mutation epochs beyond the safe integer range without coercion", () => {
    const largeEpoch = BigInt(Number.MAX_SAFE_INTEGER) + 100n;
    const paused = authority(ReviewMutationMode.Paused, largeEpoch, 10);
    const resumed = resumeReviewMutationEpoch(paused, {
      expectedVersion: paused.version,
      proof: resumeProof(paused.version, "2026-01-01T00:03:00.000Z"),
    });
    expect(resumed.authority.epoch).toBe(largeEpoch + 1n);
  });
});

function authority(
  mode: ReviewMutationMode,
  epoch: bigint,
  version: number,
): ReviewMutationAuthority {
  return {
    scmRepositoryIdentityId: "scm-1",
    laneKind: ReviewMutationLaneKind.HostedReviewRouterApp,
    version,
    epoch,
    mode,
    drainPolicyVersion: mode === ReviewMutationMode.V1Draining ? 1 : null,
    drainStartedAt: mode === ReviewMutationMode.V1Draining ? t0 : null,
    v1AdmissionClosedAt: mode === ReviewMutationMode.V1Draining ? t0 : null,
    drainNotBefore:
      mode === ReviewMutationMode.V1Draining
        ? new Date("2026-01-01T00:01:00.000Z")
        : null,
    managedWorkflowInventoryHash:
      mode === ReviewMutationMode.V2Active || mode === ReviewMutationMode.Paused
        ? hashA
        : null,
    activationSafetyDecisionHash:
      mode === ReviewMutationMode.V2Active || mode === ReviewMutationMode.Paused
        ? hashB
        : null,
    initializedAt: t0,
    activatedAt:
      mode === ReviewMutationMode.V2Active || mode === ReviewMutationMode.Paused
        ? t0
        : null,
    pausedAt: mode === ReviewMutationMode.Paused ? t0 : null,
  };
}

function abortProof(
  authorityVersion: number,
  facts: ReviewMutationAbortProofFacts = {
    noV2AuthorizationOrMutationExists: true,
  },
) {
  return sealReviewMutationAuthorityProof(
    {
      proofVersion: ReviewMutationAuthorityProofVersion.V1,
      kind: ReviewMutationAuthorityProofKind.AbortDrain,
      scmRepositoryIdentityId: "scm-1",
      laneKind: ReviewMutationLaneKind.HostedReviewRouterApp,
      authorityVersion,
      factsVersion: "abort-facts-v1",
      observedAt: t0.toISOString(),
      expiresAt: new Date(t0.getTime() + 60_000).toISOString(),
      facts,
    },
    hashA,
  );
}

function directV2Proof(
  overrides: Partial<ReviewMutationDirectV2InitializationProofFacts> = {},
) {
  return sealReviewMutationAuthorityProof(
    {
      proofVersion: ReviewMutationAuthorityProofVersion.V1,
      kind: ReviewMutationAuthorityProofKind.DirectV2Initialize,
      scmRepositoryIdentityId: "scm-1",
      laneKind: ReviewMutationLaneKind.HostedReviewRouterApp,
      authorityVersion: 0,
      factsVersion: "direct-v2-facts-v1",
      observedAt: t0.toISOString(),
      expiresAt: new Date(t0.getTime() + 60_000).toISOString(),
      facts: {
        freshV2OnlyProvisioningProven: true,
        noLegacyCapabilityEverIssued: true,
        dispatchCapabilityAvailable: true,
        managedWorkflowInventoryHash: hashA,
        safetyDecisionEnabled: true,
        activationSafetyDecisionHash: hashB,
        ...overrides,
      },
    },
    hashA,
  );
}

function activationProof(
  authorityVersion: number,
  observedAt: string,
  overrides: Partial<ReviewMutationActivationProofFacts> = {},
) {
  return sealReviewMutationAuthorityProof(
    {
      proofVersion: ReviewMutationAuthorityProofVersion.V1,
      kind: ReviewMutationAuthorityProofKind.Activate,
      scmRepositoryIdentityId: "scm-1",
      laneKind: ReviewMutationLaneKind.HostedReviewRouterApp,
      authorityVersion,
      factsVersion: "activation-facts-v1",
      observedAt,
      expiresAt: new Date(Date.parse(observedAt) + 60_000).toISOString(),
      facts: {
        noTrackedLegacyActivity: true,
        workflowInventoryCompatible: true,
        registeredReleaseSelected: true,
        completionWorkerConfigured: true,
        dispatchCapabilityAvailable: true,
        managedWorkflowInventoryHash: hashA,
        safetyDecisionEnabled: true,
        activationSafetyDecisionHash: hashB,
        ...overrides,
      },
    },
    hashA,
  );
}

function resumeProof(
  authorityVersion: number,
  observedAt: string,
  overrides: Partial<ReviewMutationResumeProofFacts> = {},
) {
  return sealReviewMutationAuthorityProof(
    {
      proofVersion: ReviewMutationAuthorityProofVersion.V1,
      kind: ReviewMutationAuthorityProofKind.Resume,
      scmRepositoryIdentityId: "scm-1",
      laneKind: ReviewMutationLaneKind.HostedReviewRouterApp,
      authorityVersion,
      factsVersion: "resume-facts-v1",
      observedAt,
      expiresAt: new Date(Date.parse(observedAt) + 60_000).toISOString(),
      facts: {
        unknownEffectsReconciled: true,
        repositoryBound: true,
        registeredReleaseSelected: true,
        dispatchCapabilityAvailable: true,
        safetyDecisionEnabled: true,
        activationSafetyDecisionHash: hashA,
        ...overrides,
      },
    },
    hashB,
  );
}
