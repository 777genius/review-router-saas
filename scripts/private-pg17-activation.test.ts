import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  activationAuthorityProvisioningSql,
  activationRoutineBodyTrustRoots,
  canonicalActivationSql,
  effectivePrincipalInventorySqlSha256,
  roleProvisioningSql,
} from "./run-codex-rotating-release-migration.mjs";
import { effectivePrincipalInventorySql } from "../packages/features/release-rollout/src/index.ts";

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
const principalEvidence = {
  principalInventorySql: effectivePrincipalInventorySql,
  beforePrincipalInventory: { version: 1 },
  beforePrincipalPolicy: { version: 1 },
  activatedPrincipalInventory: { version: 1 },
  activatedPrincipalPolicy: { version: 1 },
  beforePrincipalInventorySha256: `sha256:${"1".repeat(64)}`,
  beforePrincipalPolicySha256: `sha256:${"2".repeat(64)}`,
  activatedPrincipalInventorySha256: `sha256:${"3".repeat(64)}`,
  activatedPrincipalPolicySha256: `sha256:${"4".repeat(64)}`,
};

describe("target-local PG17 activation permit", () => {
  it("publishes deterministic non-secret routine-body trust roots", () => {
    const roots = activationRoutineBodyTrustRoots();
    expect(roots.installerRoutineBodySha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(roots.readerRoutineBodySha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(roots.installerRoutineBodySha256).not.toBe(
      roots.readerRoutineBodySha256,
    );
  });

  it("pins the exact principal inventory projection used inside activation", () => {
    expect(
      createHash("sha256").update(effectivePrincipalInventorySql).digest("hex"),
    ).toBe(effectivePrincipalInventorySqlSha256);
  });

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
      ...principalEvidence,
    });
    expect(authority).toContain(
      "FROM reviewrouter_activation.activation_permit\n  WHERE rollout_id = requested_rollout_id FOR UPDATE",
    );
    expect(authority).toContain("FROM pg_catalog.pg_control_system()");
    expect(authority).toContain("current_setting('server_version_num')");
    expect(authority).toContain("FROM public._prisma_migrations");
    expect(authority).toContain(
      "read_activation_migration_manifest_identity()",
    );
    expect(authority).toContain(
      "TO reviewrouter_activation_permit_installer, reviewrouter_activation_receipt_reader",
    );
    expect(authority).toContain(
      "evidence->>'commit' = permit.expected_commit_sha",
    );
    expect(authority).toContain("WITH runtime_roles(role_name, role_kind)");
    expect(authority).toContain("has_table_privilege(role_name,tables.oid");
    expect(authority).toContain("has_column_privilege(role_name,relation.oid");
    expect(authority).toContain(
      "has_sequence_privilege(role_name,sequences.oid",
    );
    expect(authority).toContain(
      "has_function_privilege(role_name,routines.oid",
    );
    expect(authority).toContain(
      "RAISE EXCEPTION 'runtime ACL is not canonical'",
    );
    expect(authority).toContain(
      "has_database_privilege('public',current_database(),'CONNECT')",
    );
    expect(authority).toContain("has_table_privilege('public',oid,privilege)");
    expect(authority).toContain("acl.is_grantable");
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
    expect(activation.sql.indexOf("AS before_inventory")).toBeLessThan(
      activation.sql.indexOf("stage_principal_evidence"),
    );
    expect(activation.sql.indexOf("stage_principal_evidence")).toBeLessThan(
      activation.sql.indexOf("GRANT CONNECT"),
    );
    expect(activation.sql.indexOf("GRANT CONNECT")).toBeLessThan(
      activation.sql.indexOf("AS activated_inventory"),
    );
    expect(activation.sql.indexOf("AS activated_inventory")).toBeLessThan(
      activation.sql.indexOf("activate_generation"),
    );
  });

  it("returns the immutable receipt on crash replay and fails closed on torn consume", () => {
    const sql = activationAuthorityProvisioningSql();
    expect(sql).toContain(
      "SELECT * INTO receipt FROM reviewrouter_activation.activation_receipt",
    );
    expect(sql).toContain("activation receipt conflicts with permit replay");
    expect(sql).toContain("activation receipt conflicts with catalog replay");
    expect(
      sql.indexOf("WITH runtime_roles(role_name, role_kind)"),
    ).toBeLessThan(sql.indexOf("IF receipt.rollout_id IS NOT NULL THEN"));
    expect(sql).toContain("consumed activation permit has no receipt");
    expect(sql).toContain("activation permit consumption raced");
  });

  it("binds independently validated principal evidence to the permit and activation transaction", () => {
    const sql = activationAuthorityProvisioningSql();
    expect(sql).toContain(
      "CREATE TABLE IF NOT EXISTS reviewrouter_activation.activation_principal_evidence",
    );
    expect(sql).toContain(
      "principal_evidence.transaction_id <> txid_current()",
    );
    expect(sql).toContain(
      "principal_evidence.activated_inventory IS DISTINCT FROM observed_activated_inventory",
    );
    expect(sql).toContain(
      "observed_before_inventory IS DISTINCT FROM expected_before_inventory",
    );
    expect(sql).toContain(
      "reviewrouter_activation.canonical_json(expected_before_inventory)",
    );
    expect(sql).toContain(
      "reviewrouter_activation.canonical_json(expected_before_policy)",
    );
    expect(sql).toContain(
      "reviewrouter_activation.canonical_json(expected_activated_inventory)",
    );
    expect(sql).toContain(
      "reviewrouter_activation.canonical_json(expected_activated_policy)",
    );
    expect(sql).toContain("principal evidence invalid or stale");
    expect(sql).toContain("principal evidence staging conflict");
    expect(sql).toContain(
      "principal evidence is not transaction-bound to activation",
    );
    expect(sql).toContain("activationPrincipalEvidenceContract");
    expect(sql).toContain("principalInventorySqlSha256");
    expect(sql).toContain("activateGenerationBodySha256");
    expect(sql).toContain("readActivationReceiptBodySha256");
  });

  it("emits all four durable digests on direct and reconstructed receipt paths", () => {
    const sql = activationAuthorityProvisioningSql();
    for (const field of [
      "beforePrincipalInventorySha256",
      "beforePrincipalPolicySha256",
      "activatedPrincipalInventorySha256",
      "activatedPrincipalPolicySha256",
    ]) {
      expect(sql.match(new RegExp(`'${field}'`, "gu"))).toHaveLength(2);
    }
    expect(sql).toContain("legacy activation receipt lacks principal evidence");
  });

  it("keeps rollout bootstrap outside guard authority and global ledgers", () => {
    const authority = activationAuthorityProvisioningSql();
    const sql = roleProvisioningSql(configuration);
    expect(authority).toContain(
      "CREATE OR REPLACE FUNCTION reviewrouter_activation.assert_no_activation_receipt()",
    );
    expect(authority).toContain("STABLE SECURITY DEFINER");
    expect(authority).toContain(
      "session_user <> 'reviewrouter_role_bootstrap'",
    );
    expect(authority).toContain(
      "GRANT EXECUTE ON FUNCTION reviewrouter_activation.assert_no_activation_receipt() TO reviewrouter_role_bootstrap",
    );
    expect(authority).not.toMatch(
      /GRANT\s+SELECT\s+ON[^;]*activation_receipt[^;]*TO reviewrouter_role_bootstrap/iu,
    );
    expect(sql).toContain(
      "SELECT reviewrouter_activation.assert_no_activation_receipt();",
    );
    expect(sql).not.toContain(
      "SELECT count(*) FROM reviewrouter_activation.activation_receipt",
    );
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
      ...principalEvidence,
      permitNonce: "caller-controlled",
      permitEpoch: 999,
    });
    expect(activation.sql).not.toContain("caller-controlled");
    expect(activation.sql).not.toContain("999");
    expect(activation.sql).not.toContain(
      "requested_canonical_privileges_sha256",
    );
    expect([
      ...(
        activation.sql.match(
          /reviewrouter_activation\.activate_generation\([\s\S]*?\);/u,
        )?.[0] ?? ""
      ).matchAll(/,/gu),
    ]).toHaveLength(1);
  });

  it.each([
    ["missing", undefined],
    ["malformed", "sha256:not-a-digest"],
  ])("rejects %s principal evidence before emitting SQL", (_label, value) => {
    expect(() =>
      canonicalActivationSql(configuration, {
        rolloutId: "rollout-activation-1",
        ...principalEvidence,
        beforePrincipalInventorySha256: value,
      }),
    ).toThrow("release_migration_activation_principal_evidence_invalid");
  });

  it("derives receipt digests from normalized catalog facts", () => {
    const sql = activationAuthorityProvisioningSql();
    expect(sql).toContain("jsonb_build_object('policyVersion',1,'facts'");
    expect(sql).toContain("INTO catalog_acl_facts, acl_is_canonical");
    expect(sql).toContain("canonical_privileges_sha256 := 'sha256:'");
    expect(sql).toContain("catalog_facts_sha256 := 'sha256:'");
    expect(sql).not.toContain("requested_canonical_privileges_sha256");
    expect(sql).toContain(
      "ALTER FUNCTION reviewrouter_activation.activate_generation(text,jsonb)",
    );
  });

  it("gives the receipt reader only its target-local read capability", () => {
    const sql = activationAuthorityProvisioningSql();
    expect(sql).toContain(
      "activation receipt reader is not pre-provisioned canonically",
    );
    expect(sql).toContain(
      "edge.roleid IN (guard.oid, installer.oid, reader.oid)",
    );
    expect(sql).toContain(
      "'GRANT CONNECT ON DATABASE %I TO reviewrouter_activation_receipt_reader;'",
    );
    expect(sql).toContain(
      "CREATE OR REPLACE FUNCTION reviewrouter_activation.read_activation_receipt(",
    );
    expect(sql).toContain("STABLE SECURITY DEFINER");
    expect(sql).toContain(
      "session_user NOT IN ('reviewrouter_activation_receipt_reader','reviewrouter_release_migration')",
    );
    expect(sql).toContain(
      "REVOKE ALL ON ALL TABLES IN SCHEMA reviewrouter_activation FROM reviewrouter_activation_receipt_reader",
    );
    expect(sql).toContain(
      "GRANT USAGE ON SCHEMA reviewrouter_activation TO reviewrouter_activation_receipt_reader",
    );
    expect(sql).toContain(
      "GRANT EXECUTE ON FUNCTION reviewrouter_activation.read_activation_receipt(text) TO reviewrouter_activation_receipt_reader",
    );
    expect(sql).toContain(
      "REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM reviewrouter_activation_receipt_reader",
    );
    expect(sql).toContain(
      "REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC",
    );
    expect(sql).not.toMatch(
      /GRANT\s+SELECT\s+ON[^;]+TO reviewrouter_activation_receipt_reader/iu,
    );
  });
});
