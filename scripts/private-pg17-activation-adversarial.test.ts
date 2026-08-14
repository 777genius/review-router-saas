import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  activationAuthorityProvisioningSql,
  canonicalActivationSql,
} from "./run-codex-rotating-release-migration.mjs";

const docker = (args: readonly string[], input?: string) =>
  spawnSync("docker", [...args], {
    encoding: "utf8",
    input,
    timeout: 30_000,
  });
const inspectedImage = docker([
  "image",
  "inspect",
  "--format",
  "{{.Id}}",
  "postgres:17",
]);
const dockerReady =
  docker(["info", "--format", "{{.ServerVersion}}"]).status === 0 &&
  inspectedImage.status === 0 &&
  inspectedImage.stdout.trim().startsWith("sha256:");
const describePg17 = dockerReady ? describe : describe.skip;
const container = `rr-activation-principal-${process.pid}`;
const configuration = {
  roles: [
    { role: "api", username: "reviewrouter_api", password: "unused" },
    { role: "web", username: "reviewrouter_web", password: "unused" },
    { role: "worker", username: "reviewrouter_worker", password: "unused" },
    {
      role: "effect-authority",
      username: "reviewrouter_codex_effect_authority",
      password: "unused",
    },
  ],
  releasePassword: "unused",
};

const psql = (sql: string, expectedStatus = 0) => {
  const result = docker(
    [
      "exec",
      "-i",
      container,
      "psql",
      "--username",
      "postgres",
      "--dbname",
      "postgres",
      "--no-psqlrc",
      "--set",
      "ON_ERROR_STOP=1",
      "--tuples-only",
      "--no-align",
    ],
    sql,
  );
  expect(result.status, result.stderr).toBe(expectedStatus);
  return result.stdout.trim();
};

describePg17("disposable PG17 activation-principal adversarial proof", () => {
  let systemIdentifier = "";
  let migrationChecksum = "";

  beforeAll(() => {
    const started = docker([
      "run",
      "--detach",
      "--rm",
      "--name",
      container,
      "--env",
      "POSTGRES_PASSWORD=disposable",
      inspectedImage.stdout.trim(),
    ]);
    expect(started.status, started.stderr).toBe(0);
    let ready = false;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const probe = docker([
        "exec",
        "--env",
        "PGCONNECT_TIMEOUT=1",
        container,
        "psql",
        "--host",
        "127.0.0.1",
        "--username",
        "postgres",
        "--dbname",
        "postgres",
        "--no-psqlrc",
        "--set",
        "ON_ERROR_STOP=1",
        "--tuples-only",
        "--no-align",
        "--command",
        "SELECT 1",
      ]);
      if (probe.status === 0 && probe.stdout.trim() === "1") {
        ready = true;
        break;
      }
      docker(["exec", container, "sh", "-c", "sleep 1"]);
    }
    if (!ready) throw new Error("disposable_pg17_not_ready");
    psql(`
CREATE ROLE reviewrouter_activation_receipt_guard NOLOGIN;
CREATE ROLE reviewrouter_activation_permit_installer LOGIN;
CREATE ROLE reviewrouter_activation_receipt_reader LOGIN;
CREATE ROLE reviewrouter_role_bootstrap NOLOGIN;
CREATE ROLE reviewrouter_release_migration LOGIN;
CREATE ROLE reviewrouter_api LOGIN;
CREATE ROLE reviewrouter_web LOGIN;
CREATE ROLE reviewrouter_worker LOGIN;
CREATE ROLE reviewrouter_codex_effect_authority LOGIN;
CREATE EXTENSION pgcrypto;
REVOKE CONNECT, TEMPORARY ON DATABASE postgres FROM PUBLIC;
CREATE TABLE public._prisma_migrations (
  migration_name text NOT NULL, checksum text NOT NULL,
  finished_at timestamptz, rolled_back_at timestamptz
);
INSERT INTO public._prisma_migrations VALUES
  ('0001_disposable','sha256:${"a".repeat(64)}',clock_timestamp(),NULL);
CREATE TABLE public.activation_attack_target (id integer PRIMARY KEY);
ALTER TABLE public.activation_attack_target OWNER TO reviewrouter_release_migration;
ALTER SCHEMA public OWNER TO reviewrouter_release_migration;
GRANT CONNECT ON DATABASE postgres TO reviewrouter_release_migration WITH GRANT OPTION;
`);
    expect(
      Number(
        psql(`SELECT count(*)
FROM pg_proc routine
JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace
JOIN pg_depend dependency
  ON dependency.classid = 'pg_proc'::regclass
 AND dependency.objid = routine.oid
 AND dependency.refclassid = 'pg_extension'::regclass
 AND dependency.deptype = 'e'
JOIN pg_extension extension ON extension.oid = dependency.refobjid
WHERE namespace.nspname = 'public'
  AND extension.extname = 'pgcrypto'
  AND routine.proname IN ('armor', 'crypt', 'digest')
  AND has_function_privilege(
    'reviewrouter_activation_receipt_reader', routine.oid, 'EXECUTE'
  );`),
      ),
    ).toBeGreaterThan(0);
    psql(activationAuthorityProvisioningSql());
    systemIdentifier = psql(
      "SELECT system_identifier::text FROM pg_catalog.pg_control_system();",
    );
    migrationChecksum = psql(`SELECT 'sha256:' || encode(sha256(convert_to(
      string_agg(migration_name || ':' || checksum, ',' ORDER BY migration_name),
      'UTF8')), 'hex') FROM public._prisma_migrations
      WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;`);
  }, 60_000);

  afterAll(() => {
    docker(["stop", container]);
  });

  const installPermit = (rolloutId: string, epoch: number) => {
    psql(`SET SESSION AUTHORIZATION reviewrouter_activation_permit_installer;
SELECT reviewrouter_activation.install_activation_permit(
  '${rolloutId}','1','${systemIdentifier}',17,'${"b".repeat(40)}',
  '${migrationChecksum}'::text,'["dep-disposable"]'::jsonb,${epoch},
  '${epoch.toString(16).padStart(32, "0")}'
);`);
  };
  const rejectedWithoutWrite = (rolloutId: string) => {
    const activation = canonicalActivationSql(configuration, { rolloutId });
    const rejected = docker(
      [
        "exec",
        "-i",
        container,
        "psql",
        "--username",
        "postgres",
        "--dbname",
        "postgres",
        "--no-psqlrc",
        "--set",
        "ON_ERROR_STOP=1",
      ],
      `SET SESSION AUTHORIZATION reviewrouter_release_migration;\n${activation.sql}`,
    );
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain("principal evidence invalid or stale");
    expect(
      psql(`SELECT json_build_array(
        (SELECT count(*) FROM public.activation_attack_target),
        (SELECT count(*) FROM reviewrouter_activation.activation_receipt),
        (SELECT count(*) FROM reviewrouter_activation.activation_principal_evidence)
      );`),
    ).toBe("[0, 0, 0]");
  };

  it("removes effective reader and PUBLIC EXECUTE from real PG17 pgcrypto routines", () => {
    const observation = JSON.parse(
      psql(`SELECT json_build_object(
  'routineNames', coalesce(json_agg(DISTINCT routine.proname), '[]'::json),
  'readerExecuteCount', count(*) FILTER (WHERE has_function_privilege(
    'reviewrouter_activation_receipt_reader', routine.oid, 'EXECUTE'
  )),
  'publicExecuteCount', count(*) FILTER (WHERE EXISTS (
    SELECT 1
    FROM aclexplode(coalesce(
      routine.proacl, acldefault('f', routine.proowner)
    )) acl
    WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
  ))
)
FROM pg_proc routine
JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace
JOIN pg_depend dependency
  ON dependency.classid = 'pg_proc'::regclass
 AND dependency.objid = routine.oid
 AND dependency.refclassid = 'pg_extension'::regclass
 AND dependency.deptype = 'e'
JOIN pg_extension extension ON extension.oid = dependency.refobjid
WHERE namespace.nspname = 'public'
  AND extension.extname = 'pgcrypto';`),
    ) as {
      routineNames: string[];
      readerExecuteCount: number;
      publicExecuteCount: number;
    };
    expect(observation.routineNames).toEqual(
      expect.arrayContaining(["armor", "crypt", "digest"]),
    );
    expect(observation.readerExecuteCount).toBe(0);
    expect(observation.publicExecuteCount).toBe(0);
  });

  it("rejects an unexpected login with direct CONNECT/table ACL and legacy forged JSON", () => {
    installPermit("direct-acl-attack", 1);
    psql("CREATE ROLE rr_unexpected_direct LOGIN;");
    psql(`SET SESSION AUTHORIZATION reviewrouter_release_migration;
GRANT CONNECT ON DATABASE postgres TO rr_unexpected_direct;
GRANT SELECT ON public.activation_attack_target TO rr_unexpected_direct;`);
    const legacy = docker(
      [
        "exec",
        "-i",
        container,
        "psql",
        "-U",
        "postgres",
        "-d",
        "postgres",
        "--set",
        "ON_ERROR_STOP=1",
      ],
      `SET SESSION AUTHORIZATION reviewrouter_release_migration;
SELECT reviewrouter_activation.stage_principal_evidence(
  'direct-acl-attack','{}'::jsonb,'{}'::jsonb,'{}'::jsonb,'{}'::jsonb,
  '{}'::jsonb,'sha256:${"0".repeat(64)}','sha256:${"0".repeat(64)}',
  'sha256:${"0".repeat(64)}','sha256:${"0".repeat(64)}');`,
    );
    expect(legacy.status).not.toBe(0);
    rejectedWithoutWrite("direct-acl-attack");
  });

  it("rejects nested INHERIT/SET ROLE privilege reachability", () => {
    psql(`SET SESSION AUTHORIZATION reviewrouter_release_migration;
REVOKE SELECT ON public.activation_attack_target FROM rr_unexpected_direct;
REVOKE CONNECT ON DATABASE postgres FROM rr_unexpected_direct;
RESET SESSION AUTHORIZATION;
DROP ROLE rr_unexpected_direct;`);
    installPermit("membership-attack", 2);
    psql(`CREATE ROLE rr_attack_parent NOLOGIN;
CREATE ROLE rr_attack_grandparent NOLOGIN;
GRANT rr_attack_parent TO reviewrouter_api WITH INHERIT TRUE, SET TRUE;
GRANT rr_attack_grandparent TO rr_attack_parent WITH INHERIT TRUE, SET TRUE;
GRANT SELECT ON public.activation_attack_target TO rr_attack_grandparent;`);
    rejectedWithoutWrite("membership-attack");
  });

  it("rejects PUBLIC and unexpected-owner paths", () => {
    psql(`REVOKE rr_attack_parent FROM reviewrouter_api;
REVOKE rr_attack_grandparent FROM rr_attack_parent;
REVOKE SELECT ON public.activation_attack_target FROM rr_attack_grandparent;
DROP ROLE rr_attack_grandparent;
DROP ROLE rr_attack_parent;
`);
    installPermit("public-attack", 3);
    psql(`SET SESSION AUTHORIZATION reviewrouter_release_migration;
GRANT SELECT ON public.activation_attack_target TO PUBLIC;`);
    rejectedWithoutWrite("public-attack");
    psql(`SET SESSION AUTHORIZATION reviewrouter_release_migration;
REVOKE SELECT ON public.activation_attack_target FROM PUBLIC;`);
    installPermit("ownership-attack", 4);
    psql(`CREATE ROLE rr_unexpected_owner LOGIN;
GRANT rr_unexpected_owner TO reviewrouter_release_migration WITH SET TRUE;`);
    psql(`SET SESSION AUTHORIZATION reviewrouter_release_migration;
GRANT CREATE ON SCHEMA public TO rr_unexpected_owner;
ALTER TABLE public.activation_attack_target OWNER TO rr_unexpected_owner;`);
    rejectedWithoutWrite("ownership-attack");
  });

  it("fails closed when recovery encounters caller-attested legacy evidence", () => {
    installPermit("legacy-evidence", 5);
    const digest = `sha256:${"0".repeat(64)}`;
    psql(`INSERT INTO reviewrouter_activation.activation_principal_evidence (
      rollout_id,source_system_identifier,target_system_identifier,postgres_major,
      expected_commit_sha,migration_checksum,target_deploy_ids,permit_epoch,permit_nonce,
      before_inventory,before_policy,activated_inventory,activated_policy,
      before_principal_inventory_sha256,before_principal_policy_sha256,
      activated_principal_inventory_sha256,activated_principal_policy_sha256,transaction_id
    ) VALUES (
      'legacy-evidence','1','${systemIdentifier}',17,'${"b".repeat(40)}',
      '${migrationChecksum}','["dep-disposable"]'::jsonb,5,
      '${"5".padStart(32, "0")}',
      '{"version":1,"forgedClean":true}'::jsonb,
      '{"version":1,"forgedClean":true}'::jsonb,
      '{"version":1,"forgedClean":true}'::jsonb,
      '{"version":1,"forgedClean":true}'::jsonb,
      '${digest}','${digest}','${digest}','${digest}',1
    );
    INSERT INTO reviewrouter_activation.activation_receipt (
      rollout_id,source_system_identifier,target_system_identifier,postgres_major,
      expected_commit_sha,migration_checksum,target_deploy_ids,permit_epoch,permit_nonce,
      canonical_privileges_sha256,catalog_facts_sha256,
      before_principal_inventory_sha256,before_principal_policy_sha256,
      activated_principal_inventory_sha256,activated_principal_policy_sha256,
      first_write_receipt_sha256,transaction_id
    ) VALUES (
      'legacy-evidence','1','${systemIdentifier}',17,'${"b".repeat(40)}',
      '${migrationChecksum}','["dep-disposable"]'::jsonb,5,
      '${"5".padStart(32, "0")}',
      '${digest}','${digest}','${digest}','${digest}','${digest}','${digest}',
      '${digest}',1
    );`);
    const rejected = docker(
      [
        "exec",
        "-i",
        container,
        "psql",
        "-U",
        "postgres",
        "-d",
        "postgres",
        "--set",
        "ON_ERROR_STOP=1",
      ],
      `SET SESSION AUTHORIZATION reviewrouter_activation_receipt_reader;
SELECT reviewrouter_activation.read_activation_receipt('legacy-evidence');`,
    );
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain(
      "activation principal evidence contract invalid",
    );
  });
});
