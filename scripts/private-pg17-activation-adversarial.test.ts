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
const requiredProof =
  process.env.REVIEW_ROUTER_REQUIRE_PG17_ADVERSARIAL === "1";
const configuredImage = process.env.REVIEW_ROUTER_PG17_ADVERSARIAL_IMAGE ?? "";
const pinnedImage =
  /^postgres:17\.[0-9]+-[a-z0-9.-]+@sha256:[a-f0-9]{64}$/u.test(
    configuredImage,
  );
if (requiredProof && !pinnedImage)
  throw new Error("pg17_adversarial_digest_pinned_image_required");
const inspectedImage = pinnedImage
  ? docker(["image", "inspect", "--format", "{{.Id}}", configuredImage])
  : { status: null, stdout: "", stderr: "" };
const dockerReady =
  pinnedImage &&
  docker(["info", "--format", "{{.ServerVersion}}"]).status === 0 &&
  inspectedImage.status === 0 &&
  inspectedImage.stdout.trim().startsWith("sha256:");
if (requiredProof && !dockerReady)
  throw new Error("pg17_adversarial_digest_pinned_image_unavailable");
const describePg17 = dockerReady ? describe : describe.skip;
const container = `rr-activation-principal-${process.pid}`;
const adminUsername = "reviewrouter_role_bootstrap";
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
      adminUsername,
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
      "--env",
      `POSTGRES_USER=${adminUsername}`,
      "--env",
      "POSTGRES_DB=postgres",
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
        adminUsername,
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
    const policies = JSON.parse(
      psql(`WITH policies AS (
  SELECT
    reviewrouter_activation.project_effective_principal_authority('preactivation')->'catalogPolicy' AS before_policy,
    reviewrouter_activation.project_effective_principal_authority('activated')->'catalogPolicy' AS activated_policy
)
SELECT json_build_object('before',before_policy,'activated',activated_policy,
  'beforeSha256','sha256:'||encode(sha256(convert_to(reviewrouter_activation.canonical_json(before_policy),'UTF8')),'hex'),
  'activatedSha256','sha256:'||encode(sha256(convert_to(reviewrouter_activation.canonical_json(activated_policy),'UTF8')),'hex'))
FROM policies;`),
    ) as Record<string, unknown>;
    const before = JSON.stringify(policies.before).replaceAll("'", "''");
    const activated = JSON.stringify(policies.activated).replaceAll("'", "''");
    psql(`SET SESSION AUTHORIZATION reviewrouter_activation_permit_installer;
SELECT reviewrouter_activation.install_activation_permit(
  '${rolloutId}','1','${systemIdentifier}',17,'${"b".repeat(40)}',
  '${migrationChecksum}'::text,'["dep-disposable"]'::jsonb,${epoch},
  '${epoch.toString(16).padStart(32, "0")}', '${before}'::jsonb,
  '${String(policies.beforeSha256)}', '${activated}'::jsonb,
  '${String(policies.activatedSha256)}'
);`);
  };
  const rejectedWithoutWrite = (
    rolloutId: string,
    expectedError = "principal evidence invalid or stale",
  ) => {
    const activation = canonicalActivationSql(configuration, { rolloutId });
    const rejected = docker(
      [
        "exec",
        "-i",
        container,
        "psql",
        "--username",
        adminUsername,
        "--dbname",
        "postgres",
        "--no-psqlrc",
        "--set",
        "ON_ERROR_STOP=1",
      ],
      `SET SESSION AUTHORIZATION reviewrouter_release_migration;\n${activation.sql}`,
    );
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain(expectedError);
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

  it("accepts the exact clean preactivation catalog projection", () => {
    installPermit("exact-clean-stage", 11);
    const staged = psql(`BEGIN;
CREATE TEMP TABLE ignored_ephemeral_activation_object(id integer);
SET SESSION AUTHORIZATION reviewrouter_release_migration;
SELECT reviewrouter_activation.stage_principal_evidence('exact-clean-stage');
ROLLBACK;`);
    expect(staged.split("\n")).toContain("t");
    expect(
      psql(
        "SELECT count(*) FROM reviewrouter_activation.activation_principal_evidence WHERE rollout_id='exact-clean-stage';",
      ),
    ).toBe("0");
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
        adminUsername,
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
    psql(`GRANT rr_unexpected_owner TO reviewrouter_release_migration WITH SET TRUE;
SET SESSION AUTHORIZATION reviewrouter_release_migration;
ALTER TABLE public.activation_attack_target OWNER TO reviewrouter_release_migration;
RESET SESSION AUTHORIZATION;
REVOKE CREATE ON SCHEMA public FROM rr_unexpected_owner;
REVOKE rr_unexpected_owner FROM reviewrouter_release_migration;
DROP ROLE rr_unexpected_owner;`);
  });

  it("rejects an unauthorized direct grant to an approved runtime login", () => {
    installPermit("approved-direct-grant", 6);
    psql(`SET SESSION AUTHORIZATION reviewrouter_release_migration;
GRANT TRUNCATE ON public.activation_attack_target TO reviewrouter_api;`);
    rejectedWithoutWrite(
      "approved-direct-grant",
      "activation catalog policy mismatch",
    );
    psql(`SET SESSION AUTHORIZATION reviewrouter_release_migration;
REVOKE TRUNCATE ON public.activation_attack_target FROM reviewrouter_api;`);
  });

  it("rejects an approved login owning an unexpected object", () => {
    installPermit("approved-owner-drift", 7);
    psql(`SET SESSION AUTHORIZATION reviewrouter_release_migration;
CREATE TABLE public.unexpected_owned_object(id integer);
RESET SESSION AUTHORIZATION;
ALTER TABLE public.unexpected_owned_object OWNER TO reviewrouter_api;`);
    rejectedWithoutWrite(
      "approved-owner-drift",
      "activation catalog policy mismatch",
    );
    psql(`DROP TABLE public.unexpected_owned_object;`);
  });

  it("rejects exact ACL drift in a non-public schema", () => {
    psql(`CREATE SCHEMA private_sensitive AUTHORIZATION reviewrouter_release_migration;`);
    installPermit("non-public-schema-grant", 8);
    psql(`SET SESSION AUTHORIZATION reviewrouter_release_migration;
GRANT USAGE ON SCHEMA private_sensitive TO reviewrouter_api;`);
    rejectedWithoutWrite(
      "non-public-schema-grant",
      "activation catalog policy mismatch",
    );
    psql(`SET SESSION AUTHORIZATION reviewrouter_release_migration;
DROP SCHEMA private_sensitive;`);
  });

  it("rejects default ACL drift", () => {
    installPermit("default-acl-drift", 9);
    psql(`SET SESSION AUTHORIZATION reviewrouter_release_migration;
ALTER DEFAULT PRIVILEGES FOR ROLE reviewrouter_release_migration IN SCHEMA public
GRANT SELECT ON TABLES TO reviewrouter_api;`);
    rejectedWithoutWrite(
      "default-acl-drift",
      "activation catalog policy mismatch",
    );
    psql(`SET SESSION AUTHORIZATION reviewrouter_release_migration;
ALTER DEFAULT PRIVILEGES FOR ROLE reviewrouter_release_migration IN SCHEMA public
REVOKE SELECT ON TABLES FROM reviewrouter_api;`);
  });

  it("rejects a reviewed policy digest mismatch at permit installation", () => {
    const policy = psql(
      "SELECT reviewrouter_activation.project_effective_principal_authority('preactivation')->'catalogPolicy';",
    ).replaceAll("'", "''");
    const rejected = docker(
      [
        "exec",
        "-i",
        container,
        "psql",
        "-U",
        adminUsername,
        "-d",
        "postgres",
        "--set",
        "ON_ERROR_STOP=1",
      ],
      `SET SESSION AUTHORIZATION reviewrouter_activation_permit_installer;
SELECT reviewrouter_activation.install_activation_permit(
  'policy-digest-mismatch','1','${systemIdentifier}',17,'${"b".repeat(40)}',
  '${migrationChecksum}','["dep-disposable"]'::jsonb,10,'${"a".repeat(32)}',
  '${policy}'::jsonb,'sha256:${"0".repeat(64)}',
  jsonb_set('${policy}'::jsonb,'{phase}','"activated"'::jsonb),
  'sha256:${"0".repeat(64)}');`,
    );
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain("activation permit invalid");
    expect(
      psql(
        "SELECT count(*) FROM reviewrouter_activation.activation_permit WHERE rollout_id='policy-digest-mismatch';",
      ),
    ).toBe("0");
  });

  it("fails closed when recovery encounters caller-attested legacy evidence", () => {
    installPermit("legacy-evidence", 5);
    const digest = `sha256:${"0".repeat(64)}`;
    psql(`INSERT INTO reviewrouter_activation.activation_principal_evidence (
      rollout_id,source_system_identifier,target_system_identifier,postgres_major,
      expected_commit_sha,migration_checksum,target_deploy_ids,permit_epoch,permit_nonce,
      preactivation_catalog_policy,preactivation_catalog_policy_sha256,
      activated_catalog_policy,activated_catalog_policy_sha256,
      before_inventory,before_policy,activated_inventory,activated_policy,
      before_principal_inventory_sha256,before_principal_policy_sha256,
      activated_principal_inventory_sha256,activated_principal_policy_sha256,transaction_id
    ) VALUES (
      'legacy-evidence','1','${systemIdentifier}',17,'${"b".repeat(40)}',
      '${migrationChecksum}','["dep-disposable"]'::jsonb,5,
      '${"5".padStart(32, "0")}',
      (SELECT preactivation_catalog_policy FROM reviewrouter_activation.activation_permit
        WHERE rollout_id='legacy-evidence'),
      (SELECT preactivation_catalog_policy_sha256 FROM reviewrouter_activation.activation_permit
        WHERE rollout_id='legacy-evidence'),
      (SELECT activated_catalog_policy FROM reviewrouter_activation.activation_permit
        WHERE rollout_id='legacy-evidence'),
      (SELECT activated_catalog_policy_sha256 FROM reviewrouter_activation.activation_permit
        WHERE rollout_id='legacy-evidence'),
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
      preactivation_catalog_policy,preactivation_catalog_policy_sha256,
      activated_catalog_policy,activated_catalog_policy_sha256,
      before_principal_inventory_sha256,before_principal_policy_sha256,
      activated_principal_inventory_sha256,activated_principal_policy_sha256,
      first_write_receipt_sha256,transaction_id
    ) VALUES (
      'legacy-evidence','1','${systemIdentifier}',17,'${"b".repeat(40)}',
      '${migrationChecksum}','["dep-disposable"]'::jsonb,5,
      '${"5".padStart(32, "0")}',
      '${digest}','${digest}',
      (SELECT preactivation_catalog_policy FROM reviewrouter_activation.activation_permit
        WHERE rollout_id='legacy-evidence'),
      (SELECT preactivation_catalog_policy_sha256 FROM reviewrouter_activation.activation_permit
        WHERE rollout_id='legacy-evidence'),
      (SELECT activated_catalog_policy FROM reviewrouter_activation.activation_permit
        WHERE rollout_id='legacy-evidence'),
      (SELECT activated_catalog_policy_sha256 FROM reviewrouter_activation.activation_permit
        WHERE rollout_id='legacy-evidence'),
      '${digest}','${digest}','${digest}','${digest}',
      '${digest}',1
    );`);
    const rejected = docker(
      [
        "exec",
        "-i",
        container,
        "psql",
        "-U",
        adminUsername,
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
