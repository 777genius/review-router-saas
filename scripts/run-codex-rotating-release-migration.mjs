#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const runtimeRoles = [
  ["api", "reviewrouter_api", "REVIEW_ROUTER_API_DATABASE_URL"],
  ["web", "reviewrouter_web", "REVIEW_ROUTER_WEB_DATABASE_URL"],
  ["worker", "reviewrouter_worker", "REVIEW_ROUTER_WORKER_DATABASE_URL"],
  [
    "effect-authority",
    "reviewrouter_codex_effect_authority",
    "REVIEW_ROUTER_CODEX_EFFECT_AUTHORITY_DATABASE_URL",
  ],
];

export const rotatingEvidenceTables = Object.freeze([
  "CodexOAuthChildIdentityQuarantine",
  "CodexOAuthLease",
  "CodexOAuthProviderIdentityQuarantine",
  "CodexOAuthProviderInstance",
  "CodexOAuthSecretNamespace",
  "CodexOAuthSetupDispatchAttempt",
  "CodexOAuthSetupManifest",
  "CodexOAuthSetupPayloadClaim",
  "CodexOAuthSetupRecoveryRequest",
  "CodexOAuthWritebackIntent",
]);

const quarantineTables = Object.freeze([
  "CodexOAuthChildIdentityQuarantine",
  "CodexOAuthProviderIdentityQuarantine",
]);

const fullyProtectedRuntimeTables = Object.freeze([
  "CodexOAuthDatabaseAuthorityKey",
  "CodexOAuthDatabaseAuthorityReceipt",
]);

export const providerRuntimeUpdateColumns = Object.freeze([
  "state",
  "latestGeneration",
  "latestGenerationHash",
  "activeLeaseId",
  "activeLeaseExpiresAt",
  "mutationEpoch",
  "mutationOwner",
  "mutationOwnerId",
  "activeSecretNamespaceId",
  "activeSecretNamespaceEpoch",
  "activeSecretNamespaceName",
  "activeAccountIdentityHash",
  "updatedAt",
]);

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

const canonicalRoleNames = Object.freeze([
  "reviewrouter_api",
  "reviewrouter_web",
  "reviewrouter_worker",
  "reviewrouter_codex_effect_authority",
  "reviewrouter_release_migration",
]);

export function resolveReleaseMigrationConfiguration(env) {
  const bootstrapUrl = new URL(
    required(env, "REVIEW_ROUTER_ROLE_BOOTSTRAP_DATABASE_URL"),
  );
  const releaseUrl = new URL(
    required(env, "REVIEW_ROUTER_RELEASE_MIGRATION_DATABASE_URL"),
  );
  if (
    decodeURIComponent(bootstrapUrl.username) !== "reviewrouter_role_bootstrap"
  )
    throw new Error("release_migration_bootstrap_role_mismatch");
  if (
    decodeURIComponent(releaseUrl.username) !== "reviewrouter_release_migration"
  )
    throw new Error("release_migration_caller_role_mismatch");
  const identity = databaseIdentity(releaseUrl);
  if (databaseIdentity(bootstrapUrl) !== identity)
    throw new Error("release_migration_bootstrap_database_mismatch");
  if (!decodeURIComponent(bootstrapUrl.password))
    throw new Error("release_migration_bootstrap_password_missing");
  const releasePassword = decodeURIComponent(releaseUrl.password);
  if (!releasePassword)
    throw new Error("release_migration_release_password_missing");
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
    bootstrapUrl: bootstrapUrl.toString(),
    commit,
    databaseIdentity: identity,
    imageDigest,
    releaseUrl: releaseUrl.toString(),
    releasePassword,
    roles,
  };
}

export function roleProvisioningSql(configuration) {
  const createAndConverge = [
    ...configuration.roles,
    {
      username: "reviewrouter_release_migration",
      password: configuration.releasePassword,
    },
  ]
    .map(
      ({ username, password }) => `
DO $role$
DECLARE observed record;
BEGIN
  SELECT * INTO observed FROM pg_roles WHERE rolname = '${username}';
  IF NOT FOUND THEN
    CREATE ROLE ${username} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${quoted(password)};
  ELSIF observed.rolsuper OR observed.rolreplication OR observed.rolbypassrls THEN
    RAISE EXCEPTION 'refusing to converge unexpectedly privileged role ${username}';
  END IF;
END
$role$;
ALTER ROLE ${username} LOGIN NOCREATEROLE PASSWORD ${quoted(password)};
DO $membership$
DECLARE membership record;
BEGIN
  FOR membership IN
    SELECT granted.rolname AS granted_name, member.rolname AS member_name
    FROM pg_auth_members edge
    JOIN pg_roles granted ON granted.oid = edge.roleid
    JOIN pg_roles member ON member.oid = edge.member
    WHERE (granted.rolname = '${username}' OR member.rolname = '${username}')
      AND NOT (
        granted.rolname = '${username}'
        AND member.rolname = 'reviewrouter_role_bootstrap'
      )
  LOOP
    EXECUTE format('REVOKE %I FROM %I', membership.granted_name, membership.member_name);
  END LOOP;
END
$membership$;
`,
    )
    .join("\n");
  return `\\set ON_ERROR_STOP on
BEGIN;
${createAndConverge}
SELECT 'REVOKE CREATE ON SCHEMA public FROM PUBLIC'
WHERE EXISTS (
  SELECT 1
  FROM pg_namespace namespace,
       LATERAL aclexplode(coalesce(namespace.nspacl, acldefault('n', namespace.nspowner))) acl
  WHERE namespace.nspname = 'public'
    AND acl.grantee = 0
    AND acl.privilege_type = 'CREATE'
)
\\gexec
SELECT format('GRANT CONNECT, CREATE ON DATABASE %I TO reviewrouter_release_migration', current_database())
\\gexec
GRANT reviewrouter_release_migration TO reviewrouter_role_bootstrap WITH SET TRUE;
SELECT 'ALTER SCHEMA public OWNER TO reviewrouter_release_migration'
WHERE (SELECT owner.rolname FROM pg_namespace namespace JOIN pg_roles owner ON owner.oid = namespace.nspowner WHERE namespace.nspname = 'public') <> 'reviewrouter_release_migration'
\\gexec
REVOKE reviewrouter_release_migration FROM reviewrouter_role_bootstrap GRANTED BY CURRENT_ROLE;
COMMIT;
`;
}

function connectionRoleObservationSql() {
  return `SELECT json_build_object(
    'currentUser', current_user,
    'sessionUser', session_user,
    'login', role.rolcanlogin,
    'superuser', role.rolsuper,
    'createDatabase', role.rolcreatedb,
    'createRole', role.rolcreaterole,
    'replication', role.rolreplication,
    'bypassRls', role.rolbypassrls
  ) FROM pg_roles role WHERE role.rolname = session_user`;
}

function observeConnectionRole(run, step, url, env) {
  return JSON.parse(
    run(
      step,
      "psql",
      [
        url,
        "--no-psqlrc",
        "--tuples-only",
        "--no-align",
        "--command",
        connectionRoleObservationSql(),
      ],
      { env },
    ).trim(),
  );
}

function assertConnectionRole(observed, expectedUser, expectCreateRole) {
  if (
    observed?.currentUser !== expectedUser ||
    observed?.sessionUser !== expectedUser ||
    observed?.login !== true ||
    observed?.createRole !== expectCreateRole ||
    observed?.superuser !== false ||
    observed?.createDatabase !== false ||
    observed?.replication !== false ||
    observed?.bypassRls !== false
  )
    throw new Error(
      `release_migration_connection_authority_mismatch:${expectedUser}`,
    );
}

export function runtimeGrantStatements(
  configuration,
  databaseTarget = ':"DBNAME"',
) {
  const rotatingEvidenceLiterals = rotatingEvidenceTables
    .map((table) => `'${table}'`)
    .join(",");
  const quarantineLiterals = quarantineTables
    .map((table) => `'${table}'`)
    .join(",");
  const staleColumnAclLiterals = [
    "RepositoryConnection",
    ...rotatingEvidenceTables,
    ...fullyProtectedRuntimeTables,
  ]
    .map((table) => `'${table}'`)
    .join(",");
  const providerUpdateColumnList = providerRuntimeUpdateColumns
    .map((column) => `"${column}"`)
    .join(", ");
  return `
REVOKE CREATE ON DATABASE ${databaseTarget} FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
${configuration.roles
  .filter(({ role }) => role !== "effect-authority")
  .map(
    ({
      role,
      username,
    }) => `GRANT CONNECT ON DATABASE ${databaseTarget} TO ${username};
GRANT USAGE ON SCHEMA public TO ${username};
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM ${username};
GRANT EXECUTE ON FUNCTION public."codex_oauth_database_authority_challenge"(text, text, integer) TO ${username};
GRANT EXECUTE ON FUNCTION public."codex_oauth_consume_database_authority"(text, text, integer) TO ${username};
${
  role === "web"
    ? `GRANT EXECUTE ON FUNCTION public."codex_oauth_authorize_setup_confirmation"(text, integer, text) TO ${username};
GRANT EXECUTE ON FUNCTION public."codex_oauth_provider_identity_repair_challenge"(text,text,text,text,text,text,text,bigint,text,text,text,text,text,text,bigint) TO ${username};
GRANT EXECUTE ON FUNCTION public."codex_oauth_repair_quarantined_provider"(text,text,text,text,text,text,text,bigint,text,text,text,text,text,text,bigint,text) TO ${username};`
    : role === "api"
      ? `GRANT EXECUTE ON FUNCTION public."codex_oauth_authorize_runtime_confirmation"(text, text, integer, text) TO ${username};
GRANT EXECUTE ON FUNCTION public."codex_oauth_authorize_runtime_completion"(text, text) TO ${username};`
      : ""
}
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${username};
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${username};
DO $runtime_acl$
DECLARE protected_column record;
BEGIN
  FOR protected_column IN
    SELECT relation.relname AS table_name, attribute.attname AS column_name
    FROM pg_class relation
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    JOIN pg_attribute attribute ON attribute.attrelid = relation.oid
    WHERE namespace.nspname = 'public'
      AND relation.relname IN (${staleColumnAclLiterals})
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  LOOP
    EXECUTE format(
      'REVOKE ALL (%I) ON TABLE public.%I FROM %I',
      protected_column.column_name,
      protected_column.table_name,
      '${username}'
    );
  END LOOP;
END
$runtime_acl$;
REVOKE INSERT, UPDATE, DELETE ON TABLE public."RepositoryConnection" FROM ${username};
GRANT SELECT ON TABLE public."RepositoryConnection" TO ${username};
DO $runtime_evidence_acl$
DECLARE protected_table text;
BEGIN
  FOREACH protected_table IN ARRAY ARRAY[${rotatingEvidenceLiterals}] LOOP
    EXECUTE format(
      'REVOKE DELETE ON TABLE public.%I FROM %I',
      protected_table,
      '${username}'
    );
  END LOOP;
  FOREACH protected_table IN ARRAY ARRAY[${quarantineLiterals}] LOOP
    EXECUTE format(
      'REVOKE INSERT, UPDATE, DELETE ON TABLE public.%I FROM %I',
      protected_table,
      '${username}'
    );
  END LOOP;
END
$runtime_evidence_acl$;
REVOKE UPDATE ON TABLE public."CodexOAuthProviderInstance" FROM ${username};
GRANT UPDATE (${providerUpdateColumnList}) ON TABLE public."CodexOAuthProviderInstance" TO ${username};
REVOKE ALL ON TABLE public."CodexOAuthDatabaseAuthorityKey" FROM ${username};
REVOKE ALL ON TABLE public."CodexOAuthDatabaseAuthorityReceipt" FROM ${username};
REVOKE TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public FROM ${username};
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO ${username};
ALTER DEFAULT PRIVILEGES FOR ROLE reviewrouter_release_migration IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${username};
ALTER DEFAULT PRIVILEGES FOR ROLE reviewrouter_release_migration IN SCHEMA public GRANT USAGE ON SEQUENCES TO ${username};`,
  )
  .join("\n")}
GRANT CONNECT ON DATABASE ${databaseTarget} TO reviewrouter_codex_effect_authority;
GRANT USAGE ON SCHEMA public TO reviewrouter_codex_effect_authority;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM reviewrouter_codex_effect_authority;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM reviewrouter_codex_effect_authority;
REVOKE CREATE ON SCHEMA public FROM reviewrouter_codex_effect_authority;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM reviewrouter_codex_effect_authority;
GRANT EXECUTE ON FUNCTION public."codex_oauth_sign_database_authority"(text) TO reviewrouter_codex_effect_authority;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
`;
}

export function runtimeGrantSql(configuration) {
  return `\\set ON_ERROR_STOP on
BEGIN;
${runtimeGrantStatements(configuration)}
COMMIT;
`;
}

export function runReleaseMigrationSubprocess(
  step,
  command,
  args,
  { env, input } = {},
) {
  const result = spawnSync(command, args, {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
    env,
    input,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0)
    throw new Error(`release_migration_step_failed:${step}`);
  return result.stdout;
}

export function executeCanonicalReleaseMigration(
  env = process.env,
  run = runReleaseMigrationSubprocess,
) {
  const configuration = resolveReleaseMigrationConfiguration(env);
  const bootstrapEnv = { ...env, DATABASE_URL: configuration.bootstrapUrl };
  assertConnectionRole(
    observeConnectionRole(
      run,
      "verify_bootstrap_authority",
      configuration.bootstrapUrl,
      bootstrapEnv,
    ),
    "reviewrouter_role_bootstrap",
    true,
  );
  run(
    "provision_roles",
    "psql",
    [configuration.bootstrapUrl, "--no-psqlrc", "--quiet"],
    {
      env: bootstrapEnv,
      input: roleProvisioningSql(configuration),
    },
  );
  const childEnv = { ...env, DATABASE_URL: configuration.releaseUrl };
  assertConnectionRole(
    observeConnectionRole(
      run,
      "verify_release_authority",
      configuration.releaseUrl,
      childEnv,
    ),
    "reviewrouter_release_migration",
    false,
  );
  const preflightOutput = run(
    "migration_history_preflight",
    "node",
    [
      "--import",
      "tsx",
      "scripts/preflight-codex-rotating-migration-history.ts",
    ],
    { env: childEnv },
  );
  run(
    "deploy_migrations",
    "pnpm",
    ["--filter", "@reviewrouter/platform-db", "db:migrate:deploy"],
    { env: childEnv },
  );
  run(
    "converge_runtime_grants",
    "psql",
    [configuration.releaseUrl, "--no-psqlrc", "--quiet"],
    {
      env: childEnv,
      input: runtimeGrantSql(configuration),
    },
  );
  const verifiedRoles = JSON.parse(
    run(
      "verify_roles",
      "psql",
      [
        configuration.releaseUrl,
        "--no-psqlrc",
        "--tuples-only",
        "--no-align",
        "--command",
        `SELECT json_build_object(
          'callerCount', 1,
          'roles', (SELECT json_agg(json_build_object(
            'username', rolname,
            'login', rolcanlogin,
            'createRole', rolcreaterole,
            'canSetReleaseRole', pg_has_role(rolname, 'reviewrouter_release_migration', 'SET')
          ) ORDER BY rolname) FROM pg_roles WHERE rolname = ANY (ARRAY[${canonicalRoleNames.map(quoted).join(",")}])) ,
          'setRoleMatrix', (SELECT json_agg(json_build_object(
            'member', member.rolname,
            'target', target.rolname,
            'canSet', pg_has_role(member.oid, target.oid, 'SET')
          ) ORDER BY member.rolname, target.rolname)
          FROM pg_roles member CROSS JOIN pg_roles target
          WHERE member.rolname = ANY (ARRAY[${canonicalRoleNames.map(quoted).join(",")}])
            AND target.rolname = ANY (ARRAY[${canonicalRoleNames.map(quoted).join(",")}])) ,
          'bootstrapMemberships', (SELECT json_agg(json_build_object(
            'granted', granted.rolname,
            'member', member.rolname,
            'adminOption', membership.admin_option,
            'inheritOption', membership.inherit_option,
            'setOption', membership.set_option
          ) ORDER BY granted.rolname, member.rolname)
          FROM pg_auth_members membership
          JOIN pg_roles granted ON granted.oid = membership.roleid
          JOIN pg_roles member ON member.oid = membership.member
          WHERE granted.rolname = ANY (ARRAY[${canonicalRoleNames.map(quoted).join(",")}])
             OR member.rolname = ANY (ARRAY[${canonicalRoleNames.map(quoted).join(",")}])
             OR granted.rolname = 'reviewrouter_role_bootstrap'
             OR member.rolname = 'reviewrouter_role_bootstrap')
        )`,
      ],
      { env: childEnv },
    ).trim(),
  );
  if (
    verifiedRoles.callerCount !== 1 ||
    verifiedRoles.roles.length !== 5 ||
    verifiedRoles.setRoleMatrix.length !== 25 ||
    !Array.isArray(verifiedRoles.bootstrapMemberships) ||
    verifiedRoles.bootstrapMemberships.length !== 5 ||
    verifiedRoles.roles.some(
      (role) =>
        role.login !== true ||
        role.createRole !== false ||
        (role.username !== "reviewrouter_release_migration" &&
          role.canSetReleaseRole !== false),
    ) ||
    verifiedRoles.setRoleMatrix.some(
      (entry) => entry.canSet !== (entry.member === entry.target),
    ) ||
    verifiedRoles.bootstrapMemberships.some(
      (entry) =>
        !canonicalRoleNames.includes(entry.granted) ||
        entry.member !== "reviewrouter_role_bootstrap" ||
        entry.adminOption !== true ||
        entry.inheritOption !== false ||
        entry.setOption !== false,
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
