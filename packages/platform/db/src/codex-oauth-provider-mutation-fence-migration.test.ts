import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("Codex OAuth provider mutation fence migration", () => {
  it("installs positive epochs, identity quarantine, cleanup, and mixed-version guards", () => {
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
    expect(sql).toContain('CREATE TABLE "CodexOAuthChildIdentityQuarantine"');
    expect(sql).toContain(
      'LOCK TABLE "RepositoryConnection" IN SHARE ROW EXCLUSIVE MODE;',
    );
    expect(sql).toContain("FOR UPDATE OF r");
    expect(sql).toContain("codex_oauth_repository_identity_bound");
    expect(sql).toContain("repository_external_identity_mismatch");
    expect(sql).toContain(
      'r."externalRepositoryId" IS DISTINCT FROM r."githubRepositoryId"::text',
    );
    expect(sql).toContain(
      'CREATE CONSTRAINT TRIGGER "RepositoryConnection_codex_oauth_identity_guard"',
    );
    expect(sql).toContain("DEFERRABLE INITIALLY IMMEDIATE");
    expect(sql).toContain("codex_oauth_provider_identity_immutable");
    expect(sql).toContain("codex_oauth_child_mutation_epoch_mismatch");
    expect(sql).toContain("codex_oauth_child_mutation_owner_mismatch");
    expect(sql).toContain("codex_oauth_child_lease_ownership_mismatch");
    expect(sql).toContain("to_jsonb(NEW)->>'workspaceId'");
    expect(sql).toContain("to_jsonb(NEW)->>'repositoryId'");
    expect(sql).toContain("codex_oauth_provider_mutation_fence_required");
    expect(sql).toContain("'identity-quarantine:'");
    expect(sql).toContain("'identity_quarantined'");
    expect(sql).toContain("'provider_identity_quarantined'");
    expect(sql).toContain("codex_oauth_repair_quarantined_child");
    expect(sql).toContain("codex_oauth_repair_quarantined_provider");
    expect(sql).toContain("l.\"status\" IN ('preleased', 'finalized')");
    expect(sql).toContain("m.\"status\" = 'fetched'");
    expect(sql).toContain(
      'p."id" = m."providerInstanceRowId" AND p."mutationEpoch" > 0',
    );
    expect(sql).toContain(
      'p."id" = l."providerInstanceRowId" AND p."mutationEpoch" > 0',
    );
    expect(sql).toContain(
      'WHERE "status" = \'issued\'\n  AND "expiresAt" <= CURRENT_TIMESTAMP;',
    );
    expect(sql).toContain(
      "active setup manifest lacks a positive mutation epoch",
    );
    expect(sql).toContain("active lease lacks a positive mutation epoch");
    expect(sql).toContain("pending intent lacks a positive mutation epoch");
    expect(sql).toContain("Deliberately no down migration");
  });
});
