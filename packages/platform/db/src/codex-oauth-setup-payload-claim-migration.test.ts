import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Codex OAuth payload-claim migrations", () => {
  const atomicReleaseChecksum =
    "33100d6f5f3f59cd9a4c22f041d19caba6a0e0be88de4a0ee4d543af50619481";

  it("adds an all-or-none durable claim and bounded fetched recovery window", () => {
    const sql = readFileSync(
      resolve(
        import.meta.dirname,
        "../prisma/migrations/000063_codex_oauth_setup_payload_claim/migration.sql",
      ),
      "utf8",
    );
    expect(sql).toContain('"payloadGenerationHash" TEXT');
    expect(sql).toContain('"payloadAccountFingerprint" TEXT');
    expect(sql).toContain('"payloadByteSize" INTEGER');
    expect(sql).toContain(
      'CONSTRAINT "CodexOAuthSetupManifest_payload_claim_complete_check"',
    );
    expect(sql).toContain(
      'CONSTRAINT "CodexOAuthSetupManifest_recovery_expiry_check"',
    );
    expect(sql).toContain('"recoveryExpiresAt" IS NOT NULL');
    expect(sql).toContain("\"status\" IN ('fetched', 'consumed')");
    expect(sql.trimStart()).toMatch(/^BEGIN;/);
    expect(sql.trimEnd()).toMatch(/COMMIT;$/);
    expect(sql).toContain("SET LOCAL lock_timeout = '15s';");
    expect(sql).toContain("SET LOCAL statement_timeout = '5min';");
    expect(createHash("sha256").update(sql).digest("hex")).toBe(
      atomicReleaseChecksum,
    );
    expect(sql).not.toContain("CodexOAuthSecretNamespace");
    expect(sql).not.toContain("CodexOAuthSetupDispatchAttempt");
  });

  it("selects deterministic provenance for multiple historical intents", () => {
    const sql = readFileSync(
      resolve(
        import.meta.dirname,
        "../prisma/migrations/000062_codex_oauth_remote_outcome_unknown/migration.sql",
      ),
      "utf8",
    );
    expect(sql).toContain('SELECT DISTINCT ON ("providerInstanceRowId")');
    expect(sql).toContain(
      'ORDER BY "providerInstanceRowId", "updatedAt" DESC, "id" DESC',
    );
  });
});
