import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("000079 Codex OAuth V4-to-V5 workflow re-attestation", () => {
  const sql = readFileSync(
    resolve(
      import.meta.dirname,
      "../prisma/migrations/000079_codex_oauth_v4_v5_workflow_reattestation/migration.sql",
    ),
    "utf8",
  );

  it("is an atomic forward migration with a pinned digest", () => {
    expect(createHash("sha256").update(sql).digest("hex")).toBe(
      "d443e366de64879b1d6c32f4edba3648d8e8da160f804b6ec87bede581343109",
    );
    expect(sql).toMatch(/^BEGIN;[\s\S]+COMMIT;\s*$/u);
  });

  it("authorizes only the exact locked active V4-to-V5 transition", () => {
    expect(sql).toContain(
      'CREATE FUNCTION "codex_oauth_reattest_active_namespace_v4_to_v5"',
    );
    expect(sql).toContain("FOR UPDATE OF provider");
    expect(sql).toContain("FOR UPDATE OF attempt, claim");
    expect(sql).toContain("FOR UPDATE OF namespace");
    expect(sql).toContain("expected_schema_version <> 4");
    expect(sql).toContain("target_schema_version <> 5");
    expect(sql).toContain(
      'namespace."workflowSchemaVersion" = expected_schema_version',
    );
    expect(sql).toContain('"workflowSchemaVersion" = target_schema_version');
    expect(sql).toContain('OLD."workflowSchemaVersion" = 4');
    expect(sql).toContain('NEW."workflowSchemaVersion" = 5');
    expect(sql).toContain("expected_schema_version IS NULL");
    expect(sql).toContain(
      'provider."activeSecretNamespaceId" = target_namespace_id',
    );
    expect(sql).toContain(
      'active_claim."providerInstanceRowId" = target_provider_row_id',
    );
    expect(sql).toContain(
      'active_namespace."providerInstanceRowId" = target_provider_row_id',
    );
    expect(sql).toContain(
      'provider."latestGenerationHash" = target_generation_hash',
    );
    expect(sql).toContain(
      'namespace."workflowSourceCommitSha" = old_commit_sha',
    );
    expect(sql).toContain(
      'namespace."workflowSemanticSha256" = old_semantic_sha256',
    );
    expect(sql).toContain("active_namespace_v4_v5_reattestation");
    expect(sql).toContain('"codex_oauth_consume_database_authority"');
  });

  it("permits an exact runtime-promoted namespace without assigning it to the setup attempt", () => {
    expect(sql).not.toContain(
      'JOIN public."CodexOAuthSetupDispatchAttempt" attempt\n    ON attempt."namespaceId" = namespace."id"',
    );
    expect(sql).toContain('WHERE attempt."id" = target_attempt_id');
    expect(sql).toContain('WHERE namespace."id" = target_namespace_id');
    expect(sql).toContain(
      'provider."activeSecretNamespaceId" = target_namespace_id',
    );
  });

  it("keeps the production web-only ACL while accepting a self-hosted topology without that role", () => {
    expect(sql).toContain(
      "IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reviewrouter_web') THEN",
    );
    expect(sql).not.toContain("codex_oauth_reattestation_web_role_missing");
    expect(sql).toContain("caller_role <> 'reviewrouter_web'");
    expect(sql).toContain("canonical_function_owner <> canonical_table_owner");
    expect(sql).toContain("caller_role <> canonical_function_owner");
    expect(sql).toContain(`'public."CodexOAuthSecretNamespace"'::regclass`);
    expect(sql).toContain("TO reviewrouter_web");
  });

  it("admits only V4 and V5 for active namespace promotion or re-attestation", () => {
    expect(sql).toContain('NEW."workflowSchemaVersion" NOT IN (4, 5)');
    expect(sql).not.toContain(
      'NEW."workflowSchemaVersion" NOT BETWEEN 1 AND 5',
    );
  });

  it("retains direct-update rejection and exposes no generic runtime mutation", () => {
    expect(sql).toContain("codex_oauth_secret_namespace_identity_immutable");
    expect(sql).toContain(
      'REVOKE EXECUTE ON FUNCTION "codex_oauth_reattest_active_namespace_v4_to_v5"',
    );
    expect(sql).toContain("TO reviewrouter_web");
    expect(sql).not.toMatch(/TO reviewrouter_(?:api|worker);/u);
    expect(sql).not.toContain("GRANT UPDATE");
    expect(sql).not.toMatch(/GRANT EXECUTE[\s\S]+TO PUBLIC/u);
    expect(sql).toContain("reviewrouter_release_schema_owner");
    expect(sql).toContain('NEW."createdAt" IS DISTINCT FROM OLD."createdAt"');
  });
});
