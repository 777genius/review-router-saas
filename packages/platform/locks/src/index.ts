import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";

export interface DistributedLock {
  withLock<T>(key: string, ttlMs: number, run: () => Promise<T>): Promise<T>;
}

export class InMemoryLock implements DistributedLock {
  private readonly active = new Set<string>();

  async withLock<T>(
    key: string,
    _ttlMs: number,
    run: () => Promise<T>,
  ): Promise<T> {
    if (this.active.has(key)) throw new Error(`Lock already held: ${key}`);
    this.active.add(key);
    try {
      return await run();
    } finally {
      this.active.delete(key);
    }
  }
}

export class PostgresLeaseLock implements DistributedLock {
  constructor(private readonly prisma: PrismaClient) {}

  async withLock<T>(
    key: string,
    ttlMs: number,
    run: () => Promise<T>,
  ): Promise<T> {
    assertLockInput(key, ttlMs);
    const owner = randomUUID();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMs);
    const acquired = await this.prisma.$queryRaw<readonly { owner: string }[]>`
      INSERT INTO "DistributedLock" (
        "key",
        "owner",
        "expiresAt",
        "createdAt",
        "updatedAt"
      )
      VALUES (
        ${key},
        ${owner},
        ${expiresAt},
        ${now},
        ${now}
      )
      ON CONFLICT ("key") DO UPDATE SET
        "owner" = EXCLUDED."owner",
        "expiresAt" = EXCLUDED."expiresAt",
        "updatedAt" = EXCLUDED."updatedAt"
      WHERE "DistributedLock"."expiresAt" <= ${now}
      RETURNING "owner"
    `;

    if (acquired[0]?.owner !== owner) {
      throw new Error(`distributed_lock_not_acquired:${key}`);
    }

    try {
      return await run();
    } finally {
      await this.prisma.$executeRaw`
        DELETE FROM "DistributedLock"
        WHERE "key" = ${key}
        AND "owner" = ${owner}
      `;
    }
  }
}

export class PostgresAdvisoryLock extends PostgresLeaseLock {}

function assertLockInput(key: string, ttlMs: number): void {
  if (key.trim().length === 0) {
    throw new Error("distributed_lock_key_required");
  }
  if (key.length > 500) {
    throw new Error("distributed_lock_key_too_long");
  }
  if (!Number.isInteger(ttlMs) || ttlMs <= 0) {
    throw new Error("distributed_lock_ttl_invalid");
  }
}
