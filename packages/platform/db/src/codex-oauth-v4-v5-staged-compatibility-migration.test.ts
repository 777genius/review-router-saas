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
      "bd35157bc11c84dd181ba7f2edf589503d75cb359c12e9a93bf4a884f94c9db7",
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

  it("checks every active V5 namespace only after the PostgreSQL writer drain", () => {
    expect(sql).toContain(
      "codex_oauth_v4_v5_compatibility_predecessor_evidence_missing",
    );
    const lock = sql.indexOf(
      'LOCK TABLE public."CodexOAuthSecretNamespace" IN SHARE ROW EXCLUSIVE MODE',
    );
    const drop = sql.indexOf(
      'DROP FUNCTION public."codex_oauth_reattest_active_namespace_v4_to_v5"',
    );
    const postDrainCheck = sql.indexOf("DO $compatibility_admission$", drop);
    const checkSql = sql.slice(
      postDrainCheck,
      sql.indexOf("$compatibility_admission$;", postDrainCheck),
    );
    expect(lock).toBeGreaterThan(0);
    expect(drop).toBeGreaterThan(lock);
    expect(postDrainCheck).toBeGreaterThan(drop);
    expect(checkSql).toContain(
      'FROM public."CodexOAuthSecretNamespace" namespace',
    );
    expect(checkSql).toContain("namespace.\"status\" = 'active'");
    expect(checkSql).toContain('NOT namespace."permanentlyRetired"');
    expect(checkSql).toContain('namespace."workflowSchemaVersion" = 5');
    expect(checkSql).not.toContain("CodexOAuthProviderInstance");
  });

  it("revokes old consumers and drains in-flight calls before dropping the 20-argument floor", () => {
    const revoke = sql.indexOf(
      'REVOKE EXECUTE ON FUNCTION public."codex_oauth_reattest_active_namespace_v4_to_v5"',
    );
    const floor = sql.indexOf("$v4_consumer_rollback_floor$");
    const drop = sql.indexOf(
      'DROP FUNCTION public."codex_oauth_reattest_active_namespace_v4_to_v5"',
    );
    expect(revoke).toBeGreaterThan(0);
    expect(floor).toBeGreaterThan(revoke);
    expect(drop).toBeGreaterThan(floor);
    expect(sql).toContain("codex_oauth_v4_consumer_rollback_floor_incomplete");
    expect(sql.slice(revoke, drop)).toContain(
      "text,text,text,text,bigint,text,text,text,text,text,integer,integer,text,text,text,text,text,text,text,text",
    );
    expect(sql).toContain(
      'CREATE TRIGGER "CodexOAuthSecretNamespace_workflow_compatibility_guard"',
    );
    expect(sql).toContain(
      'compatibility."workflowSourceSha256" = OLD."workflowSourceSha256"',
    );
  });

  it("enforces a bounded 25-hour retirement barrier", () => {
    expect(sql).toContain("compatibility_window_seconds <> 90000");
    expect(sql).toContain("interval '25 hours'");
    expect(sql).toContain(
      "compatibility_created_at + make_interval(secs => compatibility_window_seconds)",
    );
    expect(sql).toContain(
      "compatibility_created_at := date_trunc('milliseconds', clock_timestamp())",
    );
    expect(sql).not.toContain(
      "compatibility_created_at TIMESTAMPTZ(3) := transaction_timestamp()",
    );
    expect(sql.indexOf("compatibility_created_at :=")).toBeGreaterThan(
      sql.indexOf("FOR UPDATE OF namespace"),
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
    expect(sql).toContain('attempt."namespaceId" = target_namespace_id');
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
