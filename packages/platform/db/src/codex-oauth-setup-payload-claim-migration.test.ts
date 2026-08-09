import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Codex OAuth payload-claim migrations", () => {
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
