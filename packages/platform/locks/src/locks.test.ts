import { describe, expect, it } from "vitest";
import { advisoryLockId, InMemoryLock } from "./index.js";

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

  it("maps lock keys to stable 64-bit advisory ids", () => {
    expect(advisoryLockId("installation:129154876:sync")).toBe(
      advisoryLockId("installation:129154876:sync"),
    );
    expect(advisoryLockId("installation:129154876:sync")).not.toBe(
      advisoryLockId("installation:129154877:sync"),
    );
  });
});
