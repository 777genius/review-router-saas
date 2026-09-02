import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { normalizeExpiredHostedAccountCooldownWithCas } from "../infrastructure/prisma/prisma-hosted-account-cooldown";

const now = new Date("2026-08-25T12:00:00.000Z");

describe("Prisma hosted account cooldown normalization", () => {
  it("uses state, expiry, and healthVersion as an account-scoped CAS", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      hostedCodexAccount: { updateMany, findUnique: vi.fn() },
    } as unknown as PrismaClient;

    await expect(
      normalizeExpiredHostedAccountCooldownWithCas(prisma, {
        accountId: "account-1",
        now,
        snapshot: {
          state: "cooldown",
          cooldownUntil: new Date(now.getTime() - 1),
          healthVersion: 7n,
        },
      }),
    ).resolves.toBe(true);
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: "account-1",
        state: "cooldown",
        cooldownUntil: { lte: now },
        healthVersion: 7n,
      },
      data: {
        state: "healthy",
        cooldownUntil: null,
        healthVersion: 8n,
        lastHealthyAt: now,
        updatedAt: now,
      },
    });
  });

  it("accepts a concurrent winner without writing a second transition", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const findUnique = vi.fn().mockResolvedValue({
      state: "healthy",
      cooldownUntil: null,
      healthVersion: 8n,
    });
    const prisma = {
      hostedCodexAccount: { updateMany, findUnique },
    } as unknown as PrismaClient;

    await expect(
      normalizeExpiredHostedAccountCooldownWithCas(prisma, {
        accountId: "account-1",
        now,
        snapshot: {
          state: "cooldown",
          cooldownUntil: new Date(now.getTime() - 1),
          healthVersion: 7n,
        },
      }),
    ).resolves.toBe(true);
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(findUnique).toHaveBeenCalledTimes(1);
  });

  it("treats a transaction write conflict as a concurrent CAS loss", async () => {
    const conflict = new Error("TransactionWriteConflict");
    const updateMany = vi.fn().mockRejectedValue(conflict);
    const findUnique = vi.fn().mockResolvedValue({
      state: "healthy",
      cooldownUntil: null,
      healthVersion: 8n,
    });
    const prisma = {
      hostedCodexAccount: { updateMany, findUnique },
    } as unknown as PrismaClient;

    await expect(
      normalizeExpiredHostedAccountCooldownWithCas(prisma, {
        accountId: "account-1",
        now,
        snapshot: {
          state: "cooldown",
          cooldownUntil: new Date(now.getTime() - 1),
          healthVersion: 7n,
        },
      }),
    ).resolves.toBe(true);
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(findUnique).toHaveBeenCalledTimes(1);
  });

  it("rejects a fresh cooldown without attempting a write", async () => {
    const updateMany = vi.fn();
    const prisma = {
      hostedCodexAccount: { updateMany, findUnique: vi.fn() },
    } as unknown as PrismaClient;

    await expect(
      normalizeExpiredHostedAccountCooldownWithCas(prisma, {
        accountId: "account-1",
        now,
        snapshot: {
          state: "cooldown",
          cooldownUntil: new Date(now.getTime() + 1),
          healthVersion: 7n,
        },
      }),
    ).resolves.toBe(false);
    expect(updateMany).not.toHaveBeenCalled();
  });
});
