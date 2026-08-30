import { describe, expect, it, vi } from "vitest";
import { assertZeroLoginRolloverPreleaseAdmission, prepareCodexZeroLoginRollover } from "../application/use-cases/manage-codex-zero-login-rollover.js";
import type { PrepareZeroLoginRolloverInput } from "../application/ports/codex-zero-login-rollover-port.js";

const input = {
  operationId: "campaign-1:owner/repo",
  repositoryFullName: "owner/repo",
  providerInstanceId: "codex-rotating:123456",
  expectedCandidateEpoch: 4n,
  expectedRerunAttempt: "2",
  schedule: {
    runId: "987654",
    runAttempt: "1",
    eventName: "schedule",
    conclusion: "success",
    workflowActionCommitSha: "a".repeat(40),
    workflowSourceCommitSha: "b".repeat(40),
    sourceDefaultHeadSha: "c".repeat(40),
    completedAt: "2026-08-29T12:00:00.000Z",
  },
  release: {
    evidenceId: "trusted-render-overlap-1",
    actionCommitSha: "d".repeat(40),
    workflowSchemaVersion: 5,
    services: (["web", "api", "worker"] as const).map((service) => ({
      service,
      serviceId: `srv-${service}`,
      deployId: `dep-${service}`,
      liveSaasCommitSha: "e".repeat(40),
      observedAllowedActionRefs: [
        `777genius/review-router@${"a".repeat(40)}`,
        `777genius/review-router@${"d".repeat(40)}`,
      ],
      canonicalEnvironmentDigest: "f".repeat(64),
      observedAt: "2026-08-29T12:01:00.000Z",
      state: "live" as const,
    })),
  },
} satisfies PrepareZeroLoginRolloverInput;

describe("zero-login namespace rollover prepare", () => {
  it("claims only after exact schedule and all-service trusted overlap are verified", async () => {
    const prepare = vi.fn(async () => ({ id: "rollover-1" }));
    const verifyLatestSuccessfulSchedule = vi.fn(async () => input.schedule);
    const verifyTrustedRenderOverlap = vi.fn(async () => input.release);

    await expect(
      prepareCodexZeroLoginRollover(input, {
        enabled: true,
        evidence: {
          verifyLatestSuccessfulSchedule,
          verifyTrustedRenderOverlap,
        },
        ledger: { prepare } as never,
      }),
    ).resolves.toEqual({ id: "rollover-1" });
    expect(prepare).toHaveBeenCalledWith(input);
  });

  it("does not allocate when B is not staged on worker", async () => {
    const prepare = vi.fn();
    const incomplete = {
      ...input,
      release: {
        ...input.release,
        services: input.release.services.filter(
          (service) => service.service !== "worker",
        ),
      },
    } as PrepareZeroLoginRolloverInput;
    await expect(
      prepareCodexZeroLoginRollover(incomplete, {
        enabled: true,
        evidence: {
          verifyLatestSuccessfulSchedule: vi.fn(async () => incomplete.schedule),
          verifyTrustedRenderOverlap: vi.fn(async () => incomplete.release),
        },
        ledger: { prepare } as never,
      }),
    ).rejects.toThrow("zero_login_rollover_render_overlap_incomplete");
    expect(prepare).not.toHaveBeenCalled();
  });

  it("requires old A and target B to overlap on every service", async () => {
    const missingA = {
      ...input,
      release: {
        ...input.release,
        services: input.release.services.map((service) => ({
          ...service,
          observedAllowedActionRefs: service.observedAllowedActionRefs.filter(
            (ref) => !ref.endsWith(`@${input.schedule.workflowActionCommitSha}`),
          ),
        })),
      },
    } satisfies PrepareZeroLoginRolloverInput;
    await expect(
      prepareCodexZeroLoginRollover(missingA, {
        enabled: true,
        evidence: {} as never,
        ledger: {} as never,
      }),
    ).rejects.toThrow("zero_login_rollover_render_overlap_incomplete");
  });

  it("rejects an ordinary schedule attempt instead of the exact rerun attempt", async () => {
    await expect(
      prepareCodexZeroLoginRollover(
        { ...input, expectedRerunAttempt: "1" },
        {
          enabled: true,
          evidence: {} as never,
          ledger: {} as never,
        },
      ),
    ).rejects.toThrow("zero_login_rollover_prepare_invalid");
  });

  it("honors the global kill switch before evidence reads", async () => {
    const evidence = {
      verifyLatestSuccessfulSchedule: vi.fn(),
      verifyTrustedRenderOverlap: vi.fn(),
    };
    await expect(
      prepareCodexZeroLoginRollover(input, {
        enabled: false,
        evidence,
        ledger: {} as never,
      }),
    ).rejects.toThrow("zero_login_rollover_disabled");
    expect(evidence.verifyLatestSuccessfulSchedule).not.toHaveBeenCalled();
  });
});

describe("zero-login rollover locked prelease admission", () => {
  const active = {
    state: "prepared",
    sourceRunId: "987654",
    expectedRerunAttempt: "2",
    sourceWorkflowCommitSha: "b".repeat(40),
    sourceActionCommitSha: "a".repeat(40),
  };
  const exact = {
    enabled: true,
    eventName: "schedule",
    runId: "987654",
    runAttempt: "2",
    workflowCommitSha: "b".repeat(40),
    actionRef: `777genius/review-router@${"a".repeat(40)}`,
  };

  it("leaves an unrelated provider admitted because its locked query returns no row", () => {
    expect(() => assertZeroLoginRolloverPreleaseAdmission(null, exact)).not.toThrow();
  });

  it("admits only the exact authorized rerun", () => {
    expect(() => assertZeroLoginRolloverPreleaseAdmission(active, exact)).not.toThrow();
    for (const changed of [
      { eventName: "workflow_dispatch" },
      { runId: "other" },
      { runAttempt: "3" },
      { workflowCommitSha: "c".repeat(40) },
      { actionRef: `777genius/review-router@${"d".repeat(40)}` },
      { enabled: false },
    ]) {
      expect(() =>
        assertZeroLoginRolloverPreleaseAdmission(active, { ...exact, ...changed }),
      ).toThrow("codex_zero_login_rollover_prelease_blocked");
    }
  });
});
