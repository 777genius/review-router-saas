import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("000073 Codex OAuth active namespace refresh", () => {
  const sql = readFileSync(
    resolve(
      import.meta.dirname,
      "../prisma/migrations/000073_codex_oauth_active_namespace_refresh/migration.sql",
    ),
    "utf8",
  );

  it("is pinned as the forward-only migration", () => {
    expect(createHash("sha256").update(sql).digest("hex")).toBe(
      "3e5b6606f22c8bec6f75f52f48b693806d597fa283155f6e033844c4f6be4de6",
    );
    expect(sql).toMatch(/^BEGIN;[\s\S]+COMMIT;\s*$/u);
  });

  it("allows one active namespace to record multiple runtime refreshes", () => {
    expect(sql).toContain(
      'DROP INDEX "CodexOAuthWritebackIntent_secretNamespaceId_key"',
    );
    expect(sql).toContain(
      'CREATE INDEX "CodexOAuthWritebackIntent_secretNamespaceId_idx"',
    );
    expect(sql).not.toContain(
      'CREATE UNIQUE INDEX "CodexOAuthWritebackIntent_secretNamespaceId_idx"',
    );
  });
});
