import { describe, expect, it, vi } from "vitest";
import {
  cancelOpenStagedFaultPlans,
  executeHostedPoolControl,
  type HostedPoolControlPort,
} from "./hosted-pool-production-control";

function fixture(
  counts = [
    {
      inFlight: 0,
      issuedGrants: 0,
      unresolvedRequests: 0,
      terminalUnknownRequests: 0,
    },
  ],
) {
  const calls: unknown[] = [];
  let index = 0;
  const flags = {
    REVIEW_ROUTER_ENABLE_HOSTED_CODEX_POOL: "1",
    REVIEW_ROUTER_ENABLE_HOSTED_CODEX_CUSTODY: "1",
    REVIEW_ROUTER_ENABLE_HOSTED_CODEX_ADMISSION: "1",
    REVIEW_ROUTER_ENABLE_HOSTED_CODEX_RELAY: "1",
    REVIEW_ROUTER_ENABLE_HOSTED_CODEX_FAILOVER: "1",
  } as Record<string, "0" | "1">;
  const port: HostedPoolControlPort = {
    readFlags: vi.fn(async () => ({
      "srv-api": { ...flags } as never,
      "srv-web": { ...flags } as never,
    })),
    setFlags: vi.fn(async (patch) => {
      calls.push(patch);
      Object.assign(flags, patch);
    }),
    reconcileExpiredGrants: vi.fn(async () => ({
      expiredCount: 0,
      batches: 1,
    })),
    counts: vi.fn(async () => counts[Math.min(index++, counts.length - 1)]!),
  };
  return { port, calls };
}

describe("hosted pool production controls", () => {
  it("reconciles expired grants before each drain count", async () => {
    const calls: string[] = [];
    const { port } = fixture();
    const drainPort: HostedPoolControlPort = {
      ...port,
      async reconcileExpiredGrants() {
        calls.push("reconcile");
        return { expiredCount: 3, batches: 2 };
      },
      async counts() {
        calls.push("count");
        return {
          inFlight: 0,
          issuedGrants: 0,
          unresolvedRequests: 0,
          terminalUnknownRequests: 0,
        };
      },
    };

    const result = await executeHostedPoolControl({
      command: "drain",
      execute: true,
      confirmation: "EXECUTE HOSTED POOL DRAIN",
      port: drainPort,
      now: () => new Date("2026-08-25T12:00:00.000Z"),
    });

    expect(calls).toEqual(["count", "count", "reconcile", "count"]);
    expect(result.events).toContainEqual(
      expect.objectContaining({
        phase: "drain_poll",
        expiredGrantsReconciled: 3,
        expiryReconciliationBatches: 2,
      }),
    );
  });

  it("keeps status observation read-only", async () => {
    const { port } = fixture();
    await executeHostedPoolControl({
      command: "status",
      execute: true,
      port,
    });
    expect(port.reconcileExpiredGrants).not.toHaveBeenCalled();
  });

  it("keeps dry-run drain observation read-only", async () => {
    const { port } = fixture();
    await executeHostedPoolControl({
      command: "drain",
      execute: false,
      port,
    });
    expect(port.reconcileExpiredGrants).not.toHaveBeenCalled();
  });

  it("does not count before an in-progress drain reconciliation finishes", async () => {
    const calls: string[] = [];
    const { port } = fixture();
    let drainPhase = false;
    const guardedPort: HostedPoolControlPort = {
      ...port,
      async reconcileExpiredGrants() {
        drainPhase = true;
        calls.push("reconcile");
        return { expiredCount: 0, batches: 1 };
      },
      async counts() {
        calls.push(drainPhase ? "drain_count" : "observation_count");
        return {
          inFlight: 0,
          issuedGrants: 0,
          unresolvedRequests: 0,
          terminalUnknownRequests: 0,
        };
      },
    };
    await executeHostedPoolControl({
      command: "drain",
      execute: true,
      confirmation: "EXECUTE HOSTED POOL DRAIN",
      port: guardedPort,
    });
    expect(calls.slice(-2)).toEqual(["reconcile", "drain_count"]);
  });

  it("bounds staged-plan cleanup and reads closed targets in one query", async () => {
    const staged = [
      { workspaceId: "workspace-a", targetId: "open" },
      { workspaceId: "workspace-a", targetId: "closed" },
      { workspaceId: "workspace-a", targetId: "open" },
    ];
    const findMany = vi
      .fn()
      .mockResolvedValueOnce(staged)
      .mockResolvedValueOnce([{ targetId: "closed" }]);
    const create = vi.fn(async () => undefined);
    const prisma = {
      $transaction: vi.fn(
        async (operation: (transaction: unknown) => unknown) =>
          operation({ auditEvent: { findMany, create } }),
      ),
    };

    await cancelOpenStagedFaultPlans(
      prisma as never,
      new Date("2026-08-24T12:00:00.000Z"),
    );

    expect(findMany).toHaveBeenCalledTimes(2);
    expect(findMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({
          createdAt: { gte: new Date("2026-08-24T11:00:00.000Z") },
        }),
        take: 101,
      }),
    );
    expect(findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({
          targetId: { in: ["open", "closed"] },
        }),
      }),
    );
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ targetId: "open" }),
      }),
    );
  });

  it("activates runtime dependencies together and admission last", async () => {
    const { port, calls } = fixture();
    await executeHostedPoolControl({
      command: "activate",
      execute: true,
      confirmation: "EXECUTE HOSTED POOL ACTIVATE",
      port,
    });
    expect(calls).toEqual([
      {
        REVIEW_ROUTER_ENABLE_HOSTED_CODEX_POOL: "1",
        REVIEW_ROUTER_ENABLE_HOSTED_CODEX_CUSTODY: "1",
        REVIEW_ROUTER_ENABLE_HOSTED_CODEX_RELAY: "1",
        REVIEW_ROUTER_ENABLE_HOSTED_CODEX_FAILOVER: "1",
      },
      { REVIEW_ROUTER_ENABLE_HOSTED_CODEX_ADMISSION: "1" },
    ]);
    expect(port.readFlags).toHaveBeenCalledTimes(3);
  });
  it("is dry-run by default and does not mutate", async () => {
    const { port } = fixture();
    const result = await executeHostedPoolControl({
      command: "rollback",
      execute: false,
      port,
    });
    expect(result.result).toBe("dry_run");
    expect(port.setFlags).not.toHaveBeenCalled();
  });

  it("requires an exact command-specific confirmation", async () => {
    const { port } = fixture();
    await expect(
      executeHostedPoolControl({
        command: "kill-switch",
        execute: true,
        confirmation: "yes",
        port,
      }),
    ).rejects.toThrow("hosted_pool_control_confirmation_required");
    expect(port.setFlags).not.toHaveBeenCalled();
  });

  it("drains admission before ordered rollback and records every observation", async () => {
    const { port, calls } = fixture([
      {
        inFlight: 2,
        issuedGrants: 2,
        unresolvedRequests: 2,
        terminalUnknownRequests: 0,
      },
      {
        inFlight: 1,
        issuedGrants: 2,
        unresolvedRequests: 1,
        terminalUnknownRequests: 0,
      },
      {
        inFlight: 0,
        issuedGrants: 0,
        unresolvedRequests: 0,
        terminalUnknownRequests: 0,
      },
    ]);
    const result = await executeHostedPoolControl({
      command: "rollback",
      execute: true,
      confirmation: "EXECUTE HOSTED POOL ROLLBACK",
      port,
      sleep: async () => undefined,
      now: () => new Date("2026-08-22T00:00:00.000Z"),
    });
    expect(calls).toEqual([
      { REVIEW_ROUTER_ENABLE_HOSTED_CODEX_ADMISSION: "0" },
      { REVIEW_ROUTER_ENABLE_HOSTED_CODEX_FAILOVER: "0" },
      { REVIEW_ROUTER_ENABLE_HOSTED_CODEX_RELAY: "0" },
      { REVIEW_ROUTER_ENABLE_HOSTED_CODEX_CUSTODY: "0" },
      { REVIEW_ROUTER_ENABLE_HOSTED_CODEX_POOL: "0" },
    ]);
    expect(result.result).toBe("executed");
    expect(result.evidenceSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("fails closed when admitted work does not drain", async () => {
    const busy = {
      inFlight: 1,
      issuedGrants: 1,
      unresolvedRequests: 1,
      terminalUnknownRequests: 0,
    };
    const { port } = fixture([busy]);
    await expect(
      executeHostedPoolControl({
        command: "drain",
        execute: true,
        confirmation: "EXECUTE HOSTED POOL DRAIN",
        port,
        sleep: async () => undefined,
        maxDrainPolls: 2,
      }),
    ).rejects.toThrow("hosted_pool_admission_drain_timeout");
  });

  it("does not declare a drain while an unused issued grant remains", async () => {
    const issued = {
      inFlight: 0,
      issuedGrants: 1,
      unresolvedRequests: 0,
      terminalUnknownRequests: 0,
    };
    const { port } = fixture([issued]);
    await expect(
      executeHostedPoolControl({
        command: "drain",
        execute: true,
        confirmation: "EXECUTE HOSTED POOL DRAIN",
        port,
        sleep: async () => undefined,
        maxDrainPolls: 2,
      }),
    ).rejects.toThrow("hosted_pool_admission_drain_timeout");
  });

  it("allows an executed rollback to converge safe cross-service drift", async () => {
    const { port } = fixture();
    let firstRead = true;
    const driftPort: HostedPoolControlPort = {
      ...port,
      async readFlags() {
        if (!firstRead) return port.readFlags();
        firstRead = false;
        return {
          "srv-api": {
            REVIEW_ROUTER_ENABLE_HOSTED_CODEX_POOL: "1",
            REVIEW_ROUTER_ENABLE_HOSTED_CODEX_CUSTODY: "1",
            REVIEW_ROUTER_ENABLE_HOSTED_CODEX_ADMISSION: "0",
            REVIEW_ROUTER_ENABLE_HOSTED_CODEX_RELAY: "1",
            REVIEW_ROUTER_ENABLE_HOSTED_CODEX_FAILOVER: "1",
          },
          "srv-web": {
            REVIEW_ROUTER_ENABLE_HOSTED_CODEX_POOL: "1",
            REVIEW_ROUTER_ENABLE_HOSTED_CODEX_CUSTODY: "1",
            REVIEW_ROUTER_ENABLE_HOSTED_CODEX_ADMISSION: "1",
            REVIEW_ROUTER_ENABLE_HOSTED_CODEX_RELAY: "1",
            REVIEW_ROUTER_ENABLE_HOSTED_CODEX_FAILOVER: "1",
          },
        };
      },
    };
    await expect(
      executeHostedPoolControl({
        command: "rollback",
        execute: true,
        confirmation: "EXECUTE HOSTED POOL ROLLBACK",
        port: driftPort,
        sleep: async () => undefined,
      }),
    ).resolves.toMatchObject({ result: "executed" });
  });

  it("allows rollback to converge an initially dependency-invalid partial closure", async () => {
    const { port } = fixture();
    let firstRead = true;
    const partialClosurePort: HostedPoolControlPort = {
      ...port,
      async readFlags() {
        if (!firstRead) return port.readFlags();
        firstRead = false;
        return {
          "srv-api": {
            REVIEW_ROUTER_ENABLE_HOSTED_CODEX_POOL: "1",
            REVIEW_ROUTER_ENABLE_HOSTED_CODEX_CUSTODY: "1",
            REVIEW_ROUTER_ENABLE_HOSTED_CODEX_ADMISSION: "1",
            REVIEW_ROUTER_ENABLE_HOSTED_CODEX_RELAY: "0",
            REVIEW_ROUTER_ENABLE_HOSTED_CODEX_FAILOVER: "1",
          },
          "srv-web": {
            REVIEW_ROUTER_ENABLE_HOSTED_CODEX_POOL: "1",
            REVIEW_ROUTER_ENABLE_HOSTED_CODEX_CUSTODY: "0",
            REVIEW_ROUTER_ENABLE_HOSTED_CODEX_ADMISSION: "1",
            REVIEW_ROUTER_ENABLE_HOSTED_CODEX_RELAY: "1",
            REVIEW_ROUTER_ENABLE_HOSTED_CODEX_FAILOVER: "1",
          },
        };
      },
    };
    await expect(
      executeHostedPoolControl({
        command: "rollback",
        execute: true,
        confirmation: "EXECUTE HOSTED POOL ROLLBACK",
        port: partialClosurePort,
        sleep: async () => undefined,
      }),
    ).resolves.toMatchObject({ result: "executed" });
  });

  it("attempts every rollback closure and final reread after failures", async () => {
    const { port } = fixture();
    const patches: unknown[] = [];
    const failing: HostedPoolControlPort = {
      ...port,
      async setFlags(patch) {
        patches.push(patch);
        if ("REVIEW_ROUTER_ENABLE_HOSTED_CODEX_FAILOVER" in patch)
          throw new Error("fixture_failover_close_failed");
        await port.setFlags(patch);
      },
    };
    await expect(
      executeHostedPoolControl({
        command: "rollback",
        execute: true,
        confirmation: "EXECUTE HOSTED POOL ROLLBACK",
        port: failing,
        sleep: async () => undefined,
      }),
    ).rejects.toThrow("hosted_pool_rollback_aggregate_failure");
    expect(patches).toEqual([
      { REVIEW_ROUTER_ENABLE_HOSTED_CODEX_ADMISSION: "0" },
      { REVIEW_ROUTER_ENABLE_HOSTED_CODEX_FAILOVER: "0" },
      { REVIEW_ROUTER_ENABLE_HOSTED_CODEX_RELAY: "0" },
      { REVIEW_ROUTER_ENABLE_HOSTED_CODEX_CUSTODY: "0" },
      { REVIEW_ROUTER_ENABLE_HOSTED_CODEX_POOL: "0" },
    ]);
    expect(port.readFlags).toHaveBeenCalledTimes(7);
  });
});
