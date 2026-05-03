import { describe, expect, it } from "vitest";
import { InMemoryLock, PostgresLeaseLock } from "./index.js";

describe("distributed locks", () => {
  it("rejects lock contention in the in-memory adapter", async () => {
    const lock = new InMemoryLock();
    let release!: () => void;
    const first = lock.withLock(
      "repo:1:workflow-provision",
      1_000,
      () => new Promise<void>((resolve) => (release = resolve)),
    );

    await expect(
      lock.withLock("repo:1:workflow-provision", 1_000, async () => undefined),
    ).rejects.toThrow("Lock already held");

    release();
    await first;
  });

  it("rejects invalid lock input before touching Postgres", async () => {
    const lock = new PostgresLeaseLock({} as never);

    await expect(
      lock.withLock("", 1_000, async () => undefined),
    ).rejects.toThrow("distributed_lock_key_required");
    await expect(
      lock.withLock("repo:1:workflow-provision", 0, async () => undefined),
    ).rejects.toThrow("distributed_lock_ttl_invalid");
    await expect(
      lock.withLock("x".repeat(501), 1_000, async () => undefined),
    ).rejects.toThrow("distributed_lock_key_too_long");
  });
});
