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

const canonicalBootstrapRoleName = "reviewrouter_role_bootstrap";

export function canonicalRoleTopologyObservationSql() {
  return `SELECT json_build_object(
    'callerCount', 1,
    'roles', (SELECT json_agg(json_build_object(
      'username', rolname,
      'login', rolcanlogin,
      'superuser', rolsuper,
      'createDatabase', rolcreatedb,
      'createRole', rolcreaterole,
      'replication', rolreplication,
      'bypassRls', rolbypassrls,
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
       OR granted.rolname = '${canonicalBootstrapRoleName}'
       OR member.rolname = '${canonicalBootstrapRoleName}'),
    'ownership', json_build_object(
      'databaseOwner', (SELECT owner.rolname
        FROM pg_database database
        JOIN pg_roles owner ON owner.oid = database.datdba
        WHERE database.datname = current_database()),
      'publicSchemaOwner', (SELECT owner.rolname
        FROM pg_namespace namespace
        JOIN pg_roles owner ON owner.oid = namespace.nspowner
        WHERE namespace.nspname = 'public'),
      'bootstrapSchemaOwner', (SELECT owner.rolname
        FROM pg_namespace namespace
        JOIN pg_roles owner ON owner.oid = namespace.nspowner
        WHERE namespace.nspname = 'reviewrouter_bootstrap'),
      'bootstrapFunctionOwner', (SELECT max(owner.rolname)
        FROM pg_proc routine
        JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace
        JOIN pg_roles owner ON owner.oid = routine.proowner
        WHERE namespace.nspname = 'reviewrouter_bootstrap'
          AND routine.proname = 'consume_migration_evidence'),
      'bootstrapFunctionCount', (SELECT count(*)
        FROM pg_proc routine
        JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace
        WHERE namespace.nspname = 'reviewrouter_bootstrap'
          AND routine.proname = 'consume_migration_evidence'),
      'unexpectedPublicObjectOwnerCount', (SELECT count(*) FROM (
        SELECT owner.rolname
        FROM pg_class relation
        JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        JOIN pg_roles owner ON owner.oid = relation.relowner
        WHERE namespace.nspname = 'public'
          AND relation.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
          AND owner.rolname <> 'reviewrouter_release_migration'
        UNION ALL
        SELECT owner.rolname
        FROM pg_proc routine
        JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace
        JOIN pg_roles owner ON owner.oid = routine.proowner
        WHERE namespace.nspname = 'public'
          AND owner.rolname <> 'reviewrouter_release_migration'
        UNION ALL
        SELECT owner.rolname
        FROM pg_type type
        JOIN pg_namespace namespace ON namespace.oid = type.typnamespace
        JOIN pg_roles owner ON owner.oid = type.typowner
        WHERE namespace.nspname = 'public'
          AND type.typtype IN ('d', 'e', 'm', 'r')
          AND owner.rolname <> 'reviewrouter_release_migration'
      ) unexpected_public_object_owners)
    )
  )`;
}

export function assertCanonicalRoleTopology(verifiedRoles) {
  const observedMatrixKeys = Array.isArray(verifiedRoles?.setRoleMatrix)
    ? new Set(
        verifiedRoles.setRoleMatrix.map(
          (entry) => `${entry.member}\u0000${entry.target}`,
        ),
      )
    : new Set();
  if (
    verifiedRoles?.callerCount !== 1 ||
    !Array.isArray(verifiedRoles.roles) ||
    verifiedRoles.roles.length !== canonicalRoleNames.length ||
    !Array.isArray(verifiedRoles.setRoleMatrix) ||
    verifiedRoles.setRoleMatrix.length !==
      canonicalRoleNames.length * canonicalRoleNames.length ||
    !Array.isArray(verifiedRoles.bootstrapMemberships) ||
    verifiedRoles.bootstrapMemberships.length !== canonicalRoleNames.length ||
    verifiedRoles.roles.some(
      (role) =>
        !canonicalRoleNames.includes(role.username) ||
        role.login !== true ||
        role.superuser !== false ||
        role.createDatabase !== false ||
        role.createRole !== false ||
        role.replication !== false ||
        role.bypassRls !== false ||
        role.canSetReleaseRole !==
          (role.username === "reviewrouter_release_migration"),
    ) ||
    new Set(verifiedRoles.roles.map((role) => role.username)).size !==
      canonicalRoleNames.length ||
    verifiedRoles.setRoleMatrix.some(
      (entry) =>
        !canonicalRoleNames.includes(entry.member) ||
        !canonicalRoleNames.includes(entry.target) ||
        entry.canSet !== (entry.member === entry.target),
    ) ||
    observedMatrixKeys.size !==
      canonicalRoleNames.length * canonicalRoleNames.length ||
    verifiedRoles.bootstrapMemberships.some(
      (entry) =>
        !canonicalRoleNames.includes(entry.granted) ||
        entry.member !== canonicalBootstrapRoleName ||
        entry.adminOption !== true ||
        entry.inheritOption !== false ||
        entry.setOption !== false,
    ) ||
    new Set(verifiedRoles.bootstrapMemberships.map((entry) => entry.granted))
      .size !== canonicalRoleNames.length ||
    verifiedRoles.ownership?.databaseOwner !== canonicalBootstrapRoleName ||
    verifiedRoles.ownership?.publicSchemaOwner !==
      "reviewrouter_release_migration" ||
    verifiedRoles.ownership?.bootstrapSchemaOwner !==
      canonicalBootstrapRoleName ||
    verifiedRoles.ownership?.bootstrapFunctionOwner !==
      canonicalBootstrapRoleName ||
    verifiedRoles.ownership?.bootstrapFunctionCount !== 1 ||
    verifiedRoles.ownership?.unexpectedPublicObjectOwnerCount !== 0
  )
    throw new Error("release_migration_role_observation_failed");
  return verifiedRoles;
}

function observeCanonicalRoleTopology(run, url, env) {
  return assertCanonicalRoleTopology(
    JSON.parse(
      run(
        "verify_roles",
        "psql",
        [
          url,
          "--no-psqlrc",
          "--tuples-only",
          "--no-align",
          "--command",
          canonicalRoleTopologyObservationSql(),
        ],
        { env },
      ).trim(),
    ),
  );
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
  const commit = required(env, "REVIEW_ROUTER_RELEASE_COMMIT_SHA");
  const imageDigest = required(env, "REVIEW_ROUTER_RELEASE_IMAGE_DIGEST");
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
    releasePassword,
    roles,
  };
}

export function resolveRoleBootstrapConfiguration(env) {
  const configuration = resolveReleaseMigrationConfiguration(env);
  const bootstrapUrl = new URL(
    required(env, "REVIEW_ROUTER_ROLE_BOOTSTRAP_DATABASE_URL"),
  );
  if (
    decodeURIComponent(bootstrapUrl.username) !== "reviewrouter_role_bootstrap"
  )
    throw new Error("release_migration_bootstrap_role_mismatch");
  if (databaseIdentity(bootstrapUrl) !== configuration.databaseIdentity)
    throw new Error("release_migration_bootstrap_database_mismatch");
  if (!decodeURIComponent(bootstrapUrl.password))
    throw new Error("release_migration_bootstrap_password_missing");
  return { ...configuration, bootstrapUrl: bootstrapUrl.toString() };
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
  ELSIF observed.rolsuper OR observed.rolcreatedb OR observed.rolreplication OR observed.rolbypassrls THEN
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
GRANT USAGE, CREATE ON SCHEMA public TO reviewrouter_release_migration;
GRANT reviewrouter_release_migration TO reviewrouter_role_bootstrap WITH SET TRUE;
DO $ownership$
DECLARE unexpected_owner text;
BEGIN
  SELECT owner_name INTO unexpected_owner
  FROM (
    SELECT owner.rolname AS owner_name
    FROM pg_class relation
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    JOIN pg_roles owner ON owner.oid = relation.relowner
    WHERE namespace.nspname = 'public'
      AND relation.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
    UNION ALL
    SELECT owner.rolname AS owner_name
    FROM pg_proc routine
    JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace
    JOIN pg_roles owner ON owner.oid = routine.proowner
    WHERE namespace.nspname = 'public'
    UNION ALL
    SELECT owner.rolname AS owner_name
    FROM pg_type type
    JOIN pg_namespace namespace ON namespace.oid = type.typnamespace
    JOIN pg_roles owner ON owner.oid = type.typowner
    WHERE namespace.nspname = 'public'
      AND type.typtype IN ('d', 'e', 'm', 'r')
  ) owned
  WHERE owner_name NOT IN ('reviewrouter_role_bootstrap', 'reviewrouter_release_migration')
  ORDER BY owner_name
  LIMIT 1;
  IF unexpected_owner IS NOT NULL THEN
    RAISE EXCEPTION 'refusing to take over public objects owned by unexpected role %', unexpected_owner;
  END IF;
END
$ownership$;
DROP FUNCTION IF EXISTS reviewrouter_bootstrap.consume_migration_evidence(text,text,text,text,integer,text,text,text,text);
DROP SCHEMA IF EXISTS reviewrouter_bootstrap;
DO $transfer_public_ownership$
DECLARE owned_object record;
BEGIN
  FOR owned_object IN
    SELECT relation.oid, relation.relkind
    FROM pg_class relation
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    JOIN pg_roles owner ON owner.oid = relation.relowner
    WHERE namespace.nspname = 'public'
      AND owner.rolname = 'reviewrouter_role_bootstrap'
      AND relation.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
  LOOP
    EXECUTE CASE owned_object.relkind
      WHEN 'S' THEN format('ALTER SEQUENCE %s OWNER TO reviewrouter_release_migration', owned_object.oid::regclass)
      WHEN 'v' THEN format('ALTER VIEW %s OWNER TO reviewrouter_release_migration', owned_object.oid::regclass)
      WHEN 'm' THEN format('ALTER MATERIALIZED VIEW %s OWNER TO reviewrouter_release_migration', owned_object.oid::regclass)
      WHEN 'f' THEN format('ALTER FOREIGN TABLE %s OWNER TO reviewrouter_release_migration', owned_object.oid::regclass)
      ELSE format('ALTER TABLE %s OWNER TO reviewrouter_release_migration', owned_object.oid::regclass)
    END;
  END LOOP;
  FOR owned_object IN
    SELECT routine.oid
    FROM pg_proc routine
    JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace
    JOIN pg_roles owner ON owner.oid = routine.proowner
    WHERE namespace.nspname = 'public'
      AND owner.rolname = 'reviewrouter_role_bootstrap'
  LOOP
    EXECUTE format('ALTER ROUTINE %s OWNER TO reviewrouter_release_migration', owned_object.oid::regprocedure);
  END LOOP;
  FOR owned_object IN
    SELECT type.typname, type.typtype
    FROM pg_type type
    JOIN pg_namespace namespace ON namespace.oid = type.typnamespace
    JOIN pg_roles owner ON owner.oid = type.typowner
    WHERE namespace.nspname = 'public'
      AND owner.rolname = 'reviewrouter_role_bootstrap'
      AND type.typtype IN ('d', 'e', 'm', 'r')
  LOOP
    IF owned_object.typtype = 'd' THEN
      EXECUTE format('ALTER DOMAIN public.%I OWNER TO reviewrouter_release_migration', owned_object.typname);
    ELSE
      EXECUTE format('ALTER TYPE public.%I OWNER TO reviewrouter_release_migration', owned_object.typname);
    END IF;
  END LOOP;
END
$transfer_public_ownership$;
SELECT 'ALTER SCHEMA public OWNER TO reviewrouter_release_migration'
WHERE (SELECT owner.rolname FROM pg_namespace namespace JOIN pg_roles owner ON owner.oid = namespace.nspowner WHERE namespace.nspname = 'public') <> 'reviewrouter_release_migration'
\\gexec
REVOKE reviewrouter_release_migration FROM reviewrouter_role_bootstrap GRANTED BY CURRENT_ROLE;
CREATE SCHEMA IF NOT EXISTS reviewrouter_bootstrap AUTHORIZATION reviewrouter_role_bootstrap;
DO $bootstrap_schema$
BEGIN
  IF (SELECT owner.rolname FROM pg_namespace namespace JOIN pg_roles owner ON owner.oid = namespace.nspowner WHERE namespace.nspname = 'reviewrouter_bootstrap') <> 'reviewrouter_role_bootstrap' THEN
    RAISE EXCEPTION 'reviewrouter bootstrap schema owner is invalid';
  END IF;
END
$bootstrap_schema$;
REVOKE ALL ON SCHEMA reviewrouter_bootstrap FROM PUBLIC;
GRANT USAGE ON SCHEMA reviewrouter_bootstrap TO reviewrouter_release_migration;
CREATE OR REPLACE FUNCTION reviewrouter_bootstrap.consume_migration_evidence(
  artifact_digest text,
  artifact_id text,
  rollout_id text,
  run_id text,
  run_attempt integer,
  job_id text,
  workflow_path text,
  commit_sha text,
  image_digest text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $receipt$
DECLARE
  binding jsonb;
  receipts jsonb;
BEGIN
  IF session_user <> 'reviewrouter_release_migration'
     OR artifact_digest !~ '^sha256:[a-f0-9]{64}$'
     OR artifact_id !~ '^[1-9][0-9]*$'
     OR rollout_id = ''
     OR run_id !~ '^[1-9][0-9]*$'
     OR run_attempt <= 0
     OR job_id !~ '^[1-9][0-9]*$'
     OR workflow_path <> '.github/workflows/codex-rotating-release-migration.yml'
     OR commit_sha !~ '^[a-f0-9]{40}$'
     OR image_digest !~ '^sha256:[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'trusted migration evidence receipt invalid';
  END IF;
  PERFORM pg_advisory_xact_lock(1381126735, 1129271120);
  SELECT obj_description(oid, 'pg_database')::jsonb INTO binding
  FROM pg_database WHERE datname = current_database();
  IF binding IS NULL
     OR binding->>'systemIdentifier' <> (SELECT system_identifier::text FROM pg_control_system())
     OR binding->>'recoveryWitnessSha256' !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'trusted migration evidence database generation binding invalid';
  END IF;
  receipts := coalesce(binding->'consumedMigrationEvidence', '[]'::jsonb);
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(receipts) receipt
    WHERE receipt->>'artifactDigest' = artifact_digest
       OR receipt->>'rolloutId' = rollout_id
       OR (receipt->>'runId' = run_id AND receipt->>'artifactId' = artifact_id)
  ) THEN
    RAISE EXCEPTION 'trusted migration evidence replay rejected';
  END IF;
  binding := jsonb_set(binding, '{version}', '3'::jsonb, true);
  binding := jsonb_set(
    binding,
    '{consumedMigrationEvidence}',
    receipts || jsonb_build_array(jsonb_build_object(
      'artifactDigest', artifact_digest,
      'artifactId', artifact_id,
      'rolloutId', rollout_id,
      'runId', run_id,
      'runAttempt', run_attempt,
      'jobId', job_id,
      'workflowPath', workflow_path,
      'commit', commit_sha,
      'imageDigest', image_digest,
      'claimedAt', to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    )),
    true
  );
  EXECUTE format('COMMENT ON DATABASE %I IS %L', current_database(), binding::text);
  RETURN true;
END
$receipt$;
ALTER FUNCTION reviewrouter_bootstrap.consume_migration_evidence(text,text,text,text,integer,text,text,text,text) OWNER TO reviewrouter_role_bootstrap;
REVOKE ALL ON FUNCTION reviewrouter_bootstrap.consume_migration_evidence(text,text,text,text,integer,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reviewrouter_bootstrap.consume_migration_evidence(text,text,text,text,integer,text,text,text,text) TO reviewrouter_release_migration;
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
REVOKE ALL ON TABLE public."_prisma_migrations" FROM ${username};
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

export function executeCanonicalRoleBootstrap(
  env = process.env,
  run = runReleaseMigrationSubprocess,
) {
  const configuration = resolveRoleBootstrapConfiguration(env);
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
    { env: bootstrapEnv, input: roleProvisioningSql(configuration) },
  );
  const releaseEnv = { ...env, DATABASE_URL: configuration.releaseUrl };
  assertConnectionRole(
    observeConnectionRole(
      run,
      "verify_release_authority",
      configuration.releaseUrl,
      releaseEnv,
    ),
    "reviewrouter_release_migration",
    false,
  );
  const verifiedRoles = observeCanonicalRoleTopology(
    run,
    configuration.bootstrapUrl,
    bootstrapEnv,
  );
  return {
    version: 2,
    caller: "scripts/run-codex-rotating-role-bootstrap.mjs",
    commit: configuration.commit,
    databaseIdentity: configuration.databaseIdentity,
    imageDigest: configuration.imageDigest,
    roles: verifiedRoles.roles,
    bootstrapMemberships: verifiedRoles.bootstrapMemberships,
    status: "succeeded",
  };
}

export function executeCanonicalReleaseMigration(
  env = process.env,
  run = runReleaseMigrationSubprocess,
) {
  const configuration = resolveReleaseMigrationConfiguration(env);
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
  const verifiedRoles = observeCanonicalRoleTopology(
    run,
    configuration.releaseUrl,
    childEnv,
  );
  return {
    version: 2,
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
