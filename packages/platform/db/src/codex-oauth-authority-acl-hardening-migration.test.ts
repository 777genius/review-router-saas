import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("000065 Codex OAuth authority and ACL hardening", () => {
  const sql = readFileSync(
    resolve(
      import.meta.dirname,
      "../prisma/migrations/000065_codex_oauth_authority_acl_hardening/migration.sql",
    ),
    "utf8",
  );

  it("is pinned as the forward-only migration", () => {
    expect(createHash("sha256").update(sql).digest("hex")).toBe(
      "ca8d554dd71cbdeaf0a66e007aa7ef391627c0a9d97b10a27e1113308087342c",
    );
    expect(sql).toMatch(/^BEGIN;[\s\S]+COMMIT;\s*$/u);
  });

  it("makes database authority receipts strict one-shot capabilities", () => {
    expect(sql).toContain(
      'CREATE TRIGGER "CodexOAuthDatabaseAuthorityReceipt_one_shot_guard"',
    );
    expect(sql).toContain(
      "codex_oauth_database_authority_receipt_replay_forbidden",
    );
    expect(sql).toContain('OR OLD."consumedAt" IS NOT NULL');
    expect(sql).toContain('OR NEW."consumedAt" IS NULL');
  });

  it("requires signer-backed authority for provider identity repair", () => {
    expect(sql).toContain(
      'CREATE FUNCTION "codex_oauth_authorize_provider_identity_repair"',
    );
    expect(sql).toMatch(
      /CREATE OR REPLACE FUNCTION "codex_oauth_provider_identity_guard"\(\)[\s\S]+SECURITY DEFINER[\s\S]+SET search_path = pg_catalog, public[\s\S]+public\."codex_oauth_consume_database_authority"\([\s\S]+'provider_identity_repair', OLD\."id", 0/u,
    );
    expect(sql).toContain("codex_oauth_provider_identity_authority_required");
    const identityGuard =
      /CREATE OR REPLACE FUNCTION "codex_oauth_provider_identity_guard"[\s\S]+?END \$\$;/u.exec(
        sql,
      )?.[0];
    expect(identityGuard).toBeDefined();
    expect(identityGuard).not.toContain('receipt."consumedAt" IS NOT NULL');
    expect(sql).toMatch(
      /CREATE OR REPLACE FUNCTION "codex_oauth_repair_quarantined_provider"[\s\S]+SECURITY DEFINER[\s\S]+SET search_path = pg_catalog, public/u,
    );
    const repairFunction =
      /CREATE OR REPLACE FUNCTION "codex_oauth_repair_quarantined_provider"[\s\S]+?END \$\$;/u.exec(
        sql,
      )?.[0];
    expect(repairFunction).toBeDefined();
    expect(repairFunction).not.toContain(
      "codex_oauth_consume_database_authority",
    );
  });

  it("revokes quarantine writes and permanent-evidence deletion", () => {
    expect(sql).toContain("'REVOKE DELETE ON TABLE public.%I FROM %I'");
    expect(sql).toContain(
      "'REVOKE INSERT, UPDATE, DELETE ON TABLE public.%I FROM %I'",
    );
    expect(sql).toContain(
      "'REVOKE INSERT (%I), UPDATE (%I), REFERENCES (%I) ON TABLE public.%I FROM %I'",
    );
    expect(sql).toContain(
      "'REVOKE UPDATE ON TABLE public.\"CodexOAuthProviderInstance\" FROM %I'",
    );
    expect(sql).toContain('"activeSecretNamespaceId"');
    expect(sql).not.toContain(
      'GRANT UPDATE ("workspaceId","repositoryId","providerInstanceId"',
    );
  });
});
