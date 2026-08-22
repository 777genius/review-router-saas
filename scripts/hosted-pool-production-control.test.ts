import { describe, expect, it, vi } from "vitest";
import {
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
    counts: vi.fn(async () => counts[Math.min(index++, counts.length - 1)]!),
  };
  return { port, calls };
}

describe("hosted pool production controls", () => {
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
});
