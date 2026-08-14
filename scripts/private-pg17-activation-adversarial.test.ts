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
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (
        docker([
          "exec",
          container,
          "pg_isready",
          "--username",
          "postgres",
          "--dbname",
          "postgres",
        ]).status === 0
      )
        break;
      if (attempt === 29) throw new Error("disposable_pg17_not_ready");
    }
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
REVOKE CONNECT, TEMPORARY ON DATABASE postgres FROM PUBLIC;
CREATE TABLE public._prisma_migrations (
  migration_name text NOT NULL, checksum text NOT NULL,
  finished_at timestamptz, rolled_back_at timestamptz
);
INSERT INTO public._prisma_migrations VALUES
  ('0001_disposable','sha256:${"a".repeat(64)}',clock_timestamp(),NULL);
CREATE TABLE public.activation_attack_target (id integer PRIMARY KEY);
`);
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

  it("rejects an unexpected login with direct CONNECT/table ACL and legacy forged JSON", () => {
    installPermit("direct-acl-attack", 1);
    psql(`CREATE ROLE rr_unexpected_direct LOGIN;
GRANT CONNECT ON DATABASE postgres TO rr_unexpected_direct;
GRANT SELECT ON public.activation_attack_target TO rr_unexpected_direct;`);
    const legacy = docker(
      ["exec", "-i", container, "psql", "-U", "postgres", "-d", "postgres"],
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
    psql("DROP OWNED BY rr_unexpected_direct; DROP ROLE rr_unexpected_direct;");
    installPermit("membership-attack", 2);
    psql(`CREATE ROLE rr_unexpected_member LOGIN;
CREATE ROLE rr_attack_parent NOLOGIN;
CREATE ROLE rr_attack_grandparent NOLOGIN;
GRANT rr_attack_parent TO rr_unexpected_member WITH INHERIT TRUE, SET TRUE;
GRANT rr_attack_grandparent TO rr_attack_parent WITH INHERIT TRUE, SET TRUE;
GRANT SELECT ON public.activation_attack_target TO rr_attack_grandparent;`);
    rejectedWithoutWrite("membership-attack");
  });

  it("rejects PUBLIC and unexpected-owner paths", () => {
    psql(`DROP OWNED BY rr_attack_grandparent;
DROP ROLE rr_attack_grandparent;
DROP ROLE rr_attack_parent;
DROP ROLE rr_unexpected_member;`);
    installPermit("public-attack", 3);
    psql("GRANT SELECT ON public.activation_attack_target TO PUBLIC;");
    rejectedWithoutWrite("public-attack");
    psql("REVOKE SELECT ON public.activation_attack_target FROM PUBLIC;");
    installPermit("ownership-attack", 4);
    psql(`CREATE ROLE rr_unexpected_owner LOGIN;
ALTER TABLE public.activation_attack_target OWNER TO rr_unexpected_owner;`);
    rejectedWithoutWrite("ownership-attack");
  });
});
