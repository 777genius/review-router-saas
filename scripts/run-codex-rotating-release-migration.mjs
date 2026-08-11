#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const runtimeRoles = [
  ["api", "reviewrouter_api", "REVIEW_ROUTER_API_DATABASE_URL"],
  ["web", "reviewrouter_web", "REVIEW_ROUTER_WEB_DATABASE_URL"],
  ["worker", "reviewrouter_worker", "REVIEW_ROUTER_WORKER_DATABASE_URL"],
];

function required(env, name) {
  const value = env[name];
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`release_migration_required_environment:${name}`);
  return value;
}

function quoted(value) {
  if (value.includes("\0"))
    throw new Error("release_migration_invalid_role_password");
  return `'${value.replaceAll("'", "''")}'`;
}

function databaseIdentity(value) {
  const url = new URL(value);
  const port = url.port || "5432";
  return `${url.hostname.toLowerCase()}:${port}${url.pathname}`;
}

export function resolveReleaseMigrationConfiguration(env) {
  const releaseUrl = new URL(
    required(env, "REVIEW_ROUTER_RELEASE_MIGRATION_DATABASE_URL"),
  );
  if (
    decodeURIComponent(releaseUrl.username) !== "reviewrouter_release_migration"
  )
    throw new Error("release_migration_caller_role_mismatch");
  const identity = databaseIdentity(releaseUrl);
  const roles = runtimeRoles.map(([role, username, environmentName]) => {
    const url = new URL(required(env, environmentName));
    if (
      decodeURIComponent(url.username) !== username ||
      databaseIdentity(url) !== identity
    )
      throw new Error(`release_migration_runtime_role_mismatch:${role}`);
    const password = decodeURIComponent(url.password);
    if (!password)
      throw new Error(`release_migration_runtime_password_missing:${role}`);
    return { environmentName, password, role, username };
  });
  const commit = required(env, "REVIEW_ROUTER_RENDER_COMMIT_SHA");
  const imageDigest = required(env, "REVIEW_ROUTER_RENDER_IMAGE_DIGEST");
  if (
    !/^[a-f0-9]{40}$/u.test(commit) ||
    !/^sha256:[a-f0-9]{64}$/u.test(imageDigest)
  )
    throw new Error("release_migration_immutable_release_identity_invalid");
  return {
    commit,
    databaseIdentity: identity,
    imageDigest,
    releaseUrl: releaseUrl.toString(),
    roles,
  };
}

export function roleProvisioningSql(configuration) {
  const createAndConverge = configuration.roles
    .map(
      ({ username, password }) => `
DO $role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${username}') THEN
    CREATE ROLE ${username};
  END IF;
END
$role$;
ALTER ROLE ${username} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${quoted(password)};
DO $membership$
DECLARE membership record;
BEGIN
  FOR membership IN
    SELECT granted.rolname AS granted_name, member.rolname AS member_name
    FROM pg_auth_members edge
    JOIN pg_roles granted ON granted.oid = edge.roleid
    JOIN pg_roles member ON member.oid = edge.member
    WHERE granted.rolname = '${username}' OR member.rolname = '${username}'
  LOOP
    EXECUTE format('REVOKE %I FROM %I', membership.granted_name, membership.member_name);
  END LOOP;
END
$membership$;
REVOKE ALL ON DATABASE :"DBNAME" FROM ${username};`,
    )
    .join("\n");
  return `\\set ON_ERROR_STOP on
BEGIN;
${createAndConverge}
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
COMMIT;
`;
}

export function runtimeGrantSql(configuration) {
  return `\\set ON_ERROR_STOP on
BEGIN;
REVOKE CREATE ON DATABASE :"DBNAME" FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
${configuration.roles
  .map(
    ({ username }) => `GRANT CONNECT ON DATABASE :"DBNAME" TO ${username};
GRANT USAGE ON SCHEMA public TO ${username};
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${username};
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${username};
REVOKE TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public FROM ${username};
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO ${username};
ALTER DEFAULT PRIVILEGES FOR ROLE reviewrouter_release_migration IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${username};
ALTER DEFAULT PRIVILEGES FOR ROLE reviewrouter_release_migration IN SCHEMA public GRANT USAGE ON SEQUENCES TO ${username};`,
  )
  .join("\n")}
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
COMMIT;
`;
}

function run(command, args, { env, input } = {}) {
  const result = spawnSync(command, args, {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
    env,
    input,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0)
    throw new Error(
      `release_migration_step_failed:${command}:${args[0] ?? "command"}`,
    );
  return result.stdout;
}

export function executeCanonicalReleaseMigration(env = process.env) {
  const configuration = resolveReleaseMigrationConfiguration(env);
  const childEnv = { ...env, DATABASE_URL: configuration.releaseUrl };
  run("psql", [configuration.releaseUrl, "--no-psqlrc", "--quiet"], {
    env: childEnv,
    input: roleProvisioningSql(configuration),
  });
  const preflightOutput = run(
    "node",
    [
      "--import",
      "tsx",
      "scripts/preflight-codex-rotating-migration-history.ts",
    ],
    { env: childEnv },
  );
  run("pnpm", ["--filter", "@reviewrouter/platform-db", "db:migrate:deploy"], {
    env: childEnv,
  });
  run("psql", [configuration.releaseUrl, "--no-psqlrc", "--quiet"], {
    env: childEnv,
    input: runtimeGrantSql(configuration),
  });
  const verifiedRoles = JSON.parse(
    run(
      "psql",
      [
        configuration.releaseUrl,
        "--no-psqlrc",
        "--tuples-only",
        "--no-align",
        "--command",
        `SELECT json_build_object('callerCount', 1, 'roles', json_agg(json_build_object('username', rolname, 'login', rolcanlogin, 'canSetReleaseRole', pg_has_role(rolname, 'reviewrouter_release_migration', 'SET')) ORDER BY rolname)) FROM pg_roles WHERE rolname IN ('reviewrouter_api','reviewrouter_web','reviewrouter_worker','reviewrouter_release_migration') HAVING count(*) = 4`,
      ],
      { env: childEnv },
    ).trim(),
  );
  if (
    verifiedRoles.callerCount !== 1 ||
    verifiedRoles.roles.length !== 4 ||
    verifiedRoles.roles.some(
      (role) =>
        role.login !== true ||
        (role.username !== "reviewrouter_release_migration" &&
          role.canSetReleaseRole !== false),
    )
  )
    throw new Error("release_migration_role_observation_failed");
  return {
    version: 1,
    caller: "scripts/run-codex-rotating-release-migration.mjs",
    callerCount: 1,
    commit: configuration.commit,
    databaseIdentity: configuration.databaseIdentity,
    imageDigest: configuration.imageDigest,
    migrationStatus: "succeeded",
    preflightOutputSha256: createHash("sha256")
      .update(preflightOutput)
      .digest("hex"),
    preflightStatus: "passed",
    roles: verifiedRoles.roles,
    status: "succeeded",
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    process.stdout.write(
      `${JSON.stringify(executeCanonicalReleaseMigration())}\n`,
    );
  } catch (error) {
    process.stderr.write(
      `FAIL: ${error instanceof Error ? error.message : "release_migration_failed"}\n`,
    );
    process.exitCode = 1;
  }
}
