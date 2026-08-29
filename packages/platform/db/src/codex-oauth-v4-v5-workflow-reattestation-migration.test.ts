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
      "9ba8a0e4cfde1c07076af8a2f0ea89bf9f34bc1e30901cc52843714ea02ea65c",
    );
    expect(sql).toMatch(/^BEGIN;[\s\S]+COMMIT;\s*$/u);
  });

  it("authorizes only the exact locked active V4-to-V5 transition", () => {
    expect(sql).toContain(
      'CREATE FUNCTION "codex_oauth_reattest_active_namespace_v4_to_v5"',
    );
    expect(sql).toContain("FOR UPDATE OF provider");
    expect(sql).toContain("FOR UPDATE OF namespace, attempt, claim");
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
    expect(sql).toContain("reviewrouter_release_schema_owner");
    expect(sql).toContain('NEW."createdAt" IS DISTINCT FROM OLD."createdAt"');
  });
});
