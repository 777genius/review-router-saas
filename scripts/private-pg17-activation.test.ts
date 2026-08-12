import { describe, expect, it } from "vitest";
import {
  activationAuthorityProvisioningSql,
  canonicalActivationSql,
  roleProvisioningSql,
} from "./run-codex-rotating-release-migration.mjs";

const configuration = {
  roles: [
    { role: "api", username: "reviewrouter_api", password: "api-pass" },
    { role: "web", username: "reviewrouter_web", password: "web-pass" },
    {
      role: "worker",
      username: "reviewrouter_worker",
      password: "worker-pass",
    },
    {
      role: "effect-authority",
      username: "reviewrouter_codex_effect_authority",
      password: "effect-pass",
    },
  ],
  releasePassword: "release-pass",
};

describe("target-local PG17 activation permit", () => {
  it("gives the dedicated installer only the permit installation capability", () => {
    const sql = activationAuthorityProvisioningSql();
    expect(sql).toContain("reviewrouter_activation.install_activation_permit");
    expect(sql).toContain(
      "session_user <> 'reviewrouter_activation_permit_installer'",
    );
    expect(sql).toContain(
      "REVOKE ALL ON ALL TABLES IN SCHEMA reviewrouter_activation FROM reviewrouter_activation_permit_installer",
    );
    expect(sql).toContain(
      "GRANT EXECUTE ON FUNCTION reviewrouter_activation.install_activation_permit",
    );
    expect(sql).toContain(
      "'GRANT CONNECT ON DATABASE %I TO reviewrouter_activation_permit_installer;'",
    );
    expect(sql).toContain(
      "'reviewrouter_activation_permit_installer', current_database(), 'CONNECT'",
    );
    expect(sql).toContain(
      "'reviewrouter_activation_permit_installer', current_database(), 'TEMP'",
    );
    expect(sql).toContain("acl.privilege_type = 'CONNECT'");
    expect(sql).toContain("acl.is_grantable");
    expect(sql).not.toContain(
      "GRANT CONNECT ON DATABASE %I TO reviewrouter_activation_permit_installer WITH GRANT OPTION",
    );
    expect(sql).not.toContain("GRANT reviewrouter_activation_receipt_guard TO");
    expect(sql).not.toContain(
      "CREATE ROLE reviewrouter_activation_receipt_guard",
    );
  });

  it("makes exact install replay idempotent and rejects a conflicting tuple", () => {
    const sql = activationAuthorityProvisioningSql();
    expect(sql).toContain("ON CONFLICT (rollout_id) DO NOTHING");
    expect(sql).toContain("WHERE rollout_id = requested_rollout_id FOR UPDATE");
    expect(sql).toContain("RETURN false;");
    expect(sql).toContain("activation permit conflicts with installed tuple");
    expect(sql).toContain("UNIQUE (permit_epoch, permit_nonce)");
  });

  it("gives the guard read-only migration history and no other public table access", () => {
    const sql = activationAuthorityProvisioningSql();
    expect(sql).toContain(
      "IF to_regclass('public._prisma_migrations') IS NULL",
    );
    expect(sql).toContain(
      'GRANT SELECT ON TABLE public."_prisma_migrations" TO reviewrouter_activation_receipt_guard',
    );
    expect(sql).toContain(
      "'reviewrouter_activation_receipt_guard', 'public._prisma_migrations', 'SELECT'",
    );
    expect(sql).toContain(
      "ARRAY['INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']",
    );
    expect(sql).toContain(
      "ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']",
    );
    expect(sql).toContain("relation.relname <> '_prisma_migrations'");
    expect(sql).toContain(
      "'reviewrouter_activation_permit_installer', relation.oid",
    );
    expect(sql).not.toMatch(
      /GRANT\s+(?:INSERT|UPDATE|DELETE|ALL).*_prisma_migrations.*reviewrouter_activation_receipt_guard/iu,
    );
  });

  it("locks, validates, grants, consumes and receipts in one transaction", () => {
    const authority = activationAuthorityProvisioningSql();
    const activation = canonicalActivationSql(configuration, {
      rolloutId: "rollout-activation-1",
    });
    expect(authority).toContain(
      "FROM reviewrouter_activation.activation_permit\n  WHERE rollout_id = requested_rollout_id FOR UPDATE",
    );
    expect(authority).toContain("FROM pg_catalog.pg_control_system()");
    expect(authority).toContain("current_setting('server_version_num')");
    expect(authority).toContain("FROM public._prisma_migrations");
    expect(authority).toContain(
      "evidence->>'commit' = permit.expected_commit_sha",
    );
    expect(authority).toContain(
      "UPDATE reviewrouter_activation.activation_permit\n    SET consumed_at = transaction_timestamp()",
    );
    expect(
      authority.indexOf(
        "INSERT INTO reviewrouter_activation.activation_receipt",
      ),
    ).toBeLessThan(
      authority.indexOf("SET consumed_at = transaction_timestamp()"),
    );
    expect(activation.sql).toContain("BEGIN;");
    expect(activation.sql).toContain("GRANT CONNECT");
    expect(activation.sql).toContain(
      "reviewrouter_activation.activate_generation(",
    );
    expect(activation.sql.trim().endsWith("COMMIT;")).toBe(true);
  });

  it("returns the immutable receipt on crash replay and fails closed on torn consume", () => {
    const sql = activationAuthorityProvisioningSql();
    expect(sql).toContain(
      "SELECT * INTO receipt FROM reviewrouter_activation.activation_receipt",
    );
    expect(sql).toContain("activation receipt conflicts with permit replay");
    expect(sql).toContain("consumed activation permit has no receipt");
    expect(sql).toContain("activation permit consumption raced");
  });

  it("keeps rollout bootstrap outside guard authority and global ledgers", () => {
    const sql = roleProvisioningSql(configuration);
    expect(sql).toContain(
      "external activation authority boundary is not installed canonically",
    );
    expect(sql).toContain(
      "activation receipt guard must have no membership edges",
    );
    expect(sql).not.toContain(
      "CREATE ROLE reviewrouter_activation_receipt_guard",
    );
    expect(sql).not.toContain("GRANT reviewrouter_activation_receipt_guard TO");
    expect(sql).not.toContain(
      "CREATE TABLE IF NOT EXISTS reviewrouter_bootstrap.release_rollout_ledger",
    );
    expect(sql).not.toContain(
      "CREATE TABLE IF NOT EXISTS reviewrouter_bootstrap.release_runner_job_ledger",
    );
  });

  it("rejects authority material from the cutover request surface", () => {
    const activation = canonicalActivationSql(configuration, {
      rolloutId: "rollout-activation-1",
      permitNonce: "caller-controlled",
      permitEpoch: 999,
    });
    expect(activation.sql).not.toContain("caller-controlled");
    expect(activation.sql).not.toContain("999");
    expect(
      activation.sql
        .match(
          /reviewrouter_activation\.activate_generation\([\s\S]*?\);/u,
        )?.[0]
        .match(/,/gu),
    ).toHaveLength(1);
  });
});
