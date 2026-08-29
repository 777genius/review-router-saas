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
      'GRANT SELECT, UPDATE\n      ON TABLE "ReviewProviderScopeConcurrencyControl"\n      TO reviewrouter_release_migration',
    );
    expect(sql).not.toMatch(
      /GRANT\s+(?:INSERT|UPDATE|DELETE|TRUNCATE|ALL)[^;]*ReviewProviderScopeConcurrencyControl/iu,
    );
    expect(sql).not.toContain("DROP INDEX");
    expect(sql).not.toContain(
      '"ReviewInvocationLeaseV2_one_active_provider_invocation"',
    );
    expect(sql).not.toContain('"ReviewInvocationLeaseV2_one_active_work_slot"');
  });
});
