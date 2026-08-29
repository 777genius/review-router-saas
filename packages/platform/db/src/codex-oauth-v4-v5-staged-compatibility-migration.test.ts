import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("000081 Codex OAuth staged V4-to-V5 compatibility", () => {
  const sql = readFileSync(
    resolve(
      import.meta.dirname,
      "../prisma/migrations/000081_codex_oauth_v4_v5_staged_compatibility/migration.sql",
    ),
    "utf8",
  );

  it("is pinned and atomic", () => {
    expect(createHash("sha256").update(sql).digest("hex")).toBe(
      "037d64a2e8da2edc404de7500c8615b65b00df284dc3ddf77d3f440c21b6331b",
    );
    expect(sql).toMatch(/^BEGIN;[\s\S]+COMMIT;\s*$/u);
  });

  it("copies exact V4 evidence before replacing the active source", () => {
    const insert = sql.indexOf(
      'INSERT INTO public."CodexOAuthWorkflowCompatibility"',
    );
    const replace = sql.indexOf(
      'UPDATE public."CodexOAuthSecretNamespace"',
      insert,
    );
    expect(insert).toBeGreaterThan(0);
    expect(replace).toBeGreaterThan(insert);
    for (const field of [
      "old_commit_sha",
      "old_blob_sha",
      "old_source_sha256",
      "old_semantic_sha256",
      "target_repository_id",
      "target_workflow_path",
    ]) {
      expect(sql.slice(insert, replace)).toContain(field);
    }
  });

  it("enforces a bounded 25-hour retirement barrier", () => {
    expect(sql).toContain("compatibility_window_seconds <> 90000");
    expect(sql).toContain("interval '25 hours'");
    expect(sql).toContain(
      "compatibility_created_at + make_interval(secs => compatibility_window_seconds)",
    );
  });

  it("serializes activation against retirement, supersession, owners, and leases", () => {
    expect(sql).toContain("provider.\"state\" = 'active'");
    expect(sql).toContain('provider."mutationOwner" IS NULL');
    expect(sql).toContain('provider."mutationOwnerId" IS NULL');
    expect(sql).toContain('provider."activeLeaseId" IS NULL');
    expect(sql).toContain("namespace.\"status\" = 'active'");
    expect(sql).toContain('NOT namespace."permanentlyRetired"');
    expect(sql).toContain("FOR UPDATE OF provider");
    expect(sql).toContain("FOR UPDATE OF attempt, claim");
    expect(sql).toContain("FOR UPDATE OF namespace");
    expect(sql).toContain('claim."generationHash" = target_generation_hash');
  });

  it("keeps compatibility immutable and read-only to runtime roles", () => {
    expect(sql).toContain("codex_oauth_workflow_compatibility_immutable");
    expect(sql).toContain(
      'REVOKE ALL ON TABLE public."CodexOAuthWorkflowCompatibility" FROM PUBLIC',
    );
    expect(sql).toContain(
      'GRANT SELECT ON TABLE public."CodexOAuthWorkflowCompatibility" TO reviewrouter_api',
    );
    expect(sql).not.toMatch(/GRANT (?:INSERT|UPDATE|DELETE)/u);
  });
});
