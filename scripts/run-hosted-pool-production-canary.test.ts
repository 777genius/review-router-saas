import { describe, expect, it, vi } from "vitest";
import {
  assertClassifiedOutcome,
  parseHostedPoolCanaryConfig,
  runHostedPoolProductionCanary,
  type CanaryRunEvidence,
  type HostedPoolCanaryPort,
} from "./run-hosted-pool-production-canary";
import type { HostedPoolControlPort } from "./hosted-pool-production-control";

const sha = "a".repeat(40);
const env = {
  REVIEW_ROUTER_HOSTED_POOL_CANARY_REPOSITORY_ID: "123456789",
  REVIEW_ROUTER_HOSTED_POOL_CANARY_INSTALLATION_ID: "987654321",
  REVIEW_ROUTER_HOSTED_POOL_CANARY_REPOSITORY_ALLOWLIST: "123456789",
  REVIEW_ROUTER_HOSTED_POOL_CANARY_ACTION_SHA: sha,
  REVIEW_ROUTER_HOSTED_POOL_ACTION_SHA: sha,
  REVIEW_ROUTER_CODEX_ROTATING_ACTION_REF: `777genius/review-router@${sha}`,
  REVIEW_ROUTER_HOSTED_POOL_CANARY_APP_SLUG: "reviewrouter-app",
  REVIEW_ROUTER_HOSTED_POOL_CANARY_RUN_IDS_JSON: JSON.stringify({
    simultaneous_a: 11,
    simultaneous_b: 12,
    unauthorized: 13,
    rate_limited: 14,
    dropped_response: 15,
  }),
};

function evidence(
  runId: number,
  mode: "success" | "401" | "429" | "dropped" = "success",
): CanaryRunEvidence {
  if (mode === "dropped")
    return {
      runId,
      invocationId: `inv-${runId}`,
      activeAccountId: "account-a",
      primaryAccountId: "account-a",
      backupAccountId: "account-b",
      failoverCount: 0,
      grantStatus: "exhausted",
      requestStatuses: ["terminal_unknown"],
      attempts: [
        {
          ordinal: 1,
          state: "terminal_unknown",
          errorCode: "ambiguous_dropped_response",
          accountId: "account-a",
        },
      ],
    };
  const failed = mode === "401" || mode === "429";
  return {
    runId,
    invocationId: `inv-${runId}`,
    activeAccountId: failed ? "account-b" : "account-a",
    primaryAccountId: "account-a",
    backupAccountId: "account-b",
    failoverCount: failed ? 1 : 0,
    grantStatus: "exhausted",
    requestStatuses: ["succeeded"],
    attempts: failed
      ? [
          {
            ordinal: 1,
            state: "failed_classified",
            errorCode: mode === "401" ? "credential_invalid" : "quota_limited",
            accountId: "account-a",
          },
          {
            ordinal: 2,
            state: "succeeded",
            errorCode: null,
            accountId: "account-b",
          },
        ]
      : [
          {
            ordinal: 1,
            state: "succeeded",
            errorCode: null,
            accountId: "account-a",
          },
        ],
  };
}

function kit() {
  const config = parseHostedPoolCanaryConfig(env);
  const rerun = vi.fn(async () => undefined);
  const values = new Map([
    [11, evidence(11)],
    [12, evidence(12)],
    [13, evidence(13, "401")],
    [14, evidence(14, "429")],
    [15, evidence(15, "dropped")],
  ]);
  const canary: HostedPoolCanaryPort = {
    preflight: vi.fn(async () => ({ exact: true })),
    rerun,
    waitForSuccess: vi.fn(async () => undefined),
    evidence: vi.fn(async (runId) => values.get(runId)!),
  };
  const setFlags = vi.fn(async () => undefined);
  const flags = Object.fromEntries(
    ["POOL", "CUSTODY", "ADMISSION", "RELAY", "FAILOVER"].map((name) => [
      `REVIEW_ROUTER_ENABLE_HOSTED_CODEX_${name}`,
      "1",
    ]),
  ) as Record<string, "0" | "1">;
  const control: HostedPoolControlPort = {
    readFlags: vi.fn(async () => ({
      api: { ...flags } as never,
      web: { ...flags } as never,
    })),
    setFlags: vi.fn(async (patch) => {
      setFlags(patch);
      Object.assign(flags, patch);
    }),
    counts: vi.fn(async () => ({
      inFlight: 0,
      issuedGrants: 0,
      unresolvedRequests: 0,
      terminalUnknownRequests: 1,
    })),
  };
  return { config, canary, control, rerun, setFlags };
}

describe("hosted pool one-shot production canary", () => {
  it("rejects every repository except the exact numeric disposable target", () => {
    expect(() =>
      parseHostedPoolCanaryConfig({
        ...env,
        REVIEW_ROUTER_HOSTED_POOL_CANARY_REPOSITORY_ALLOWLIST: "123456789,2",
      }),
    ).toThrow("hosted_pool_canary_exact_repository_allowlist_required");
    expect(() =>
      parseHostedPoolCanaryConfig({
        ...env,
        REVIEW_ROUTER_HOSTED_POOL_CANARY_REPOSITORY_ID: "123456788",
      }),
    ).toThrow("hosted_pool_canary_exact_repository_allowlist_required");
  });

  it("defaults to preflight-only dry run with no provider run or rollback", async () => {
    const { config, canary, control, rerun, setFlags } = kit();
    const result = await runHostedPoolProductionCanary({
      config,
      execute: false,
      canary,
      control,
    });
    expect(result.result).toBe("dry_run");
    expect(rerun).not.toHaveBeenCalled();
    expect(setFlags).not.toHaveBeenCalled();
  });

  it("requires independent execution and rollback confirmations", async () => {
    const { config, canary, control } = kit();
    await expect(
      runHostedPoolProductionCanary({
        config,
        execute: true,
        executeConfirmation: "yes",
        rollbackConfirmation: "yes",
        canary,
        control,
      }),
    ).rejects.toThrow("hosted_pool_canary_confirmations_required");
  });

  it("runs simultaneous reviews, classified faults, and always ordered rollback", async () => {
    const { config, canary, control, rerun, setFlags } = kit();
    const result = await runHostedPoolProductionCanary({
      config,
      execute: true,
      executeConfirmation: "EXECUTE ONE SHOT HOSTED POOL CANARY",
      rollbackConfirmation: "ROLL BACK HOSTED POOL AFTER CANARY",
      canary,
      control,
      now: () => new Date("2026-08-22T00:00:00.000Z"),
    });
    expect(rerun.mock.calls.map(([runId]) => runId)).toEqual([
      11, 12, 13, 14, 15,
    ]);
    expect(setFlags.mock.calls.map(([patch]) => patch)).toEqual([
      { REVIEW_ROUTER_ENABLE_HOSTED_CODEX_ADMISSION: "0" },
      { REVIEW_ROUTER_ENABLE_HOSTED_CODEX_FAILOVER: "0" },
      { REVIEW_ROUTER_ENABLE_HOSTED_CODEX_RELAY: "0" },
      { REVIEW_ROUTER_ENABLE_HOSTED_CODEX_CUSTODY: "0" },
      { REVIEW_ROUTER_ENABLE_HOSTED_CODEX_POOL: "0" },
    ]);
    expect(result.result).toBe("passed");
  });

  it("forbids replay after an ambiguous dropped response", () => {
    expect(() =>
      assertClassifiedOutcome(
        {
          ...evidence(15, "dropped"),
          attempts: [
            ...evidence(15, "dropped").attempts,
            {
              ordinal: 2,
              state: "succeeded",
              errorCode: null,
              accountId: "account-b",
            },
          ],
        },
        "dropped",
      ),
    ).toThrow("hosted_pool_canary_dropped_response_replayed");
  });

  it("stops after the first failed phase and still performs ordered rollback", async () => {
    const { config, canary, control, rerun, setFlags } = kit();
    vi.mocked(canary.waitForSuccess).mockRejectedValueOnce(
      new Error("fixture_run_failed"),
    );
    const result = await runHostedPoolProductionCanary({
      config,
      execute: true,
      executeConfirmation: "EXECUTE ONE SHOT HOSTED POOL CANARY",
      rollbackConfirmation: "ROLL BACK HOSTED POOL AFTER CANARY",
      canary,
      control,
      now: () => new Date("2026-08-22T00:00:00.000Z"),
    });
    expect(result.result).toBe("failed");
    expect(rerun).toHaveBeenCalledTimes(2);
    expect(setFlags.mock.calls.map(([patch]) => patch)).toEqual([
      { REVIEW_ROUTER_ENABLE_HOSTED_CODEX_ADMISSION: "0" },
      { REVIEW_ROUTER_ENABLE_HOSTED_CODEX_FAILOVER: "0" },
      { REVIEW_ROUTER_ENABLE_HOSTED_CODEX_RELAY: "0" },
      { REVIEW_ROUTER_ENABLE_HOSTED_CODEX_CUSTODY: "0" },
      { REVIEW_ROUTER_ENABLE_HOSTED_CODEX_POOL: "0" },
    ]);
  });
});
