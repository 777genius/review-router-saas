import { describe, expect, it } from "vitest";
import {
  assertPromotionAllowed,
  beginCompensation,
  completeCompensation,
  createReleaseRollout,
  RolloutPhase,
  RolloutStep,
  transitionFailure,
  transitionFromObservation,
} from "./release-rollout";

const digest = `sha256:${"a".repeat(64)}`;
const create = () =>
  createReleaseRollout({
    rolloutId: "rollout-2026-08-12",
    expectedCommitSha: "d".repeat(40),
    execution: {
      organization: "reviewrouter-control",
      controlRepository: "reviewrouter-control/releases",
      workflowPath: ".github/workflows/private-network-pg17-rollout.yml",
      workflowRef: "refs/heads/main",
      event: "workflow_dispatch",
      actor: "release-operator",
      runId: "123",
      runAttempt: 1,
      expectedJobName: "copy-and-role-bootstrap-private",
    },
    source: {
      renderResourceId: "dpg-source",
      internalHostname: "dpg-source.internal",
      databaseName: "reviewrouter",
      systemIdentifier: "100",
      majorVersion: 16,
      recoveryWitnessSha256: "b".repeat(64),
    },
    target: {
      renderResourceId: "dpg-target",
      internalHostname: "dpg-target.internal",
      databaseName: "reviewrouter",
      systemIdentifier: "200",
      majorVersion: 17,
      recoveryWitnessSha256: "c".repeat(64),
    },
  });
const steps = [
  RolloutStep.ClaimRollout,
  RolloutStep.FreezeProviderServices,
  RolloutStep.ProvisionRoleRunner,
  RolloutStep.CaptureSourceBackup,
  RolloutStep.QuiesceSource,
  RolloutStep.CopyDatabaseGeneration,
  RolloutStep.VerifyDataEquivalence,
  RolloutStep.BootstrapTargetRoles,
  RolloutStep.CleanupRoleRunner,
  RolloutStep.ProvisionCutoverRunner,
  RolloutStep.RunReleaseMigration,
  RolloutStep.StageTargetServices,
  RolloutStep.ActivateTargetGeneration,
  RolloutStep.CleanupCutoverRunner,
  RolloutStep.ResumeTargetServices,
  RolloutStep.VerifyLiveCanary,
  RolloutStep.VerifyTrustedRollout,
] as const;
const observe = (step: (typeof steps)[number], index: number) => ({
  step,
  observedAt: `2026-08-12T00:00:${String(index).padStart(2, "0")}.000Z`,
  facts:
    step === RolloutStep.ActivateTargetGeneration
      ? {
          firstWriteBoundary: true,
          canonicalPrivilegesSha256: digest,
          catalogFactsSha256: digest,
          firstWriteReceiptSha256: digest,
          transactionId: "42",
        }
      : { observed: true },
});

describe("release rollout domain policy", () => {
  it("hash-chains observation-derived receipts through activation, resume, cleanup, and verification", () => {
    let rollout = create();
    steps.forEach((step, index) => {
      rollout = transitionFromObservation(rollout, observe(step, index));
    });
    expect(rollout.phase).toBe(RolloutPhase.RolloutVerified);
    expect(rollout.receipts[0]?.previousReceiptSha256).toBe(
      `sha256:${"0".repeat(64)}`,
    );
    expect(rollout.receipts[1]?.previousReceiptSha256).toBe(
      rollout.receipts[0]?.receiptSha256,
    );
    expect(rollout.sourcePermanentlyIneligible).toBe(true);
  });

  it("rejects replay, transplant secrets, out-of-order transitions, and retry attempts", () => {
    const first = transitionFromObservation(
      create(),
      observe(RolloutStep.ClaimRollout, 0),
    );
    expect(() =>
      transitionFromObservation(first, observe(RolloutStep.ClaimRollout, 1)),
    ).toThrow("rollout_receipt_replay_forbidden");
    expect(() =>
      transitionFromObservation(
        create(),
        observe(RolloutStep.QuiesceSource, 1),
      ),
    ).toThrow("rollout_transition_stale_or_out_of_order");
    expect(() =>
      transitionFromObservation(create(), {
        ...observe(RolloutStep.ClaimRollout, 0),
        facts: { url: "postgresql://user:password@db.internal/x" },
      }),
    ).toThrow("rollout_observation_contains_secret");
    expect(() =>
      createReleaseRollout({
        ...create(),
        execution: { ...create().execution, runAttempt: 2 },
      }),
    ).toThrow("release_run_retry_forbidden");
  });

  it("permits complete pre-activation compensation but permanently bans PG16 after activation uncertainty", () => {
    const pre = transitionFailure(create(), "definite_pre_activation");
    expect(completeCompensation(beginCompensation(pre)).phase).toBe(
      RolloutPhase.RecoveryCompensated,
    );
    const uncertain = transitionFailure(create(), "activation_uncertain");
    expect(() => beginCompensation(uncertain)).toThrow(
      "source_compensation_forbidden",
    );
    expect(() =>
      assertPromotionAllowed(uncertain, uncertain.source.systemIdentifier),
    ).toThrow("source_generation_permanently_ineligible");
    expect(() =>
      assertPromotionAllowed(uncertain, uncertain.target.systemIdentifier),
    ).not.toThrow();
  });

  it("requires an organization-owned control repository and distinct observed generations", () => {
    expect(() =>
      createReleaseRollout({
        ...create(),
        execution: { ...create().execution, organization: "other" },
      }),
    ).toThrow("release_control_repository_not_organization_owned");
    expect(() =>
      createReleaseRollout({
        ...create(),
        target: { ...create().target, systemIdentifier: "100" },
      }),
    ).toThrow("database_generations_not_distinct");
  });
});
