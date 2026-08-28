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
      "dbc4c472b188f6fd0b423c8415afeffa9d7907f4476d44d8aeb74e1a3534c4fc",
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

  it("retains direct-update rejection and exposes no generic runtime mutation", () => {
    expect(sql).toContain("codex_oauth_secret_namespace_identity_immutable");
    expect(sql).toContain(
      'REVOKE EXECUTE ON FUNCTION "codex_oauth_reattest_active_namespace_v4_to_v5"',
    );
    expect(sql).toContain("TO reviewrouter_web");
    expect(sql).not.toMatch(/TO reviewrouter_(?:api|worker);/u);
    expect(sql).not.toContain("GRANT UPDATE");
  });
});
