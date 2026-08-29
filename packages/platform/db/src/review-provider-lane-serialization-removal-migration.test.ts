import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("000079 provider lane serialization removal", () => {
  const sql = readFileSync(
    join(
      import.meta.dirname,
      "../prisma/migrations/000079_remove_account_wide_provider_lane_serialization/migration.sql",
    ),
    "utf8",
  );

  it("installs a fail-closed mixed-version bridge without activating it", () => {
    expect(sql).toContain(
      'CREATE TABLE "ReviewProviderScopeConcurrencyControl"',
    );
    expect(sql).toContain('"activated" boolean NOT NULL DEFAULT false');
    expect(sql).toContain(
      'CREATE TRIGGER "ReviewInvocationLeaseV2_provider_scope_concurrency_bridge"',
    );
    expect(sql).toContain(
      "pg_advisory_xact_lock_shared(1381126735, 1381192279)",
    );
    expect(sql).toContain(
      "ReviewInvocationLeaseV2_one_active_provider_vote_lane",
    );
    expect(sql).toContain(
      'REVOKE ALL ON TABLE "ReviewProviderScopeConcurrencyControl" FROM PUBLIC',
    );
    expect(sql).toContain(
      "'reviewrouter_api', 'reviewrouter_web', 'reviewrouter_worker'",
    );
    expect(sql).toContain(
      'GRANT SELECT ON TABLE public."ReviewProviderScopeConcurrencyControl" TO %I',
    );
    expect(sql).toContain(
      'REVOKE ALL\n      ON TABLE "ReviewProviderScopeConcurrencyControl"\n      FROM reviewrouter_release_migration',
    );
    expect(sql).not.toMatch(
      /GRANT\s+(?:INSERT|UPDATE|DELETE|TRUNCATE|ALL)[^;]*ReviewProviderScopeConcurrencyControl/iu,
    );
    expect(sql).toContain(
      "CREATE OR REPLACE FUNCTION reviewrouter_provider_scope_concurrency_activate()",
    );
    expect(sql).toContain(
      "CREATE OR REPLACE FUNCTION reviewrouter_provider_scope_concurrency_close_for_rollback()",
    );
    expect(sql).toContain(
      "CREATE OR REPLACE FUNCTION reviewrouter_provider_scope_concurrency_verify_rollback()",
    );
    expect(sql).toContain("SECURITY DEFINER");
    expect(sql).toContain("OWNER TO reviewrouter_release_schema_owner");
    expect(sql).toContain(
      "GRANT EXECUTE ON FUNCTION reviewrouter_provider_scope_concurrency_activate()\n    TO reviewrouter_release_migration",
    );
    expect(sql).toContain(
      "REVOKE ALL ON FUNCTION reviewrouter_provider_scope_concurrency_activate() FROM PUBLIC",
    );
    expect(sql).toContain("index_catalog.indisvalid");
    expect(sql).toContain("index_catalog.indisready");
    expect(sql).toContain("index_catalog.indisunique");
    expect(sql).toContain("pg_get_indexdef(index_catalog.indexrelid)");
    expect(sql).not.toContain(
      '"ReviewInvocationLeaseV2_one_active_provider_invocation"',
    );
    expect(sql).not.toContain('"ReviewInvocationLeaseV2_one_active_work_slot"');
  });

  it("retains the restricted SaaS operator contract when both roles exist", () => {
    expect(sql).toContain(
      "IF schema_owner_exists <> release_migration_exists THEN",
    );
    expect(sql).toContain(
      "ALTER FUNCTION reviewrouter_provider_scope_concurrency_snapshot()\n    OWNER TO reviewrouter_release_schema_owner",
    );
    expect(sql).toContain(
      "GRANT CREATE ON SCHEMA public TO reviewrouter_release_schema_owner",
    );
    expect(sql).toContain(
      "REVOKE CREATE ON SCHEMA public FROM reviewrouter_release_schema_owner",
    );
    expect(sql).toContain(
      "provider_scope_concurrency_schema_owner_create_handoff_survived",
    );
    expect(sql.indexOf("GRANT CREATE ON SCHEMA public")).toBeLessThan(
      sql.indexOf(
        "ALTER FUNCTION reviewrouter_provider_scope_concurrency_snapshot()",
      ),
    );
    expect(
      sql.indexOf(
        "ALTER FUNCTION reviewrouter_provider_scope_concurrency_verify_rollback()\n    OWNER TO",
      ),
    ).toBeLessThan(sql.indexOf("REVOKE CREATE ON SCHEMA public"));
    expect(sql).toContain(
      "GRANT EXECUTE ON FUNCTION reviewrouter_provider_scope_concurrency_status()\n    TO reviewrouter_release_migration",
    );
    expect(
      sql.indexOf(
        "GRANT EXECUTE ON FUNCTION reviewrouter_provider_scope_concurrency_status()",
      ),
    ).toBeLessThan(
      sql.indexOf(
        "ALTER FUNCTION reviewrouter_provider_scope_concurrency_snapshot()\n    OWNER TO reviewrouter_release_schema_owner",
      ),
    );
    expect(sql).not.toMatch(
      /GRANT EXECUTE ON FUNCTION reviewrouter_provider_scope_concurrency_[^(]+\(\)\s+TO (?:PUBLIC|reviewrouter_api|reviewrouter_web|reviewrouter_worker)/u,
    );
  });

  it("keeps the baseline topology closed and removes its operator surface", () => {
    expect(sql).toContain("IF NOT schema_owner_exists THEN");
    expect(sql).toContain(
      'ADD CONSTRAINT "ReviewProviderScopeConcurrencyControl_baseline_closed"\n      CHECK ("activated" = false)',
    );
    for (const routine of [
      "status",
      "activate",
      "close_for_rollback",
      "verify_rollback",
      "snapshot",
    ]) {
      expect(sql).toContain(
        `DROP FUNCTION reviewrouter_provider_scope_concurrency_${routine}();`,
      );
    }
    expect(sql).not.toMatch(
      /CREATE ROLE|ALTER ROLE|GRANT\s+\S+\s+TO\s+\S+\s+WITH ADMIN/iu,
    );
  });

  it("rejects either partial release-role topology with a specific diagnostic", () => {
    expect(sql).toContain(
      "provider_scope_concurrency_authority_roles_partial:reviewrouter_release_schema_owner_missing",
    );
    expect(sql).toContain(
      "provider_scope_concurrency_authority_roles_partial:reviewrouter_release_migration_missing",
    );
    expect(sql).not.toContain(
      "provider_scope_concurrency_authority_roles_missing",
    );
  });
});
