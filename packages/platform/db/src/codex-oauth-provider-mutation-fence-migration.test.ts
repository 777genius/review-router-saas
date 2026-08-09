import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("Codex OAuth provider mutation fence migration", () => {
  it("installs additive identity, epoch, quarantine, and mixed-version guards", () => {
    const sql = readFileSync(
      fileURLToPath(
        new URL(
          "../prisma/migrations/000061_codex_oauth_provider_mutation_fence/migration.sql",
          import.meta.url,
        ),
      ),
      "utf8",
    );

    expect(sql).toContain("SET LOCAL lock_timeout = '15s';");
    expect(sql).toContain("SET LOCAL statement_timeout = '5min';");

    expect(sql).toContain(
      'ADD COLUMN "mutationEpoch" BIGINT NOT NULL DEFAULT 0',
    );
    expect(sql).toContain(
      'CREATE TABLE "CodexOAuthProviderIdentityQuarantine"',
    );
    expect(sql).toContain("codex_oauth_provider_identity_immutable");
    expect(sql).toContain("codex_oauth_child_mutation_epoch_mismatch");
    expect(sql).toContain("to_jsonb(NEW)->>'workspaceId'");
    expect(sql).toContain("to_jsonb(NEW)->>'repositoryId'");
    expect(sql).toContain("codex_oauth_provider_mutation_fence_required");
    expect(sql).toContain("'identity-quarantine:'");
    expect(sql).toContain("l.\"status\" IN ('preleased', 'finalized')");
    expect(sql).toContain("m.\"status\" = 'fetched'");
    expect(sql).toContain(
      'p."mutationOwnerId" = m."id" OR m."status" IN (\'issued\', \'fetched\')',
    );
    expect(sql).toContain(
      'p."mutationOwnerId" = l."id" OR l."status" IN (\'preleased\', \'finalized\')',
    );
    expect(sql).toContain("Deliberately no down migration");
  });
});
