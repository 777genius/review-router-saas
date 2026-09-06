import type { PrismaClient } from "@reviewrouter/platform-db";
import { describe, expect, it } from "vitest";
import { setOperatorHostedAccountState } from "./hosted-pool-operator-account-state";

function fixture(state: string) {
  const now = new Date();
  let row = {
    id: "account",
    poolId: "pool",
    label: "primary",
    priority: 1,
    accountFingerprint: "fake-subject",
    state,
    cooldownUntil: null,
    healthVersion: 1n,
    activeGeneration: 1n,
    createdAt: now,
    updatedAt: now,
    credentialVersions: [
      {
        id: "version",
        generation: 1n,
        credentialExpiresAt: null,
        createdAt: now,
      },
    ],
  };
  const audit: { action: string; metadata: { generation: string } }[] = [];
  const tx = {
    hostedCodexAccount: {
      findFirst: async () => row,
      findUnique: async () => row,
      updateMany: async ({
        where,
        data,
      }: {
        where: { healthVersion: bigint };
        data: Partial<typeof row>;
      }) => {
        if (row.healthVersion !== where.healthVersion) return { count: 0 };
        row = { ...row, ...data };
        return { count: 1 };
      },
    },
    auditEvent: {
      findFirst: async ({
        where,
      }: {
        where: { action: string; metadata: { equals: string } };
      }) =>
        audit.find(
          (event) =>
            event.action === where.action &&
            event.metadata.generation === where.metadata.equals,
        ) ?? null,
      create: async ({ data }: { data: (typeof audit)[number] }) => {
        audit.push(data);
      },
    },
  };
  const prisma = {
    $transaction: async (work: (client: typeof tx) => Promise<unknown>) =>
      work(tx),
  } as unknown as PrismaClient;
  const run = (
    action: "pause" | "resume",
    expectedHealthVersion = Number(row.healthVersion),
  ) =>
    setOperatorHostedAccountState({
      prisma,
      workspaceId: "workspace",
      operatorId: "operator",
      accountId: row.id,
      expectedHealthVersion,
      action,
    });
  return {
    run,
    current: () => row,
    audit,
    relogin: () => {
      row = {
        ...row,
        activeGeneration: 2n,
        healthVersion: row.healthVersion + 1n,
        credentialVersions: [{ ...row.credentialVersions[0]!, generation: 2n }],
      };
    },
  };
}
describe("operator pause/resume", () => {
  it("supports ordinary pause/resume with health CAS", async () => {
    const f = fixture("healthy");
    await f.run("pause");
    expect(f.current().state).toBe("paused");
    await expect(f.run("resume", 1)).rejects.toThrow("health_version_conflict");
    expect(f.current().state).toBe("paused");
    await f.run("resume");
    expect(f.current().state).toBe("healthy");
  });
  it("cannot erase invalid-auth provenance by pausing twice", async () => {
    const f = fixture("restore_quarantined");
    await f.run("pause");
    await f.run("pause");
    await expect(f.run("resume")).rejects.toThrow("requires_relogin");
    expect(f.current().state).toBe("paused");
    f.relogin();
    await f.run("resume");
    expect(f.current().state).toBe("healthy");
  });
  it("does not resume an unpaused invalid account", async () => {
    const f = fixture("restore_quarantined");
    await expect(f.run("resume")).rejects.toThrow("requires_relogin");
    expect(f.audit).toHaveLength(0);
  });
});
