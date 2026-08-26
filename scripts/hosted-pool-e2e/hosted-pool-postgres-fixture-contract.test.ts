import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  checkedMintTemporalFixture,
  runHostedPoolFixtureTeardown,
} from "./hosted-pool-postgres-fixture-contract";

describe("PostgreSQL mint recovery fixture contract", () => {
  it("tracks the exact database temporal shape invariant", () => {
    const migration = readFileSync(
      "packages/platform/db/prisma/migrations/000083_hosted_codex_comment_token_mint_protocol/migration.sql",
      "utf8",
    );
    const remediation = readFileSync(
      "packages/platform/db/prisma/migrations/000086_comment_token_custody_r18_remediation/migration.sql",
      "utf8",
    );
    expect(migration).toContain('"dispatchAuthorizedUntil" <= "unsafeUntil"');
    expect(migration).toContain('"tokenExpiresAt" <= "unsafeUntil"');
    expect(remediation).not.toMatch(
      /DROP\s+CONSTRAINT\s+"HostedCodexCommentTokenMint_shape_check"/iu,
    );
  });

  it("requires dispatch and token deadlines to remain inside unsafeUntil", () => {
    const unsafeUntil = new Date("2026-01-01T00:00:00.000Z");
    expect(
      checkedMintTemporalFixture({
        dispatchAuthorizedUntil: new Date("2025-12-31T23:59:00.000Z"),
        tokenExpiresAt: new Date("2025-12-31T23:58:00.000Z"),
        unsafeUntil,
      }),
    ).toEqual({
      dispatchAuthorizedUntil: new Date("2025-12-31T23:59:00.000Z"),
      tokenExpiresAt: new Date("2025-12-31T23:58:00.000Z"),
      unsafeUntil,
    });
    expect(() =>
      checkedMintTemporalFixture({
        dispatchAuthorizedUntil: new Date("2026-01-01T00:00:01.000Z"),
        unsafeUntil,
      }),
    ).toThrow("postgres_e2e_mint_dispatch_after_unsafe_horizon");
    expect(() =>
      checkedMintTemporalFixture({
        dispatchAuthorizedUntil: new Date("2025-12-31T23:59:00.000Z"),
        tokenExpiresAt: new Date("2026-01-01T00:00:01.000Z"),
        unsafeUntil,
      }),
    ).toThrow("postgres_e2e_mint_token_after_unsafe_horizon");
  });

  it("restores the runtime gate even when fixture cleanup fails", async () => {
    const cleanupError = new Error("cleanup failed");
    const cleanup = vi.fn(async () => {
      throw cleanupError;
    });
    const restore = vi.fn(async () => undefined);

    await expect(runHostedPoolFixtureTeardown(cleanup, restore)).rejects.toBe(
      cleanupError,
    );
    expect(cleanup).toHaveBeenCalledOnce();
    expect(restore).toHaveBeenCalledOnce();
    expect(cleanup.mock.invocationCallOrder[0]).toBeLessThan(
      restore.mock.invocationCallOrder[0]!,
    );
  });
});
