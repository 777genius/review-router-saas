import { describe, expect, it } from "vitest";
import {
  applyStepReceipt,
  assertRollbackTargetAllowed,
  assertRunnerIdentity,
  canonicalJson,
  createReleaseRollout,
  parseRolloutPhase,
  parseRolloutStep,
  RolloutPhase,
  RolloutStep,
  sha256Canonical,
  type ActivationReceipt,
  type StepReceipt,
} from "./release-rollout";

const digest = `sha256:${"a".repeat(64)}`;
const source = {
  renderResourceId: "dpg-source-pg16",
  systemIdentifier: "741991001",
  majorVersion: 16 as const,
  recoveryWitnessSha256: "b".repeat(64),
};
const target = {
  renderResourceId: "dpg-target-pg17",
  systemIdentifier: "852002002",
  majorVersion: 17 as const,
  recoveryWitnessSha256: "c".repeat(64),
};
const create = () =>
  createReleaseRollout({
    rolloutId: "rollout-2026-08-11",
    expectedCommitSha: "d".repeat(40),
    source,
    target,
  });
const order = [
  RolloutStep.FreezeProviderServices,
  RolloutStep.ProvisionPrivateRunner,
  RolloutStep.CaptureSourceBackup,
  RolloutStep.QuiesceSource,
  RolloutStep.CopyDatabaseGeneration,
  RolloutStep.VerifyDataEquivalence,
  RolloutStep.BootstrapTargetRoles,
  RolloutStep.RunReleaseMigration,
  RolloutStep.StageTargetServices,
  RolloutStep.ActivateTargetGeneration,
  RolloutStep.VerifyTrustedRollout,
  RolloutStep.CleanupEphemeralRunner,
] as const;

function receipt(
  step: (typeof order)[number],
  index: number,
): StepReceipt | ActivationReceipt {
  const common = {
    step,
    receiptId: `receipt-${index}`,
    observedAt: `2026-08-11T00:00:${String(index).padStart(2, "0")}.000Z`,
    payloadSha256: digest,
  };
  if (step !== RolloutStep.ActivateTargetGeneration) return common;
  return {
    ...common,
    step: RolloutStep.ActivateTargetGeneration,
    sourceSystemIdentifier: source.systemIdentifier,
    targetSystemIdentifier: target.systemIdentifier,
    canonicalPrivilegesSha256: digest,
    transactionId: "transaction-activate-1",
    firstWriteBoundary: true,
  };
}

describe("release rollout domain", () => {
  it("runs the exact closed transition sequence and preserves activation", () => {
    let rollout = create();
    order.forEach((step, index) => {
      rollout = applyStepReceipt(rollout, receipt(step, index));
    });
    expect(rollout.phase).toBe(RolloutPhase.RunnerCleaned);
    expect(rollout.receipts.map((item) => item.step)).toEqual(order);
    expect(rollout.activated).toBe(true);
    expect(rollout.activationReceipt?.firstWriteBoundary).toBe(true);
  });

  it("accepts only byte-equivalent replay and rejects splice replay", () => {
    const first = receipt(order[0], 0);
    const rollout = applyStepReceipt(create(), first);
    expect(applyStepReceipt(rollout, { ...first })).toBe(rollout);
    expect(() =>
      applyStepReceipt(rollout, {
        ...first,
        payloadSha256: `sha256:${"e".repeat(64)}`,
      }),
    ).toThrow("rollout_receipt_conflicting_replay");
    expect(() =>
      applyStepReceipt(rollout, {
        ...receipt(order[1], 1),
        receiptId: first.receiptId,
      }),
    ).toThrow("rollout_receipt_conflicting_replay");
  });

  it.each(order.slice(1).map((step, index) => [step, index] as const))(
    "rejects out-of-order %s",
    (step, index) => {
      expect(() =>
        applyStepReceipt(create(), receipt(step, index + 1)),
      ).toThrow("rollout_transition_stale_or_out_of_order");
    },
  );

  it("rejects stale steps after advancement", () => {
    const rollout = applyStepReceipt(create(), receipt(order[0], 0));
    expect(() => applyStepReceipt(rollout, receipt(order[0], 2))).toThrow(
      "rollout_receipt_conflicting_replay",
    );
  });

  it("rejects wrong and non-distinct generations", () => {
    expect(() =>
      createReleaseRollout({
        rolloutId: "rollout-x",
        expectedCommitSha: "d".repeat(40),
        source: { ...source, majorVersion: 17 },
        target,
      }),
    ).toThrow("database_generation_major_version_mismatch");
    expect(() =>
      createReleaseRollout({
        rolloutId: "rollout-x",
        expectedCommitSha: "d".repeat(40),
        source,
        target: { ...target, systemIdentifier: source.systemIdentifier },
      }),
    ).toThrow("database_generations_not_distinct");
  });

  it("binds activation to both generations and a transactional first-write receipt", () => {
    let rollout = create();
    order.slice(0, 9).forEach((step, index) => {
      rollout = applyStepReceipt(rollout, receipt(step, index));
    });
    const activation = receipt(
      RolloutStep.ActivateTargetGeneration,
      9,
    ) as ActivationReceipt;
    const wrongGeneration: ActivationReceipt = {
      ...activation,
      targetSystemIdentifier: "900",
    };
    expect(() => applyStepReceipt(rollout, wrongGeneration)).toThrow(
      "activation_receipt_invalid",
    );
    expect(() =>
      applyStepReceipt(rollout, {
        ...activation,
        firstWriteBoundary: false,
      } as unknown as ActivationReceipt),
    ).toThrow("activation_receipt_invalid");
    rollout = applyStepReceipt(rollout, activation);
    expect(() =>
      assertRollbackTargetAllowed(rollout, source.systemIdentifier),
    ).toThrow("source_generation_promotion_forbidden_after_first_write");
    expect(() =>
      assertRollbackTargetAllowed(rollout, target.systemIdentifier),
    ).not.toThrow();
  });

  it("permits PG16 rollback before activation only", () => {
    expect(() =>
      assertRollbackTargetAllowed(create(), source.systemIdentifier),
    ).not.toThrow();
    expect(() => assertRollbackTargetAllowed(create(), "12345")).toThrow(
      "rollback_generation_unknown",
    );
  });

  it("uses strict enums with no unknown extension", () => {
    expect(parseRolloutPhase(RolloutPhase.Planned)).toBe(RolloutPhase.Planned);
    expect(parseRolloutStep(RolloutStep.QuiesceSource)).toBe(
      RolloutStep.QuiesceSource,
    );
    expect(() => parseRolloutPhase("pending-ish")).toThrow(
      "rollout_phase_unknown",
    );
    expect(() => parseRolloutStep("custom_step")).toThrow(
      "rollout_step_unknown",
    );
  });

  it("canonicalizes object keys and hashes deterministically", () => {
    expect(canonicalJson({ z: 1, a: { y: 2, x: 3 } })).toBe(
      '{"a":{"x":3,"y":2},"z":1}',
    );
    expect(sha256Canonical({ b: 2, a: 1 })).toBe(
      sha256Canonical({ a: 1, b: 2 }),
    );
  });

  it("binds the runner to the exact repository run attempt SHA and unique label", () => {
    const identity = {
      repository: "777genius/review-router",
      runId: "123",
      runAttempt: 2,
      commitSha: "d".repeat(40),
      jitLabel: "rr-123-2-deadbeef",
      runnerName: "render-runner-123",
      renderJobId: "job-123",
      baseServiceId: "srv-runner-base",
      baseDeployId: "dep-runner-v1",
      imageDigest: digest,
    };
    const expected = {
      repository: identity.repository,
      runId: identity.runId,
      runAttempt: identity.runAttempt,
      commitSha: identity.commitSha,
      jitLabel: identity.jitLabel,
    };
    expect(() => assertRunnerIdentity(identity, expected)).not.toThrow();
    for (const mutation of [
      { repository: "attacker/repo" },
      { runId: "124" },
      { runAttempt: 1 },
      { commitSha: "e".repeat(40) },
      { jitLabel: "reused" },
    ]) {
      expect(() =>
        assertRunnerIdentity({ ...identity, ...mutation }, expected),
      ).toThrow("runner_identity_mismatch");
    }
  });
});
