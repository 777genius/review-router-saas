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
  const url = parseDatabaseUrl(value);
  if (
    !/\.internal$/u.test(url.hostname) &&
    !/^dpg-[a-z0-9-]+$/u.test(url.hostname)
  )
    throw new Error("release_migration_private_database_host_required");
  const port = url.port || "5432";
  return `${url.hostname.toLowerCase()}:${port}${url.pathname}`;
}

function parseDatabaseUrl(value) {
  try {
    return value instanceof URL ? value : new URL(value);
  } catch {
    throw new Error("release_migration_database_url_invalid");
  }
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
      'grantor', grantor.rolname,
      'adminOption', membership.admin_option,
      'inheritOption', membership.inherit_option,
      'setOption', membership.set_option
    ) ORDER BY granted.rolname, member.rolname)
    FROM pg_auth_members membership
    JOIN pg_roles granted ON granted.oid = membership.roleid
    JOIN pg_roles member ON member.oid = membership.member
    JOIN pg_roles grantor ON grantor.oid = membership.grantor
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
        entry.grantor === canonicalBootstrapRoleName ||
        canonicalRoleNames.includes(entry.grantor) ||
        entry.adminOption !== true ||
        entry.inheritOption !== false ||
        entry.setOption !== false,
    ) ||
    new Set(verifiedRoles.bootstrapMemberships.map((entry) => entry.granted))
      .size !== canonicalRoleNames.length ||
    new Set(verifiedRoles.bootstrapMemberships.map((entry) => entry.grantor))
      .size !== 1 ||
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

export function canonicalDatabaseGenerationObservationSql() {
  return `SELECT json_build_object(
    'systemIdentifier', system.system_identifier::text,
    'recoveryWitnessSha256', binding.value->>'recoveryWitnessSha256'
  )
  FROM pg_control_system() system
  CROSS JOIN LATERAL (
    SELECT shobj_description(database.oid, 'pg_database')::jsonb AS value
    FROM pg_database database
    WHERE database.datname = current_database()
  ) binding`;
}

function observeDatabaseGeneration(run, url, env) {
  const generation = JSON.parse(
    run(
      "verify_database_generation",
      "psql",
      [
        url,
        "--no-psqlrc",
        "--tuples-only",
        "--no-align",
        "--command",
        canonicalDatabaseGenerationObservationSql(),
      ],
      { env },
    ).trim(),
  );
  if (
    !generation ||
    Object.keys(generation).length !== 2 ||
    typeof generation.systemIdentifier !== "string" ||
    !/^[0-9]+$/u.test(generation.systemIdentifier ?? "") ||
    typeof generation.recoveryWitnessSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(generation.recoveryWitnessSha256 ?? "")
  ) {
    throw new Error("release_migration_database_generation_unproven");
  }
  return Object.freeze(generation);
}

export function resolveReleaseMigrationConfiguration(env) {
  const releaseUrl = parseDatabaseUrl(
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
    const url = parseDatabaseUrl(required(env, environmentName));
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
  const bootstrapUrl = parseDatabaseUrl(
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
    EXECUTE format(
      'REVOKE %I FROM %I GRANTED BY reviewrouter_role_bootstrap',
      membership.granted_name,
      membership.member_name
    );
  END LOOP;
END
$membership$;
`,
    )
    .join("\n");
  return `\\set ON_ERROR_STOP on
BEGIN;
${createAndConverge}
DO $grantor_topology$
DECLARE total_count integer;
DECLARE canonical_count integer;
DECLARE granted_role_count integer;
DECLARE grantor_count integer;
BEGIN
  SELECT count(*),
         count(*) FILTER (
           WHERE granted.rolname = ANY (ARRAY[${canonicalRoleNames.map(quoted).join(",")}])
             AND member.rolname = '${canonicalBootstrapRoleName}'
             AND grantor.rolname <> '${canonicalBootstrapRoleName}'
             AND grantor.rolname <> ALL (ARRAY[${canonicalRoleNames.map(quoted).join(",")}])
             AND membership.admin_option
             AND NOT membership.inherit_option
             AND NOT membership.set_option
         ),
         count(DISTINCT granted.oid) FILTER (
           WHERE granted.rolname = ANY (ARRAY[${canonicalRoleNames.map(quoted).join(",")}])
             AND member.rolname = '${canonicalBootstrapRoleName}'
         ),
         count(DISTINCT grantor.oid)
  INTO total_count, canonical_count, granted_role_count, grantor_count
  FROM pg_auth_members membership
  JOIN pg_roles granted ON granted.oid = membership.roleid
  JOIN pg_roles member ON member.oid = membership.member
  JOIN pg_roles grantor ON grantor.oid = membership.grantor
  WHERE (
      granted.rolname = ANY (ARRAY[${canonicalRoleNames.map(quoted).join(",")}])
      OR member.rolname = ANY (ARRAY[${canonicalRoleNames.map(quoted).join(",")}])
      OR granted.rolname = '${canonicalBootstrapRoleName}'
      OR member.rolname = '${canonicalBootstrapRoleName}'
    )
  ;
  IF total_count <> ${canonicalRoleNames.length}
     OR canonical_count <> ${canonicalRoleNames.length}
     OR granted_role_count <> ${canonicalRoleNames.length}
     OR grantor_count <> 1 THEN
    RAISE EXCEPTION
      'refusing non-canonical role membership topology: total %, canonical %, roles %, grantors %',
      total_count, canonical_count, granted_role_count, grantor_count;
  END IF;
END
$grantor_topology$;
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
SELECT format('REVOKE CONNECT ON DATABASE %I FROM PUBLIC', current_database())
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
DO $activation_boundary$
DECLARE activation_count bigint;
BEGIN
  IF to_regclass('reviewrouter_bootstrap.release_generation_activation_receipt') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM reviewrouter_bootstrap.release_generation_activation_receipt' INTO activation_count;
  END IF;
  IF coalesce(activation_count, 0) > 0 THEN
    RAISE EXCEPTION 'role bootstrap forbidden after generation activation';
  END IF;
END
$activation_boundary$;
DROP FUNCTION IF EXISTS reviewrouter_bootstrap.consume_migration_evidence(text,text,text,text,integer,text,text,text,text);
DROP FUNCTION IF EXISTS reviewrouter_bootstrap.consume_migration_evidence(text,text,text,text,integer,text,text,text,text,text,text);
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
      AND (
        relation.relkind <> 'S'
        OR NOT EXISTS (
          SELECT 1
          FROM pg_depend dependency
          WHERE dependency.classid = 'pg_class'::regclass
            AND dependency.objid = relation.oid
            AND dependency.refclassid = 'pg_class'::regclass
            AND dependency.deptype IN ('a', 'i')
        )
      )
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
CREATE TABLE IF NOT EXISTS reviewrouter_bootstrap.release_generation_activation_receipt (
  rollout_id text PRIMARY KEY,
  expected_commit_sha text NOT NULL CHECK (expected_commit_sha ~ '^[a-f0-9]{40}$'),
  run_id text NOT NULL CHECK (run_id ~ '^[1-9][0-9]*$'),
  job_id text NOT NULL CHECK (job_id ~ '^[1-9][0-9]*$'),
  run_attempt integer NOT NULL CHECK (run_attempt = 1),
  source_system_identifier text NOT NULL,
  target_system_identifier text NOT NULL,
  previous_receipt_sha256 text NOT NULL CHECK (previous_receipt_sha256 ~ '^sha256:[a-f0-9]{64}$'),
  fence_nonce text NOT NULL CHECK (fence_nonce ~ '^[a-f0-9]{32}$'),
  fence_version integer NOT NULL CHECK (fence_version > 0),
  canonical_privileges_sha256 text NOT NULL CHECK (canonical_privileges_sha256 ~ '^sha256:[a-f0-9]{64}$'),
  catalog_facts_sha256 text NOT NULL CHECK (catalog_facts_sha256 ~ '^sha256:[a-f0-9]{64}$'),
  first_write_receipt_sha256 text NOT NULL CHECK (first_write_receipt_sha256 ~ '^sha256:[a-f0-9]{64}$'),
  transaction_id bigint NOT NULL,
  activated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CHECK (source_system_identifier ~ '^[0-9]+$'),
  CHECK (target_system_identifier ~ '^[0-9]+$'),
  CHECK (source_system_identifier <> target_system_identifier),
  UNIQUE (target_system_identifier)
);
ALTER TABLE reviewrouter_bootstrap.release_generation_activation_receipt
  ADD COLUMN IF NOT EXISTS catalog_facts_sha256 text NOT NULL CHECK (catalog_facts_sha256 ~ '^sha256:[a-f0-9]{64}$'),
  ADD COLUMN IF NOT EXISTS first_write_receipt_sha256 text NOT NULL CHECK (first_write_receipt_sha256 ~ '^sha256:[a-f0-9]{64}$'),
  ADD COLUMN IF NOT EXISTS expected_commit_sha text NOT NULL CHECK (expected_commit_sha ~ '^[a-f0-9]{40}$'),
  ADD COLUMN IF NOT EXISTS run_id text NOT NULL CHECK (run_id ~ '^[1-9][0-9]*$'),
  ADD COLUMN IF NOT EXISTS job_id text NOT NULL CHECK (job_id ~ '^[1-9][0-9]*$'),
  ADD COLUMN IF NOT EXISTS run_attempt integer NOT NULL CHECK (run_attempt = 1),
  ADD COLUMN IF NOT EXISTS previous_receipt_sha256 text NOT NULL CHECK (previous_receipt_sha256 ~ '^sha256:[a-f0-9]{64}$'),
  ADD COLUMN IF NOT EXISTS fence_nonce text NOT NULL CHECK (fence_nonce ~ '^[a-f0-9]{32}$'),
  ADD COLUMN IF NOT EXISTS fence_version integer NOT NULL CHECK (fence_version > 0);
ALTER TABLE reviewrouter_bootstrap.release_generation_activation_receipt OWNER TO reviewrouter_role_bootstrap;
REVOKE ALL ON TABLE reviewrouter_bootstrap.release_generation_activation_receipt FROM PUBLIC;
CREATE OR REPLACE FUNCTION reviewrouter_bootstrap.reject_activation_receipt_mutation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp
AS $immutable_activation_receipt$
BEGIN
  RAISE EXCEPTION 'activation receipt is append-only';
END
$immutable_activation_receipt$;
ALTER FUNCTION reviewrouter_bootstrap.reject_activation_receipt_mutation() OWNER TO reviewrouter_role_bootstrap;
REVOKE ALL ON FUNCTION reviewrouter_bootstrap.reject_activation_receipt_mutation() FROM PUBLIC;
DROP TRIGGER IF EXISTS release_generation_activation_receipt_immutable ON reviewrouter_bootstrap.release_generation_activation_receipt;
CREATE TRIGGER release_generation_activation_receipt_immutable
BEFORE UPDATE OR DELETE ON reviewrouter_bootstrap.release_generation_activation_receipt
FOR EACH ROW EXECUTE FUNCTION reviewrouter_bootstrap.reject_activation_receipt_mutation();
CREATE TABLE IF NOT EXISTS reviewrouter_bootstrap.release_rollout_ledger (
  rollout_id text PRIMARY KEY,
  expected_commit_sha text NOT NULL CHECK (expected_commit_sha ~ '^[a-f0-9]{40}$'),
  run_id text NOT NULL CHECK (run_id ~ '^[1-9][0-9]*$'),
  run_attempt integer NOT NULL CHECK (run_attempt = 1),
  source_system_identifier text NOT NULL CHECK (source_system_identifier ~ '^[0-9]+$'),
  target_system_identifier text NOT NULL CHECK (target_system_identifier ~ '^[0-9]+$'),
  authoritative_system_identifier text NOT NULL,
  activation_boundary text NOT NULL CHECK (activation_boundary IN ('before','activated','uncertain')),
  source_permanently_ineligible boolean NOT NULL DEFAULT false,
  last_receipt_sha256 text NOT NULL CHECK (last_receipt_sha256 ~ '^sha256:[a-f0-9]{64}$'),
  activation_fence_nonce text CHECK (activation_fence_nonce ~ '^[a-f0-9]{32}$'),
  activation_fence_version integer NOT NULL DEFAULT 0 CHECK (activation_fence_version >= 0),
  activation_job_id text CHECK (activation_job_id ~ '^[1-9][0-9]*$'),
  activation_fenced_at timestamptz,
  activation_receipt jsonb,
  claimed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (source_system_identifier <> target_system_identifier),
  CHECK (authoritative_system_identifier IN (source_system_identifier,target_system_identifier)),
  CHECK (NOT source_permanently_ineligible OR authoritative_system_identifier <> source_system_identifier)
);
ALTER TABLE reviewrouter_bootstrap.release_rollout_ledger OWNER TO reviewrouter_role_bootstrap;
ALTER TABLE reviewrouter_bootstrap.release_rollout_ledger
  ADD COLUMN IF NOT EXISTS activation_fence_nonce text CHECK (activation_fence_nonce ~ '^[a-f0-9]{32}$'),
  ADD COLUMN IF NOT EXISTS activation_fence_version integer NOT NULL DEFAULT 0 CHECK (activation_fence_version >= 0),
  ADD COLUMN IF NOT EXISTS activation_job_id text CHECK (activation_job_id ~ '^[1-9][0-9]*$'),
  ADD COLUMN IF NOT EXISTS activation_fenced_at timestamptz,
  ADD COLUMN IF NOT EXISTS activation_receipt jsonb;
REVOKE ALL ON TABLE reviewrouter_bootstrap.release_rollout_ledger FROM PUBLIC;
CREATE TABLE IF NOT EXISTS reviewrouter_bootstrap.release_rollout_receipt_ledger (
  receipt_sha256 text PRIMARY KEY CHECK (receipt_sha256 ~ '^sha256:[a-f0-9]{64}$'),
  rollout_id text NOT NULL REFERENCES reviewrouter_bootstrap.release_rollout_ledger(rollout_id),
  expected_commit_sha text NOT NULL CHECK (expected_commit_sha ~ '^[a-f0-9]{40}$'),
  run_id text NOT NULL CHECK (run_id ~ '^[1-9][0-9]*$'),
  run_attempt integer NOT NULL CHECK (run_attempt = 1),
  source_system_identifier text NOT NULL CHECK (source_system_identifier ~ '^[0-9]+$'),
  target_system_identifier text NOT NULL CHECK (target_system_identifier ~ '^[0-9]+$'),
  step text NOT NULL,
  provider_binding jsonb,
  previous_receipt_sha256 text NOT NULL CHECK (previous_receipt_sha256 ~ '^sha256:[a-f0-9]{64}$'),
  activation_boundary text NOT NULL CHECK (activation_boundary IN ('before','activated')),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (rollout_id, step),
  CHECK (source_system_identifier <> target_system_identifier)
);
ALTER TABLE reviewrouter_bootstrap.release_rollout_receipt_ledger OWNER TO reviewrouter_role_bootstrap;
REVOKE ALL ON TABLE reviewrouter_bootstrap.release_rollout_receipt_ledger FROM PUBLIC;
CREATE TABLE IF NOT EXISTS reviewrouter_bootstrap.release_runner_provisioning_intent (
  intent_id text PRIMARY KEY CHECK (intent_id ~ '^rri-[a-f0-9]{64}$'),
  rollout_id text NOT NULL REFERENCES reviewrouter_bootstrap.release_rollout_ledger(rollout_id),
  service_id text NOT NULL,
  lifecycle text NOT NULL CHECK (lifecycle IN ('role','cutover')),
  workflow_job_id text NOT NULL CHECK (workflow_job_id ~ '^[1-9][0-9]*$'),
  runner_name text NOT NULL,
  created_at timestamptz NOT NULL,
  provider_job_id text,
  outcome text CHECK (outcome IN ('bound','persistence_failed_cleaned','persistence_failed_unknown')),
  reconciliation_observation jsonb,
  reconciled_at timestamptz,
  UNIQUE (rollout_id,lifecycle)
);
ALTER TABLE reviewrouter_bootstrap.release_runner_provisioning_intent OWNER TO reviewrouter_role_bootstrap;
REVOKE ALL ON TABLE reviewrouter_bootstrap.release_runner_provisioning_intent FROM PUBLIC;
CREATE TABLE IF NOT EXISTS reviewrouter_bootstrap.release_runner_job_ledger (
  job_id text PRIMARY KEY,
  rollout_id text NOT NULL REFERENCES reviewrouter_bootstrap.release_rollout_ledger(rollout_id),
  service_id text NOT NULL,
  observed_at timestamptz NOT NULL,
  cleanup_canary text NOT NULL,
  lifecycle text NOT NULL CHECK (lifecycle IN ('role','cutover')),
  provisioning_intent_id text NOT NULL REFERENCES reviewrouter_bootstrap.release_runner_provisioning_intent(intent_id),
  terminal_at timestamptz,
  cleanup_observation jsonb,
  runner_identity jsonb,
  provision_observation jsonb,
  CHECK (terminal_at IS NULL OR terminal_at >= observed_at)
);
ALTER TABLE reviewrouter_bootstrap.release_runner_job_ledger
  ADD COLUMN IF NOT EXISTS cleanup_observation jsonb,
  ADD COLUMN IF NOT EXISTS runner_identity jsonb,
  ADD COLUMN IF NOT EXISTS provision_observation jsonb;
ALTER TABLE reviewrouter_bootstrap.release_runner_job_ledger
  ADD COLUMN IF NOT EXISTS provisioning_intent_id text REFERENCES reviewrouter_bootstrap.release_runner_provisioning_intent(intent_id);
ALTER TABLE reviewrouter_bootstrap.release_runner_job_ledger OWNER TO reviewrouter_role_bootstrap;
REVOKE ALL ON TABLE reviewrouter_bootstrap.release_runner_job_ledger FROM PUBLIC;
DROP FUNCTION IF EXISTS reviewrouter_bootstrap.activate_generation(text,text,text,text);
CREATE OR REPLACE FUNCTION reviewrouter_bootstrap.activate_generation(
  requested_rollout_id text,
  requested_expected_commit_sha text,
  requested_run_id text,
  requested_job_id text,
  requested_run_attempt integer,
  requested_source_system_identifier text,
  requested_target_system_identifier text,
  requested_previous_receipt_sha256 text,
  requested_fence_nonce text,
  requested_fence_version integer,
  requested_canonical_privileges_sha256 text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $activation$
DECLARE observed reviewrouter_bootstrap.release_generation_activation_receipt%ROWTYPE;
DECLARE catalog_facts_sha256 text;
DECLARE first_write_receipt_sha256 text;
DECLARE unexpected_schema text;
BEGIN
  IF session_user <> 'reviewrouter_release_migration'
     OR requested_rollout_id !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{2,255}$'
     OR requested_expected_commit_sha !~ '^[a-f0-9]{40}$'
     OR requested_run_id !~ '^[1-9][0-9]*$'
     OR requested_job_id !~ '^[1-9][0-9]*$'
     OR requested_run_attempt <> 1
     OR requested_source_system_identifier !~ '^[0-9]+$'
     OR requested_target_system_identifier !~ '^[0-9]+$'
     OR requested_source_system_identifier = requested_target_system_identifier
     OR requested_previous_receipt_sha256 !~ '^sha256:[a-f0-9]{64}$'
     OR requested_fence_nonce !~ '^[a-f0-9]{32}$'
     OR requested_fence_version < 1
     OR requested_canonical_privileges_sha256 !~ '^sha256:[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'generation activation receipt invalid';
  END IF;
  PERFORM pg_advisory_xact_lock(1381126735, 1094931534);
  SELECT nspname INTO unexpected_schema FROM pg_namespace
  WHERE nspname NOT IN ('public','reviewrouter_bootstrap','pg_catalog','information_schema')
    AND nspname !~ '^pg_(toast|temp|toast_temp)' ORDER BY nspname LIMIT 1;
  IF unexpected_schema IS NOT NULL THEN
    RAISE EXCEPTION 'unclassified application schema % blocks activation', unexpected_schema;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname = ANY (ARRAY['reviewrouter_api','reviewrouter_web','reviewrouter_worker','reviewrouter_codex_effect_authority'])
      AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)
  ) OR EXISTS (
    SELECT 1 FROM pg_roles runtime
    JOIN pg_class relation ON relation.relowner=runtime.oid
    JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
    WHERE runtime.rolname = ANY (ARRAY['reviewrouter_api','reviewrouter_web','reviewrouter_worker','reviewrouter_codex_effect_authority'])
      AND namespace.nspname='public'
  ) OR has_database_privilege('public', current_database(), 'CONNECT')
     OR has_schema_privilege('public', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'canonical runtime role/ownership/PUBLIC matrix invalid';
  END IF;
  SELECT 'sha256:' || encode(public.digest(convert_to(jsonb_build_object(
    'roles', (SELECT jsonb_agg(jsonb_build_object('role',rolname,'connect',has_database_privilege(rolname,current_database(),'CONNECT'),'bypassRls',rolbypassrls) ORDER BY rolname) FROM pg_roles WHERE rolname=ANY(ARRAY['reviewrouter_api','reviewrouter_web','reviewrouter_worker','reviewrouter_codex_effect_authority'])),
    'schemas', (SELECT jsonb_agg(jsonb_build_object('schema',nspname,'owner',pg_get_userbyid(nspowner),'acl',nspacl) ORDER BY nspname) FROM pg_namespace WHERE nspname IN ('public','reviewrouter_bootstrap')),
    'defaultPrivileges', (SELECT coalesce(jsonb_agg(jsonb_build_object('owner',pg_get_userbyid(defaclrole),'namespace',defaclnamespace,'type',defaclobjtype,'acl',defaclacl) ORDER BY defaclrole,defaclnamespace,defaclobjtype),'[]'::jsonb) FROM pg_default_acl),
    'rls', (SELECT coalesce(jsonb_agg(jsonb_build_object('table',oid::regclass::text,'enabled',relrowsecurity,'forced',relforcerowsecurity) ORDER BY oid::regclass::text),'[]'::jsonb) FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind IN ('r','p'))
  )::text,'UTF8'),'sha256'),'hex') INTO catalog_facts_sha256;
  SELECT * INTO observed
  FROM reviewrouter_bootstrap.release_generation_activation_receipt
  WHERE rollout_id = requested_rollout_id;
  IF FOUND THEN
    RAISE EXCEPTION 'duplicate activation receipt rejected';
  ELSE
    first_write_receipt_sha256 := 'sha256:' || encode(public.digest(convert_to(requested_rollout_id || ':' || requested_expected_commit_sha || ':' || requested_run_id || ':' || requested_job_id || ':' || requested_run_attempt::text || ':' || requested_source_system_identifier || ':' || requested_target_system_identifier || ':' || requested_previous_receipt_sha256 || ':' || requested_fence_nonce || ':' || requested_fence_version::text || ':' || requested_canonical_privileges_sha256 || ':' || catalog_facts_sha256,'UTF8'),'sha256'),'hex');
    INSERT INTO reviewrouter_bootstrap.release_generation_activation_receipt (
      rollout_id, expected_commit_sha, run_id, job_id, run_attempt,
      source_system_identifier, target_system_identifier,
      previous_receipt_sha256, fence_nonce, fence_version,
      canonical_privileges_sha256, catalog_facts_sha256,
      first_write_receipt_sha256, transaction_id
    ) VALUES (
      requested_rollout_id, requested_expected_commit_sha, requested_run_id,
      requested_job_id, requested_run_attempt, requested_source_system_identifier,
      requested_target_system_identifier,
      requested_previous_receipt_sha256, requested_fence_nonce, requested_fence_version,
      requested_canonical_privileges_sha256, catalog_facts_sha256,
      first_write_receipt_sha256, txid_current()
    ) RETURNING * INTO observed;
  END IF;
  RETURN jsonb_build_object(
    'rolloutId', observed.rollout_id,
    'sourceSystemIdentifier', observed.source_system_identifier,
    'targetSystemIdentifier', observed.target_system_identifier,
    'expectedCommitSha', observed.expected_commit_sha,
    'runId', observed.run_id,
    'jobId', observed.job_id,
    'runAttempt', observed.run_attempt,
    'previousReceiptSha256', observed.previous_receipt_sha256,
    'fenceNonce', observed.fence_nonce,
    'fenceVersion', observed.fence_version,
    'canonicalPrivilegesSha256', observed.canonical_privileges_sha256,
    'catalogFactsSha256', observed.catalog_facts_sha256,
    'firstWriteReceiptSha256', observed.first_write_receipt_sha256,
    'transactionId', observed.transaction_id::text,
    'activatedAt', to_char(observed.activated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'firstWriteBoundary', true
  );
END
$activation$;
ALTER FUNCTION reviewrouter_bootstrap.activate_generation(text,text,text,text,integer,text,text,text,text,integer,text) OWNER TO reviewrouter_role_bootstrap;
REVOKE ALL ON FUNCTION reviewrouter_bootstrap.activate_generation(text,text,text,text,integer,text,text,text,text,integer,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reviewrouter_bootstrap.activate_generation(text,text,text,text,integer,text,text,text,text,integer,text) TO reviewrouter_release_migration;
CREATE OR REPLACE FUNCTION reviewrouter_bootstrap.consume_migration_evidence(
  artifact_digest text,
  artifact_id text,
  rollout_id text,
  run_id text,
  run_attempt integer,
  job_id text,
  workflow_path text,
  commit_sha text,
  image_digest text,
  expected_system_identifier text,
  expected_recovery_witness_sha256 text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $receipt$
DECLARE
  binding jsonb;
  receipts jsonb;
  receipt jsonb;
  normalized_receipts jsonb := '[]'::jsonb;
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
     OR image_digest !~ '^sha256:[a-f0-9]{64}$'
     OR expected_system_identifier !~ '^[0-9]+$'
     OR expected_recovery_witness_sha256 !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'trusted migration evidence receipt invalid';
  END IF;
  PERFORM pg_advisory_xact_lock(1381126735, 1129271120);
  SELECT shobj_description(oid, 'pg_database')::jsonb INTO binding
  FROM pg_database WHERE datname = current_database();
  IF binding IS NULL
     OR (SELECT count(*) FROM jsonb_object_keys(binding)) NOT IN (3, 4)
     OR NOT binding ?& ARRAY['version','systemIdentifier','recoveryWitnessSha256']
     OR binding->'version' NOT IN ('1'::jsonb, '2'::jsonb, '3'::jsonb, '4'::jsonb)
     OR jsonb_typeof(binding->'systemIdentifier') <> 'string'
     OR jsonb_typeof(binding->'recoveryWitnessSha256') <> 'string'
     OR (binding ? 'consumedMigrationEvidence' AND jsonb_typeof(binding->'consumedMigrationEvidence') <> 'array')
     OR (NOT binding ? 'consumedMigrationEvidence' AND (SELECT count(*) FROM jsonb_object_keys(binding)) <> 3)
     OR binding->>'systemIdentifier' <> (SELECT system_identifier::text FROM pg_control_system())
     OR binding->>'recoveryWitnessSha256' !~ '^[a-f0-9]{64}$'
     OR binding->>'systemIdentifier' <> expected_system_identifier
     OR binding->>'recoveryWitnessSha256' <> expected_recovery_witness_sha256 THEN
    RAISE EXCEPTION 'trusted migration evidence database generation binding invalid';
  END IF;
  receipts := coalesce(binding->'consumedMigrationEvidence', '[]'::jsonb);
  IF jsonb_typeof(receipts) <> 'array' THEN
    RAISE EXCEPTION 'trusted migration evidence receipt history invalid';
  END IF;
  FOR receipt IN SELECT value FROM jsonb_array_elements(receipts)
  LOOP
    IF jsonb_typeof(receipt) <> 'object' THEN
      RAISE EXCEPTION 'trusted migration evidence receipt history invalid';
    ELSIF (SELECT count(*) FROM jsonb_object_keys(receipt)) = 5
      AND receipt ?& ARRAY['artifactDigest','artifactId','rolloutId','runId','claimedAt']
      AND jsonb_typeof(receipt->'artifactDigest') = 'string'
      AND jsonb_typeof(receipt->'artifactId') = 'string'
      AND jsonb_typeof(receipt->'rolloutId') = 'string'
      AND jsonb_typeof(receipt->'runId') = 'string'
      AND jsonb_typeof(receipt->'claimedAt') = 'string'
      AND receipt->>'artifactDigest' ~ '^sha256:[a-f0-9]{64}$'
      AND receipt->>'artifactId' ~ '^[1-9][0-9]*$'
      AND receipt->>'rolloutId' <> ''
      AND receipt->>'runId' ~ '^[1-9][0-9]*$'
      AND receipt->>'claimedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$'
      AND to_char((receipt->>'claimedAt')::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') = receipt->>'claimedAt' THEN
      receipt := receipt || jsonb_build_object('receiptVersion', 2);
    ELSIF (SELECT count(*) FROM jsonb_object_keys(receipt)) = 6
      AND receipt ?& ARRAY['artifactDigest','artifactId','rolloutId','runId','claimedAt','receiptVersion']
      AND receipt->'receiptVersion' = '2'::jsonb
      AND jsonb_typeof(receipt->'artifactDigest') = 'string'
      AND jsonb_typeof(receipt->'artifactId') = 'string'
      AND jsonb_typeof(receipt->'rolloutId') = 'string'
      AND jsonb_typeof(receipt->'runId') = 'string'
      AND jsonb_typeof(receipt->'claimedAt') = 'string'
      AND receipt->>'artifactDigest' ~ '^sha256:[a-f0-9]{64}$'
      AND receipt->>'artifactId' ~ '^[1-9][0-9]*$'
      AND receipt->>'rolloutId' <> ''
      AND receipt->>'runId' ~ '^[1-9][0-9]*$'
      AND receipt->>'claimedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$'
      AND to_char((receipt->>'claimedAt')::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') = receipt->>'claimedAt' THEN
      NULL;
    ELSIF (SELECT count(*) FROM jsonb_object_keys(receipt)) IN (10, 11)
      AND receipt ?& ARRAY['artifactDigest','artifactId','rolloutId','runId','runAttempt','jobId','workflowPath','commit','imageDigest','claimedAt']
      AND ((SELECT count(*) FROM jsonb_object_keys(receipt)) = 10 OR receipt->'receiptVersion' = '3'::jsonb)
      AND jsonb_typeof(receipt->'artifactDigest') = 'string'
      AND jsonb_typeof(receipt->'artifactId') = 'string'
      AND jsonb_typeof(receipt->'rolloutId') = 'string'
      AND jsonb_typeof(receipt->'runId') = 'string'
      AND jsonb_typeof(receipt->'runAttempt') = 'number'
      AND jsonb_typeof(receipt->'jobId') = 'string'
      AND jsonb_typeof(receipt->'workflowPath') = 'string'
      AND jsonb_typeof(receipt->'commit') = 'string'
      AND jsonb_typeof(receipt->'imageDigest') = 'string'
      AND jsonb_typeof(receipt->'claimedAt') = 'string'
      AND receipt->>'artifactDigest' ~ '^sha256:[a-f0-9]{64}$'
      AND receipt->>'artifactId' ~ '^[1-9][0-9]*$'
      AND receipt->>'rolloutId' <> ''
      AND receipt->>'runId' ~ '^[1-9][0-9]*$'
      AND (receipt->>'runAttempt') ~ '^[1-9][0-9]*$'
      AND receipt->>'jobId' ~ '^[1-9][0-9]*$'
      AND receipt->>'workflowPath' = '.github/workflows/codex-rotating-release-migration.yml'
      AND receipt->>'commit' ~ '^[a-f0-9]{40}$'
      AND receipt->>'imageDigest' ~ '^sha256:[a-f0-9]{64}$'
      AND receipt->>'claimedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$'
      AND to_char((receipt->>'claimedAt')::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') = receipt->>'claimedAt' THEN
      receipt := receipt || jsonb_build_object('receiptVersion', 3);
    ELSIF (SELECT count(*) FROM jsonb_object_keys(receipt)) = 13
      AND receipt ?& ARRAY['artifactDigest','artifactId','rolloutId','runId','runAttempt','jobId','workflowPath','commit','imageDigest','claimedAt','receiptVersion','systemIdentifier','recoveryWitnessSha256']
      AND receipt->'receiptVersion' = '4'::jsonb
      AND jsonb_typeof(receipt->'artifactDigest') = 'string'
      AND jsonb_typeof(receipt->'artifactId') = 'string'
      AND jsonb_typeof(receipt->'rolloutId') = 'string'
      AND jsonb_typeof(receipt->'runId') = 'string'
      AND jsonb_typeof(receipt->'runAttempt') = 'number'
      AND jsonb_typeof(receipt->'jobId') = 'string'
      AND jsonb_typeof(receipt->'workflowPath') = 'string'
      AND jsonb_typeof(receipt->'commit') = 'string'
      AND jsonb_typeof(receipt->'imageDigest') = 'string'
      AND jsonb_typeof(receipt->'claimedAt') = 'string'
      AND jsonb_typeof(receipt->'systemIdentifier') = 'string'
      AND jsonb_typeof(receipt->'recoveryWitnessSha256') = 'string'
      AND receipt->>'artifactDigest' ~ '^sha256:[a-f0-9]{64}$'
      AND receipt->>'artifactId' ~ '^[1-9][0-9]*$'
      AND receipt->>'rolloutId' <> ''
      AND receipt->>'runId' ~ '^[1-9][0-9]*$'
      AND (receipt->>'runAttempt') ~ '^[1-9][0-9]*$'
      AND receipt->>'jobId' ~ '^[1-9][0-9]*$'
      AND receipt->>'workflowPath' = '.github/workflows/codex-rotating-release-migration.yml'
      AND receipt->>'commit' ~ '^[a-f0-9]{40}$'
      AND receipt->>'imageDigest' ~ '^sha256:[a-f0-9]{64}$'
      AND receipt->>'claimedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$'
      AND receipt->>'systemIdentifier' = expected_system_identifier
      AND receipt->>'recoveryWitnessSha256' = expected_recovery_witness_sha256
      AND to_char((receipt->>'claimedAt')::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') = receipt->>'claimedAt' THEN
      NULL;
    ELSE
      RAISE EXCEPTION 'trusted migration evidence receipt history invalid';
    END IF;
    normalized_receipts := normalized_receipts || jsonb_build_array(receipt);
  END LOOP;
  receipts := normalized_receipts;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(receipts) item
    GROUP BY item->>'artifactDigest' HAVING count(*) > 1
  ) OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(receipts) item
    GROUP BY item->>'rolloutId' HAVING count(*) > 1
  ) OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(receipts) item
    GROUP BY item->>'runId', item->>'artifactId' HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'trusted migration evidence receipt history replay invalid';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(receipts) existing_receipt
    WHERE existing_receipt->>'artifactDigest' = artifact_digest
       OR existing_receipt->>'rolloutId' = rollout_id
       OR (existing_receipt->>'runId' = run_id AND existing_receipt->>'artifactId' = artifact_id)
  ) THEN
    RAISE EXCEPTION 'trusted migration evidence replay rejected';
  END IF;
  binding := jsonb_set(binding, '{version}', '4'::jsonb, true);
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
      'receiptVersion', 4,
      'systemIdentifier', expected_system_identifier,
      'recoveryWitnessSha256', expected_recovery_witness_sha256,
      'claimedAt', to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    )),
    true
  );
  EXECUTE format('COMMENT ON DATABASE %I IS %L', current_database(), binding::text);
  RETURN true;
END
$receipt$;
ALTER FUNCTION reviewrouter_bootstrap.consume_migration_evidence(text,text,text,text,integer,text,text,text,text,text,text) OWNER TO reviewrouter_role_bootstrap;
REVOKE ALL ON FUNCTION reviewrouter_bootstrap.consume_migration_evidence(text,text,text,text,integer,text,text,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reviewrouter_bootstrap.consume_migration_evidence(text,text,text,text,integer,text,text,text,text,text,text) TO reviewrouter_release_migration;
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
REVOKE CONNECT ON DATABASE ${databaseTarget} FROM PUBLIC;
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
GRANT EXECUTE ON FUNCTION public.digest(bytea, text) TO reviewrouter_role_bootstrap;
`;
}

export function runtimeAclGateStatements(configuration) {
  return `${configuration.roles
    .map(
      ({ username }) => `REVOKE CONNECT ON DATABASE :"DBNAME" FROM ${username};
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA public FROM ${username};
REVOKE USAGE, UPDATE ON ALL SEQUENCES IN SCHEMA public FROM ${username};`,
    )
    .join("\n")}`;
}

export function runtimeGrantSql(configuration, { gateClosed = false } = {}) {
  return `\\set ON_ERROR_STOP on
BEGIN;
${runtimeGrantStatements(configuration)}
${gateClosed ? runtimeAclGateStatements(configuration) : ""}
COMMIT;
`;
}

export function canonicalActivationSql(configuration, activation) {
  const literal = (value) => `'${String(value).replaceAll("'", "''")}'`;
  const grantDigest = `sha256:${createHash("sha256")
    .update(runtimeGrantStatements(configuration))
    .digest("hex")}`;
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{2,255}$/u.test(activation.rolloutId) ||
    !/^[0-9]+$/u.test(activation.sourceSystemIdentifier) ||
    !/^[0-9]+$/u.test(activation.targetSystemIdentifier) ||
    activation.sourceSystemIdentifier === activation.targetSystemIdentifier ||
    !/^[a-f0-9]{40}$/u.test(activation.expectedCommitSha) ||
    !/^[1-9][0-9]*$/u.test(activation.runId) ||
    !/^[1-9][0-9]*$/u.test(activation.jobId) ||
    activation.runAttempt !== 1 ||
    !/^sha256:[a-f0-9]{64}$/u.test(activation.previousReceiptSha256) ||
    !/^[a-f0-9]{32}$/u.test(activation.fenceNonce) ||
    !Number.isSafeInteger(activation.fenceVersion) ||
    activation.fenceVersion < 1
  )
    throw new Error("release_migration_activation_identity_invalid");
  return {
    canonicalPrivilegesSha256: grantDigest,
    sql: `\\set ON_ERROR_STOP on
BEGIN;
${runtimeGrantStatements(configuration)}
SELECT reviewrouter_bootstrap.activate_generation(
  ${literal(activation.rolloutId)},
  ${literal(activation.expectedCommitSha)},
  ${literal(activation.runId)},
  ${literal(activation.jobId)},
  ${activation.runAttempt},
  ${literal(activation.sourceSystemIdentifier)},
  ${literal(activation.targetSystemIdentifier)},
  ${literal(activation.previousReceiptSha256)},
  ${literal(activation.fenceNonce)},
  ${activation.fenceVersion},
  ${literal(grantDigest)}
);
COMMIT;
`,
  };
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
  if (
    env.REVIEW_ROUTER_RELEASE_ACL_GATE_MODE !== undefined &&
    !["open", "closed"].includes(env.REVIEW_ROUTER_RELEASE_ACL_GATE_MODE)
  )
    throw new Error("release_migration_acl_gate_mode_invalid");
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
      input: runtimeGrantSql(configuration, {
        gateClosed: env.REVIEW_ROUTER_RELEASE_ACL_GATE_MODE === "closed",
      }),
    },
  );
  const verifiedRoles = observeCanonicalRoleTopology(
    run,
    configuration.releaseUrl,
    childEnv,
  );
  const databaseGeneration = observeDatabaseGeneration(
    run,
    configuration.releaseUrl,
    childEnv,
  );
  return {
    version: 3,
    caller: "scripts/run-codex-rotating-release-migration.mjs",
    callerCount: 1,
    commit: configuration.commit,
    databaseIdentity: configuration.databaseIdentity,
    databaseGeneration,
    imageDigest: configuration.imageDigest,
    migrationStatus: "succeeded",
    aclGateState:
      env.REVIEW_ROUTER_RELEASE_ACL_GATE_MODE === "closed" ? "closed" : "open",
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
