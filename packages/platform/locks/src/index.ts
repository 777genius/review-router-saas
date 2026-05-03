import { createHash } from "node:crypto";
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

export class PostgresAdvisoryLock implements DistributedLock {
  constructor(private readonly prisma: PrismaClient) {}

  async withLock<T>(
    key: string,
    _ttlMs: number,
    run: () => Promise<T>,
  ): Promise<T> {
    const lockId = advisoryLockId(key);
    const acquired = await this.prisma.$queryRaw<
      readonly { locked: boolean }[]
    >`
      SELECT pg_try_advisory_lock(${lockId}) AS locked
    `;

    if (acquired[0]?.locked !== true) {
      throw new Error(`distributed_lock_not_acquired:${key}`);
    }

    try {
      return await run();
    } finally {
      await this.prisma.$queryRaw`
        SELECT pg_advisory_unlock(${lockId})
      `;
    }
  }
}

export function advisoryLockId(key: string): bigint {
  const digest = createHash("sha256").update(key).digest();
  return digest.readBigInt64BE(0);
}
