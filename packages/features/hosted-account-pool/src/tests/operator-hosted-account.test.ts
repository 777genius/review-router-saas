import { describe, expect, it, vi } from "vitest";
import {
  enrollHostedPoolAccount,
  type HostedPoolAccount,
} from "../domain/account-pool";
import {
  hostedAccountId,
  hostedPoolId,
  workspaceId,
} from "../domain/identifiers";
import type { HostedAccountRepositoryPort } from "../application/ports/hosted-account-repository-port";
import { reconnectHostedAccount } from "../application/use-cases/reconnect-hosted-account";
import { operatorImportHostedAccount } from "../application/use-cases/operator-import-hosted-account";

const now = new Date("2026-09-06T00:00:00Z");
function fixture() {
  const rows: HostedPoolAccount[] = [];
  const account = {
    ...enrollHostedPoolAccount({
      id: hostedAccountId("account"),
      poolId: hostedPoolId("pool"),
      label: "primary",
      priority: 0,
      credential: {
        credentialRef: "opaque",
        subjectFingerprint: "same-subject",
        authGeneration: 3,
        validatedAt: now,
        expiresAt: null,
      },
      now,
    }),
    availability: { status: "paused" as const, reason: "Operator" },
  };
  const accounts: HostedAccountRepositoryPort = {
    findById: async (id) => rows.find((row) => row.id === id) ?? null,
    findBySubjectFingerprint: async (input) =>
      rows.find(
        (row) =>
          row.poolId === input.poolId &&
          row.credential.subjectFingerprint === input.subjectFingerprint,
      ) ?? null,
    listByPoolId: async (id) => rows.filter((row) => row.poolId === id),
    replaceCredential: async () => {
      throw new Error("generic refresh path must not be used");
    },
    saveAvailability: async () => {
      throw new Error("replacement must preserve pause");
    },
  };
  return {
    account,
    accounts,
    add: (row = account) => {
      rows.push(row);
    },
  };
}

describe("operator account import", () => {
  const command = () => ({
    workspaceId: workspaceId("workspace"),
    poolId: hostedPoolId("pool"),
    accountId: hostedAccountId("new"),
    label: "primary",
    priority: 0,
    expectedPoolRevision: 1,
    authJsonBytes: Buffer.from("temporary fake bytes"),
    requestedAt: now,
  });
  it("rereads duplicates and preserves the canonical RR generation", async () => {
    const f = fixture();
    f.add();
    const importCodexAuth = vi.fn();
    const input = command();
    expect(
      await operatorImportHostedAccount(input, {
        accounts: f.accounts,
        fingerprint: () => "same-subject",
        credentialEnrollment: { importCodexAuth },
      }),
    ).toEqual({
      status: "already_imported",
      accountId: "account",
      generation: 3,
    });
    expect(importCodexAuth).not.toHaveBeenCalled();
    expect(input.authJsonBytes.every((byte) => byte === 0)).toBe(true);
  });
  it("reconciles a lost enrollment response without a second write", async () => {
    const f = fixture();
    const importCodexAuth = vi.fn(async () => {
      f.add();
      throw new Error("fake transport response lost");
    });
    expect(
      await operatorImportHostedAccount(command(), {
        accounts: f.accounts,
        fingerprint: () => "same-subject",
        credentialEnrollment: { importCodexAuth },
      }),
    ).toMatchObject({ status: "already_imported", generation: 3 });
    expect(importCodexAuth).toHaveBeenCalledTimes(1);
  });
  it("rejects a reused label for another identity before effects", async () => {
    const f = fixture();
    f.add();
    const importCodexAuth = vi.fn();
    await expect(
      operatorImportHostedAccount(command(), {
        accounts: f.accounts,
        fingerprint: () => "other-subject",
        credentialEnrollment: { importCodexAuth },
      }),
    ).rejects.toThrow("label_conflict");
    expect(importCodexAuth).not.toHaveBeenCalled();
  });
});

describe("operator reconnect", () => {
  function setup() {
    const f = fixture();
    f.add();
    const command = {
      workspaceId: workspaceId("workspace"),
      poolId: hostedPoolId("pool"),
      accountId: f.account.id,
      expectedGeneration: 3,
      expectedHealthVersion: 1,
      authJsonBytes: Buffer.from("fake input"),
    };
    const dependencies = {
      accounts: f.accounts,
      validate: vi.fn(() => ({
        fingerprint: "same-subject",
        generationHash: "hash",
      })),
      acquire: vi.fn(async () => "real-fence-port"),
      release: vi.fn(async () => {}),
      commit: vi.fn(async () => ({ status: "accepted", generation: 4 })),
    };
    return { command, dependencies };
  }
  it.each([
    { expectedGeneration: 2 },
    { expectedHealthVersion: 2 },
    { poolId: hostedPoolId("foreign") },
  ])("rejects stale/foreign input before lease %j", async (change) => {
    const f = setup();
    await expect(
      reconnectHostedAccount({ ...f.command, ...change }, f.dependencies),
    ).rejects.toThrow("conflict");
    expect(f.dependencies.acquire).not.toHaveBeenCalled();
  });
  it("rejects a different subject before lease acquisition", async () => {
    const f = setup();
    f.dependencies.validate.mockReturnValue({
      fingerprint: "other",
      generationHash: "hash",
    });
    await expect(
      reconnectHostedAccount(f.command, f.dependencies),
    ).rejects.toThrow("identity_drift");
    expect(f.dependencies.acquire).not.toHaveBeenCalled();
    expect(f.dependencies.commit).not.toHaveBeenCalled();
  });
  it("releases the short fence and wipes bytes on a CAS race", async () => {
    const f = setup();
    f.dependencies.commit.mockResolvedValue({
      status: "stale_generation",
      generation: 4,
    });
    await expect(
      reconnectHostedAccount(f.command, f.dependencies),
    ).rejects.toThrow("conflict");
    expect(f.dependencies.release).toHaveBeenCalledWith("real-fence-port");
    expect(f.command.authJsonBytes.every((byte) => byte === 0)).toBe(true);
  });
  it("returns only safe receipt metadata on replacement", async () => {
    const f = setup();
    expect(await reconnectHostedAccount(f.command, f.dependencies)).toEqual({
      status: "replaced",
      accountId: "account",
      generation: 4,
    });
    expect(f.dependencies.release).toHaveBeenCalledTimes(1);
  });
});
