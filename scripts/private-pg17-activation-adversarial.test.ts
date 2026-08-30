import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activationAuthorityProvisioningSql,
  atomicMigrationAndGrantSql,
  canonicalActivationSql,
  liveV70V72CatalogDigestSql,
  roleProvisioningSql,
  runtimeGrantSql,
} from "./run-codex-rotating-release-migration.mjs";
import { fencedLiveV70V72CatalogDigestSql } from "../packages/features/release-rollout/src/adapters/live-v70-v72-catalog-digest.mjs";
import { legacyAmbiguityInventorySql } from "./reconcile-codex-rotating-legacy-ambiguity.mjs";
import {
  disposablePg17CanonicalRoleBootstrapSetupSql,
  disposablePg17TargetRoleFoundationSql,
  disposableSqlConfiguration,
  persistRehearsalSourceOwnedReceipt,
} from "./rehearse-private-pg17-rollout.mjs";
import {
  canonicalActivationCatalogPolicies,
  canonicalActivationCatalogPolicyTrustRootReadiness,
} from "../packages/features/release-rollout/src/index.js";
import { sourceLegacyAmbiguityFixture } from "../test/fixtures/source-legacy-ambiguity";

const requiredProof =
  process.env.REVIEW_ROUTER_REQUIRE_PG17_ADVERSARIAL === "1";
const configuredImage = process.env.REVIEW_ROUTER_PG17_ADVERSARIAL_IMAGE ?? "";
const pinnedImage =
  /^postgres:17\.[0-9]+-[a-z0-9.-]+@sha256:[a-f0-9]{64}$/u.test(
    configuredImage,
  );
const docker = (args: readonly string[], input?: string, timeout = 30_000) =>
  spawnSync("docker", [...args], {
    encoding: "utf8",
    input,
    maxBuffer: 16 * 1024 * 1024,
    timeout,
  });

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
if (
  requiredProof &&
  canonicalActivationCatalogPolicyTrustRootReadiness.status !== "ready"
)
  throw new Error("pg17_adversarial_canonical_trust_root_required");

const describePg17 = dockerReady ? describe : describe.skip;
const providerAdminUsername = "disposable_provider_admin";
const adversarialAdminUsername = "disposable_adversarial_admin";
const adminUsername = "reviewrouter_role_bootstrap";
const releaseUsername = "reviewrouter_release_migration";
const installerUsername = "reviewrouter_activation_permit_installer";
const readerUsername = "reviewrouter_activation_receipt_reader";
const databaseName = "review_router";
const applicationRelation = 'public."RepositoryConnection"';
const configuration = disposableSqlConfiguration();
const migrationPermitEligibilityCutoff = "2026-08-12T00:00:02.300Z";
const canonicalReleaseAuthorityRoleFoundationSql = `GRANT reviewrouter_release_schema_owner TO ${adminUsername}
  WITH ADMIN TRUE, INHERIT FALSE, SET TRUE;
UPDATE pg_catalog.pg_authid
SET rolsuper=false, rolcanlogin=false, rolcreatedb=false,
    rolcreaterole=false, rolreplication=false, rolbypassrls=false
WHERE rolname='${providerAdminUsername}';`;
const applyProductionMigrationBaseline = <Result>(
  provisionCanonicalReleaseAuthorityRoles: () => void,
  deployMigrations: () => Result,
) => {
  provisionCanonicalReleaseAuthorityRoles();
  return deployMigrations();
};
type SourceLegacyAmbiguityEvidence = ReturnType<
  typeof sourceLegacyAmbiguityFixture
>;
const migrationPermitEvidenceByRollout = new Map<
  string,
  SourceLegacyAmbiguityEvidence
>();

describe("PG17 production migration baseline fixture ordering", () => {
  it("provisions canonical release authority before deploying migrations", () => {
    const phases: string[] = [];
    const result = applyProductionMigrationBaseline(
      () => phases.push("provision-release-authority"),
      () => {
        phases.push("deploy-migrations");
        return "deployed";
      },
    );

    expect(result).toBe("deployed");
    expect(phases).toEqual([
      "provision-release-authority",
      "deploy-migrations",
    ]);
    const targetRoleFoundation = disposablePg17TargetRoleFoundationSql({
      providerAdminUsername,
      demoteProvider: false,
    });
    const schemaOwnerCreate = "CREATE ROLE reviewrouter_release_schema_owner";
    expect(targetRoleFoundation).toContain(schemaOwnerCreate);
    expect(canonicalReleaseAuthorityRoleFoundationSql).not.toContain(
      schemaOwnerCreate,
    );
    expect(
      `${targetRoleFoundation}\n${canonicalReleaseAuthorityRoleFoundationSql}`.split(
        schemaOwnerCreate,
      ),
    ).toHaveLength(2);
    expect(canonicalReleaseAuthorityRoleFoundationSql).toContain(
      `GRANT reviewrouter_release_schema_owner TO ${adminUsername}`,
    );
    expect(canonicalReleaseAuthorityRoleFoundationSql).toContain(
      "WITH ADMIN TRUE, INHERIT FALSE, SET TRUE",
    );
    expect(canonicalReleaseAuthorityRoleFoundationSql).toContain(
      `WHERE rolname='${providerAdminUsername}'`,
    );
  });

  it("retains 000079 fail-closed rejection for either partial authority topology", () => {
    const migrationSql = readFileSync(
      new URL(
        "../packages/platform/db/prisma/migrations/000079_remove_account_wide_provider_lane_serialization/migration.sql",
        import.meta.url,
      ),
      "utf8",
    );

    expect(migrationSql).toContain(
      "IF schema_owner_exists <> release_migration_exists THEN",
    );
    expect(migrationSql).toContain(
      "provider_scope_concurrency_authority_roles_partial:reviewrouter_release_schema_owner_missing",
    );
    expect(migrationSql).toContain(
      "provider_scope_concurrency_authority_roles_partial:reviewrouter_release_migration_missing",
    );
  });
});

const persistAdditionalSourceOwnedReceipt = (
  context: CaseContext,
  evidence: SourceLegacyAmbiguityEvidence,
) => {
  const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
  context.psqlAs(
    adversarialAdminUsername,
    `INSERT INTO release_authority.source_database_fence (
       fence_id,rollout_id,source_system_identifier,authority_principal,
       before_inventory_sha256,before_policy_sha256,
       fenced_inventory_sha256,fenced_policy_sha256,prior_connect_acl,
       lifecycle,established_at
     ) VALUES (
       ${literal(evidence.fenceId)},${literal(evidence.rolloutId)},
       ${literal(evidence.sourceSystemIdentifier)},
       ${literal(evidence.authorityPrincipal)},
       ${literal(evidence.fencedInventorySha256)},
       ${literal(evidence.fencedInventorySha256)},
       ${literal(evidence.fencedInventorySha256)},
       ${literal(evidence.fencedInventorySha256)},'{}'::jsonb,'active',
       ${literal(evidence.fenceEstablishedAt)}::timestamptz
     );
     INSERT INTO release_authority.source_legacy_ambiguity_receipt (
       rollout_id,fence_id,source_system_identifier,evidence
     ) VALUES (
       ${literal(evidence.rolloutId)},${literal(evidence.fenceId)},
       ${literal(evidence.sourceSystemIdentifier)},
       ${literal(JSON.stringify(evidence))}::jsonb
     );`,
  );
};
const seedSuffix = `${process.pid}-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const seedContainer = `rr-pg17-activation-seed-${seedSuffix}`;
const seedVolume = `rr-pg17-activation-seed-${seedSuffix}`;
let caseOrdinal = 0;

type CommandResult = ReturnType<typeof docker>;

const assertCommand = (result: CommandResult, context: string) => {
  expect(result.status, `${context}\n${result.stderr || result.stdout}`).toBe(
    0,
  );
  return result.stdout.trim();
};

const psqlResultAs = (container: string, role: string, sql: string) => {
  const marker = `rr_identity_${randomUUID().replaceAll("-", "")}`;
  const result = docker(
    [
      "exec",
      "-i",
      container,
      "psql",
      "--username",
      role,
      "--dbname",
      databaseName,
      "--no-psqlrc",
      "--set",
      "ON_ERROR_STOP=1",
      "--tuples-only",
      "--no-align",
    ],
    `SELECT '${marker}|' || session_user || '|' || current_user;\n${sql}`,
  );
  const lines = result.stdout.trim().split("\n");
  expect(lines.shift(), result.stderr).toBe(`${marker}|${role}|${role}`);
  return { ...result, stdout: lines.join("\n").trim() };
};

const psqlAs = (container: string, role: string, sql: string) => {
  const result = psqlResultAs(container, role, sql);
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
};

const waitForPostgres = (container: string, role: string) => {
  let failureReason = "connection_pending";
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const result = docker([
      "exec",
      container,
      "psql",
      "--username",
      role,
      "--dbname",
      databaseName,
      "--no-psqlrc",
      "--tuples-only",
      "--no-align",
      "--command",
      "SELECT 1",
    ]);
    if (result.status === 0 && result.stdout.trim() === "1") return;
    const diagnostic = `${result.stderr}\n${result.stdout}`.toLowerCase();
    failureReason = diagnostic.includes("does not exist")
      ? "role_or_database_missing"
      : diagnostic.includes("is not permitted to log in")
        ? "role_login_disabled"
        : diagnostic.includes("authentication failed")
          ? "authentication_failed"
          : "psql_unready";
    const state = docker([
      "inspect",
      "--format",
      "{{.State.Status}}:{{.State.ExitCode}}",
      container,
    ]);
    if (state.status !== 0) failureReason = "container_unavailable";
    else if (!/^running:0\s*$/u.test(state.stdout))
      failureReason = "container_not_running";
    docker(["exec", container, "sh", "-c", "sleep 1"]);
  }
  throw new Error(`disposable_pg17_not_ready:${container}:${failureReason}`);
};

const removeContainerAndVolume = (container: string, volume: string) => {
  docker(["rm", "--force", container]);
  docker(["volume", "rm", "--force", volume]);
};

const startContainer = (
  container: string,
  volume: string,
  initialize: boolean,
) => {
  const result = docker([
    "run",
    "--detach",
    "--rm",
    "--name",
    container,
    "--publish",
    "127.0.0.1::5432",
    "--volume",
    `${volume}:/var/lib/postgresql/data`,
    ...(initialize
      ? [
          "--env",
          "POSTGRES_PASSWORD=disposable-provider",
          "--env",
          `POSTGRES_USER=${providerAdminUsername}`,
          "--env",
          `POSTGRES_DB=${databaseName}`,
        ]
      : []),
    configuredImage,
  ]);
  assertCommand(result, `start ${container}`);
  waitForPostgres(
    container,
    initialize ? providerAdminUsername : adversarialAdminUsername,
  );
};

const reactivateDisposableAdversarialAdminOffline = (volume: string) => {
  const result = docker(
    [
      "run",
      "--rm",
      "--interactive",
      "--user",
      "postgres",
      "--volume",
      `${volume}:/var/lib/postgresql/data`,
      configuredImage,
      "postgres",
      "--single",
      "-D",
      "/var/lib/postgresql/data",
      "-c",
      "exit_on_error=on",
      "-j",
      databaseName,
    ],
    `ALTER ROLE ${adversarialAdminUsername} LOGIN SUPERUSER CREATEDB CREATEROLE REPLICATION BYPASSRLS;
CHECKPOINT;\n`,
  );
  assertCommand(
    result,
    "offline reactivation of dedicated disposable adversarial administrator",
  );
};

const publishedPort = (container: string) => {
  const value = assertCommand(
    docker(["port", container, "5432/tcp"]),
    `published port ${container}`,
  )
    .split(":")
    .at(-1);
  if (!value || !/^[1-9][0-9]*$/u.test(value))
    throw new Error("pg17_adversarial_published_port_invalid");
  return value;
};

const initializeSeed = () => {
  assertCommand(docker(["volume", "create", seedVolume]), "create seed volume");
  startContainer(seedContainer, seedVolume, true);
  psqlAs(
    seedContainer,
    providerAdminUsername,
    `CREATE ROLE ${adversarialAdminUsername} LOGIN PASSWORD 'disposable-adversarial'
       SUPERUSER CREATEDB CREATEROLE REPLICATION BYPASSRLS;`,
  );
  psqlAs(
    seedContainer,
    providerAdminUsername,
    disposablePg17TargetRoleFoundationSql({
      providerAdminUsername,
      demoteProvider: false,
    }),
  );
  const migration = applyProductionMigrationBaseline(
    () =>
      psqlAs(
        seedContainer,
        providerAdminUsername,
        canonicalReleaseAuthorityRoleFoundationSql,
      ),
    () =>
      spawnSync(
        "pnpm",
        ["--filter", "@reviewrouter/platform-db", "db:migrate:deploy"],
        {
          cwd: new URL("..", import.meta.url),
          encoding: "utf8",
          env: {
            ...process.env,
            DATABASE_URL: `postgresql://${adminUsername}:disposable-bootstrap@127.0.0.1:${publishedPort(seedContainer)}/${databaseName}?sslmode=disable`,
          },
          maxBuffer: 16 * 1024 * 1024,
          timeout: 600_000,
        },
      ),
  );
  expect(
    migration.status,
    `production migration baseline\n${migration.stderr || migration.stdout}`,
  ).toBe(0);
  psqlAs(
    seedContainer,
    adminUsername,
    `DO $bind_disposable_database$
     DECLARE binding jsonb;
     BEGIN
       binding := jsonb_build_object(
         'version',1,
         'systemIdentifier',(SELECT system_identifier::text FROM pg_control_system()),
         'recoveryWitnessSha256','${"c".repeat(64)}'
       );
       EXECUTE format('COMMENT ON DATABASE %I IS %L',current_database(),binding::text);
     END
     $bind_disposable_database$;`,
  );
  const canonicalRoleBootstrapSetup =
    disposablePg17CanonicalRoleBootstrapSetupSql();
  psqlAs(
    seedContainer,
    adminUsername,
    canonicalRoleBootstrapSetup.publicTableAclCanonicalization,
  );
  const rolloutId = "seed-runtime-grant-convergence";
  const inventory = JSON.parse(
    psqlAs(seedContainer, adminUsername, legacyAmbiguityInventorySql),
  );
  const eligibilityCutoff = new Date().toISOString();
  const sourceLegacyAmbiguity = sourceLegacyAmbiguityFixture({
    rolloutId,
    sourceSystemIdentifier: "1",
    firstObservedAt: new Date(
      Date.parse(eligibilityCutoff) - 1_000,
    ).toISOString(),
    eligibilityCutoff,
    inventory,
  });
  persistRehearsalSourceOwnedReceipt(
    (_container: string, sql: string) =>
      psqlAs(seedContainer, adminUsername, sql),
    seedContainer,
    sourceLegacyAmbiguity,
  );
  psqlAs(
    seedContainer,
    adminUsername,
    canonicalRoleBootstrapSetup.activationAuthorityProvisioning,
  );
  // The immutable seed is production-canonical. Individual stopped clones
  // reactivate this dedicated test-only role offline for hostile arrangement.
  psqlAs(
    seedContainer,
    adminUsername,
    `ALTER ROLE ${adversarialAdminUsername}
       NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;`,
  );
  const bootstrapEdgesBeforeConvergence = psqlAs(
    seedContainer,
    adminUsername,
    `SELECT coalesce(jsonb_agg(jsonb_build_object(
       'granted',granted.rolname,'member',member.rolname,
       'grantor',grantor.rolname,'admin',membership.admin_option,
       'inherit',membership.inherit_option,'set',membership.set_option
     ) ORDER BY granted.rolname,member.rolname,grantor.rolname),'[]'::jsonb)
     FROM pg_auth_members membership
     JOIN pg_roles granted ON granted.oid=membership.roleid
     JOIN pg_roles member ON member.oid=membership.member
     JOIN pg_roles grantor ON grantor.oid=membership.grantor
     WHERE member.rolname='${adminUsername}';`,
  );
  expect(
    JSON.parse(bootstrapEdgesBeforeConvergence).filter(
      (edge: { granted: string }) =>
        edge.granted === "reviewrouter_release_schema_owner",
    ),
  ).toEqual([
    {
      admin: true,
      granted: "reviewrouter_release_schema_owner",
      grantor: providerAdminUsername,
      inherit: false,
      member: adminUsername,
      set: true,
    },
  ]);
  psqlAs(
    seedContainer,
    adminUsername,
    roleProvisioningSql(configuration, {
      ownerAuthorizedInitialRuntimeGateClosed: true,
    }),
  );
  expect(
    JSON.parse(
      psqlAs(
        seedContainer,
        adminUsername,
        `SELECT jsonb_object_agg(role.rolname,
           has_function_privilege(
             role.oid,
             'reviewrouter_activation.read_activation_migration_manifest_identity()',
             'EXECUTE'
           ) ORDER BY role.rolname)
         FROM pg_roles role
         WHERE role.rolname IN (
           'reviewrouter_release_schema_owner',
           'reviewrouter_release_migration',
           'reviewrouter_activation_permit_installer',
           'reviewrouter_activation_receipt_reader',
           'reviewrouter_role_bootstrap',
           'reviewrouter_api',
           'reviewrouter_web',
           'reviewrouter_worker',
           'reviewrouter_comment_token_custody',
           'reviewrouter_codex_effect_authority'
         );`,
      ),
    ),
  ).toEqual({
    reviewrouter_activation_permit_installer: true,
    reviewrouter_activation_receipt_reader: true,
    reviewrouter_api: false,
    reviewrouter_comment_token_custody: false,
    reviewrouter_codex_effect_authority: false,
    reviewrouter_release_migration: true,
    reviewrouter_release_schema_owner: false,
    reviewrouter_role_bootstrap: false,
    reviewrouter_web: false,
    reviewrouter_worker: false,
  });
  expect(
    JSON.parse(
      psqlAs(
        seedContainer,
        adminUsername,
        `SELECT jsonb_build_object(
         'unexpectedOwnerCount',(
           SELECT count(*) FROM (
             SELECT relation.relowner AS owner_oid
             FROM pg_class relation
             JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
             WHERE namespace.nspname='public'
               AND relation.relkind IN ('r','p','v','m','S','f')
             UNION ALL
             SELECT routine.proowner
             FROM pg_proc routine
             JOIN pg_namespace namespace ON namespace.oid=routine.pronamespace
             WHERE namespace.nspname='public'
             UNION ALL
             SELECT type.typowner
             FROM pg_type type
             JOIN pg_namespace namespace ON namespace.oid=type.typnamespace
             WHERE namespace.nspname='public'
               AND type.typtype IN ('d','e','m','r')
           ) owned
           WHERE pg_get_userbyid(owner_oid)<>'reviewrouter_release_schema_owner'
         ),
         'relevantDurableEdgeCount',(
           SELECT count(*)
           FROM pg_auth_members membership
           JOIN pg_roles granted ON granted.oid=membership.roleid
           JOIN pg_roles member ON member.oid=membership.member
           JOIN pg_roles grantor ON grantor.oid=membership.grantor
           WHERE granted.rolname='reviewrouter_release_schema_owner'
              OR member.rolname='reviewrouter_release_schema_owner'
              OR grantor.rolname='reviewrouter_release_schema_owner'
         ),
         'providerAuthorityCount',(
           SELECT count(*)
           FROM pg_roles role
           WHERE role.rolname IN (
             '${providerAdminUsername}','${adversarialAdminUsername}'
           ) AND (
             role.rolcanlogin OR role.rolsuper OR role.rolcreatedb
             OR role.rolcreaterole OR role.rolreplication OR role.rolbypassrls
             OR EXISTS (SELECT 1 FROM pg_auth_members membership
               WHERE membership.member=role.oid OR membership.roleid=role.oid)
           )
         ),
         'bootstrapAuthority',(
           SELECT jsonb_build_object(
             'login',role.rolcanlogin,'superuser',role.rolsuper,
             'createDatabase',role.rolcreatedb,'createRole',role.rolcreaterole,
             'replication',role.rolreplication,'bypassRls',role.rolbypassrls
           ) FROM pg_roles role WHERE role.rolname='${adminUsername}'
         ),
         'publicSchemaOwner',(
           SELECT pg_get_userbyid(namespace.nspowner)
           FROM pg_namespace namespace WHERE namespace.nspname='public'
         )
       );`,
      ),
    ),
  ).toEqual({
    bootstrapAuthority: {
      bypassRls: false,
      createDatabase: false,
      createRole: false,
      login: true,
      replication: false,
      superuser: false,
    },
    unexpectedOwnerCount: 0,
    relevantDurableEdgeCount: 0,
    providerAuthorityCount: 0,
    publicSchemaOwner: "reviewrouter_release_schema_owner",
  });
  expect(
    JSON.parse(
      psqlAs(
        seedContainer,
        adminUsername,
        `SELECT coalesce(jsonb_agg(jsonb_build_object(
       'granted',granted.rolname,'member',member.rolname,
       'grantor',grantor.rolname,'admin',membership.admin_option,
       'inherit',membership.inherit_option,'set',membership.set_option
     ) ORDER BY granted.rolname,member.rolname,grantor.rolname),'[]'::jsonb)
     FROM pg_auth_members membership
     JOIN pg_roles granted ON granted.oid=membership.roleid
     JOIN pg_roles member ON member.oid=membership.member
     JOIN pg_roles grantor ON grantor.oid=membership.grantor
     WHERE member.rolname='${adminUsername}';`,
      ),
    ),
  ).toEqual(
    JSON.parse(bootstrapEdgesBeforeConvergence).filter(
      (edge: { granted: string }) =>
        edge.granted !== "reviewrouter_release_schema_owner",
    ),
  );
  expect(
    psqlResultAs(
      seedContainer,
      releaseUsername,
      "SET ROLE reviewrouter_release_schema_owner;",
    ).status,
  ).not.toBe(0);
  const systemIdentifier = psqlAs(
    seedContainer,
    installerUsername,
    "SELECT system_identifier::text FROM pg_catalog.pg_control_system();",
  );
  const migrationChecksum = psqlAs(
    seedContainer,
    installerUsername,
    "SELECT reviewrouter_activation.read_activation_migration_manifest_identity();",
  );
  const expectedPostCatalogDigest = psqlAs(
    seedContainer,
    installerUsername,
    `SET search_path = pg_catalog, pg_temp;
     ${fencedLiveV70V72CatalogDigestSql}`,
  )
    .split("\n")
    .at(-1);
  expect(expectedPostCatalogDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
  const transitionSha256 = `sha256:${"1".repeat(64)}`;
  const previousReceiptSha256 = `sha256:${"2".repeat(64)}`;
  const nonce = "1".padStart(32, "0");
  expect(
    psqlAs(
      seedContainer,
      installerUsername,
      `SELECT reviewrouter_activation.install_migration_permit(
        '${rolloutId}','1','${systemIdentifier}','${"c".repeat(64)}',
        '${transitionSha256}','${previousReceiptSha256}',
        '${migrationChecksum}','${expectedPostCatalogDigest}',
        '${JSON.stringify(sourceLegacyAmbiguity).replaceAll("'", "''")}'::jsonb,
        '${eligibilityCutoff}'::timestamptz,1,'${nonce}');`,
    ),
  ).toBe("t");
  psqlAs(
    seedContainer,
    releaseUsername,
    atomicMigrationAndGrantSql(configuration, {
      gateClosed: true,
      migrationPermit: {
        rolloutId,
        targetSystemIdentifier: systemIdentifier,
        targetRecoveryWitnessSha256: "c".repeat(64),
        transitionSha256,
        previousReceiptSha256,
        sourceLegacyAmbiguity,
        eligibilityCutoff,
        epoch: "1",
        nonce,
      },
      legacyReconciliation: { evidence: sourceLegacyAmbiguity },
    }),
  );
  assertCommand(docker(["stop", seedContainer]), "stop immutable seed");
};

type CaseContext = {
  container: string;
  installPermit: (rolloutId: string, epoch?: number) => void;
  psqlAs: (role: string, sql: string) => string;
  psqlResultAs: (role: string, sql: string) => CommandResult;
  rejectedWithoutReceipt: (rolloutId: string, expectedError?: string) => void;
  systemIdentifier: string;
  migrationChecksum: string;
};

type ArrangeHook = (context: CaseContext) => boolean | void;

const createContext = (container: string): CaseContext => {
  const runAs = (role: string, sql: string) => psqlAs(container, role, sql);
  const runResultAs = (role: string, sql: string) =>
    psqlResultAs(container, role, sql);
  const systemIdentifier = runAs(
    adminUsername,
    "SELECT system_identifier::text FROM pg_catalog.pg_control_system();",
  );
  const migrationChecksum = runAs(
    installerUsername,
    "SELECT reviewrouter_activation.read_activation_migration_manifest_identity();",
  );
  const installPermit = (rolloutId: string, epoch = 1) => {
    const before = JSON.stringify(
      canonicalActivationCatalogPolicies.preactivation.policy,
    ).replaceAll("'", "''");
    const activated = JSON.stringify(
      canonicalActivationCatalogPolicies.activated.policy,
    ).replaceAll("'", "''");
    expect(
      runAs(
        installerUsername,
        `SELECT reviewrouter_activation.install_activation_permit(
          '${rolloutId}','1','${systemIdentifier}',17,'${"b".repeat(40)}',
          '${migrationChecksum}','["dep-disposable"]'::jsonb,${epoch},
          '${epoch.toString(16).padStart(32, "0")}', '${before}'::jsonb,
          '${canonicalActivationCatalogPolicies.preactivation.sha256}',
          '${activated}'::jsonb,
          '${canonicalActivationCatalogPolicies.activated.sha256}'
        );`,
      ),
    ).toContain("t");
  };
  const rejectedWithoutReceipt = (
    rolloutId: string,
    expectedError = "principal evidence invalid or stale",
  ) => {
    const result = runResultAs(
      releaseUsername,
      canonicalActivationSql(configuration, { rolloutId }).sql,
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(expectedError);
    expect(
      runAs(
        readerUsername,
        `SELECT reviewrouter_activation.read_activation_receipt('${rolloutId}') IS NULL;`,
      ),
    ).toBe("t");
  };
  return {
    container,
    installPermit,
    psqlAs: runAs,
    psqlResultAs: runResultAs,
    rejectedWithoutReceipt,
    systemIdentifier,
    migrationChecksum,
  };
};

const lockDownProvider = (
  context: CaseContext,
  { trustedBootstrap = false } = {},
) => {
  context.psqlAs(
    adversarialAdminUsername,
    `BEGIN;
DO $remove_provider_memberships$
DECLARE edge record;
BEGIN
  FOR edge IN
    SELECT granted.rolname AS granted_name, member.rolname AS member_name
    FROM pg_auth_members membership
    JOIN pg_roles granted ON granted.oid=membership.roleid
    JOIN pg_roles member ON member.oid=membership.member
    WHERE granted.rolname='${adversarialAdminUsername}'
       OR member.rolname='${adversarialAdminUsername}'
  LOOP
    EXECUTE format('REVOKE %I FROM %I', edge.granted_name, edge.member_name);
  END LOOP;
END
$remove_provider_memberships$;
ALTER ROLE ${adversarialAdminUsername}
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
COMMIT;`,
  );
  expect(
    context.psqlAs(
      adminUsername,
      `SELECT count(*) = 0
       FROM pg_roles
       WHERE ${trustedBootstrap ? `(rolsuper AND rolname<>'${adminUsername}')` : "rolsuper"}
          OR rolcreatedb OR rolreplication OR rolbypassrls
          OR ${trustedBootstrap ? `(rolname='${adminUsername}' AND (NOT rolcanlogin OR NOT rolsuper OR NOT rolcreaterole))` : "false"}
          OR (rolname IN ('${providerAdminUsername}','${adversarialAdminUsername}') AND
              (rolcanlogin OR rolcreaterole OR EXISTS (
                SELECT 1 FROM pg_auth_members membership
                WHERE membership.member=pg_roles.oid
                   OR membership.roleid=pg_roles.oid)));`,
    ),
  ).toBe("t");
};

const isolatedCase =
  (
    caseName: string,
    body: (context: CaseContext) => void,
    arrange?: ArrangeHook,
  ) =>
  () => {
    caseOrdinal += 1;
    const safeCase = caseName.replaceAll(/[^a-z0-9]+/gu, "-").slice(0, 28);
    const suffix = `${process.pid}-${caseOrdinal}-${safeCase}`;
    const container = `rr-pg17-activation-${suffix}`;
    const volume = `rr-pg17-activation-${suffix}`;
    try {
      assertCommand(docker(["volume", "create", volume]), "create case volume");
      assertCommand(
        docker([
          "run",
          "--rm",
          "--volume",
          `${seedVolume}:/seed:ro`,
          "--volume",
          `${volume}:/case`,
          configuredImage,
          "bash",
          "-ec",
          "cp -a /seed/. /case/",
        ]),
        "clone immutable production-shaped seed",
      );
      reactivateDisposableAdversarialAdminOffline(volume);
      startContainer(container, volume, false);
      const context = createContext(container);
      const trustedBootstrap = arrange?.(context) === true;
      lockDownProvider(context, { trustedBootstrap });
      body(context);
    } finally {
      removeContainerAndVolume(container, volume);
    }
  };

const captureCandidateSql = () =>
  `SET reviewrouter.activation_catalog_candidate_capture = 'disposable-only';
SELECT set_config(
  'reviewrouter.activation_catalog_disposable_database_identity',
  shobj_description(oid,'pg_database')::jsonb
    ->'disposableCaptureAttestation'->>'identity',
  false
) FROM pg_database WHERE datname=current_database();
SELECT reviewrouter_activation.capture_catalog_policy_candidate_pair();`;

const runtimeAclAuthoritySnapshotSql = `SELECT jsonb_build_object(
  'databaseAcl',(SELECT datacl::text FROM pg_database WHERE datname=current_database()),
  'schemas',(SELECT jsonb_agg(jsonb_build_array(namespace.nspname,
    pg_get_userbyid(namespace.nspowner),namespace.nspacl::text)
    ORDER BY namespace.nspname COLLATE "C") FROM pg_namespace namespace
    WHERE namespace.nspname IN ('public','reviewrouter_activation')),
  'objects',(SELECT jsonb_agg(object_fact ORDER BY object_fact COLLATE "C") FROM (
    SELECT 'relation:'||relation.oid::text||':'||pg_get_userbyid(relation.relowner)||':'||
      coalesce(relation.relacl::text,'') AS object_fact
    FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
    WHERE namespace.nspname IN ('public','reviewrouter_activation')
    UNION ALL
    SELECT 'routine:'||routine.oid::text||':'||pg_get_userbyid(routine.proowner)||':'||
      coalesce(routine.proacl::text,'')||':'||coalesce(routine.proconfig::text,'')
    FROM pg_proc routine JOIN pg_namespace namespace ON namespace.oid=routine.pronamespace
    WHERE namespace.nspname IN ('public','reviewrouter_activation')
    UNION ALL
    SELECT 'column:'||attribute.attrelid::text||':'||attribute.attname||':'||
      coalesce(attribute.attacl::text,'')
    FROM pg_attribute attribute
    JOIN pg_class relation ON relation.oid=attribute.attrelid
    JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
    WHERE namespace.nspname IN ('public','reviewrouter_activation')
      AND attribute.attnum>0 AND NOT attribute.attisdropped
  ) facts),
  'defaultAcls',(SELECT coalesce(jsonb_agg(jsonb_build_array(
    defaults.defaclrole::regrole::text,defaults.defaclnamespace::regnamespace::text,
    defaults.defaclobjtype,defaults.defaclacl::text) ORDER BY defaults.oid),'[]'::jsonb)
    FROM pg_default_acl defaults),
  'memberships',(SELECT coalesce(jsonb_agg(jsonb_build_array(
    membership.roleid::regrole::text,membership.member::regrole::text,
    membership.grantor::regrole::text,membership.admin_option,
    membership.inherit_option,membership.set_option)
    ORDER BY membership.roleid,membership.member,membership.grantor),'[]'::jsonb)
    FROM pg_auth_members membership)
)::text;`;

const attestDisposableCaptureSql = () => `
DO $attest_disposable_capture$
DECLARE binding jsonb;
DECLARE live_system_identifier text;
DECLARE live_database_oid text;
DECLARE live_recovery_witness_sha256 text;
DECLARE live_identity text;
BEGIN
  SELECT system_identifier::text INTO STRICT live_system_identifier
  FROM pg_control_system();
  SELECT oid::text,shobj_description(oid,'pg_database')::jsonb
  INTO STRICT live_database_oid,binding
  FROM pg_database WHERE datname=current_database();
  live_recovery_witness_sha256 := encode(pg_catalog.sha256(convert_to(
    'reviewrouter-pg17-adversarial:'||live_system_identifier||':'||
      live_database_oid||':'||current_database(),'UTF8')),'hex');
  live_identity := 'rr-disposable-'||encode(pg_catalog.sha256(convert_to(
    live_system_identifier||':'||live_database_oid||':'||
      live_recovery_witness_sha256,'UTF8')),'hex');
  IF binding IS NULL
     OR binding->>'version' <> '1'
     OR binding->>'systemIdentifier' <> live_system_identifier
     OR binding->>'recoveryWitnessSha256' !~ '^[a-f0-9]{64}$'
     OR binding ? 'disposableCaptureAttestation' THEN
    RAISE EXCEPTION 'disposable capture test attestation precondition failed';
  END IF;
  binding := jsonb_set(
    binding,
    '{recoveryWitnessSha256}',
    to_jsonb(live_recovery_witness_sha256)
  );
  binding := jsonb_set(binding,'{disposableCaptureAttestation}',jsonb_build_object(
    'kind','reviewrouter-disposable-database-attestation-v1',
    'identity',live_identity,
    'systemIdentifier',live_system_identifier,
    'databaseOid',live_database_oid,
    'recoveryWitnessSha256',live_recovery_witness_sha256,
    'nonce',encode(pg_catalog.sha256(convert_to('attestation:'||live_identity,'UTF8')),'hex')
  ));
  EXECUTE format('COMMENT ON DATABASE %I IS %L',current_database(),binding::text);
END
$attest_disposable_capture$;`;

describePg17(
  "isolated production-shaped PG17 activation adversarial proof",
  () => {
    beforeAll(() => {
      try {
        initializeSeed();
      } catch (error) {
        removeContainerAndVolume(seedContainer, seedVolume);
        throw error;
      }
    }, 600_000);

    afterAll(() => {
      removeContainerAndVolume(seedContainer, seedVolume);
    });

    it(
      "removes effective reader and PUBLIC EXECUTE from real PG17 pgcrypto routines",
      isolatedCase("pgcrypto-acl", ({ psqlAs: runAs }) => {
        const observed = JSON.parse(
          runAs(
            adminUsername,
            `SELECT json_build_object(
            'routineNames', coalesce(json_agg(DISTINCT routine.proname), '[]'::json),
            'readerExecuteCount', count(*) FILTER (WHERE has_function_privilege(
              '${readerUsername}', routine.oid, 'EXECUTE')),
            'publicExecuteCount', count(*) FILTER (WHERE EXISTS (
              SELECT 1 FROM aclexplode(coalesce(
                routine.proacl, acldefault('f', routine.proowner))) acl
              WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE')))
          FROM pg_proc routine
          JOIN pg_namespace namespace ON namespace.oid=routine.pronamespace
          JOIN pg_depend dependency ON dependency.classid='pg_proc'::regclass
            AND dependency.objid=routine.oid
            AND dependency.refclassid='pg_extension'::regclass
            AND dependency.deptype='e'
          JOIN pg_extension extension ON extension.oid=dependency.refobjid
          WHERE namespace.nspname='public' AND extension.extname='pgcrypto';`,
          ),
        ) as {
          routineNames: string[];
          readerExecuteCount: number;
          publicExecuteCount: number;
        };
        expect(observed.routineNames).toEqual(
          expect.arrayContaining(["armor", "crypt", "digest"]),
        );
        expect(observed.readerExecuteCount).toBe(0);
        expect(observed.publicExecuteCount).toBe(0);
      }),
      120_000,
    );

    it(
      "captures both policies without leaking owner ACL changes or pgcrypto EXECUTE",
      isolatedCase("runtime-acl-pair", (context) => {
        context.psqlAs(adminUsername, attestDisposableCaptureSql());
        const before = context.psqlAs(
          adminUsername,
          runtimeAclAuthoritySnapshotSql,
        );
        const captureOutput = context.psqlAs(
          releaseUsername,
          `BEGIN; ${captureCandidateSql()} COMMIT;`,
        );
        const captured = JSON.parse(
          captureOutput.split("\n").find((line) => line.startsWith("{")) ??
            "null",
        ) as {
          preactivation: { phase: string };
          activated: { phase: string };
        };
        expect(captured.preactivation.phase).toBe("preactivation");
        expect(captured.activated.phase).toBe("activated");
        expect(
          context.psqlAs(
            adminUsername,
            `SELECT bool_and(NOT has_function_privilege(principal,
              'public.pgp_sym_decrypt(bytea,text)'::regprocedure,'EXECUTE'))
             FROM unnest(ARRAY['public','${releaseUsername}',
               'reviewrouter_activation_receipt_guard']) principal;`,
          ),
        ).toBe("t");
        const decrypt = context.psqlResultAs(
          releaseUsername,
          "SELECT public.pgp_sym_decrypt('\\x00'::bytea,'denied');",
        );
        expect(decrypt.status).not.toBe(0);
        expect(decrypt.stderr).toContain(
          "permission denied for function pgp_sym_decrypt",
        );
        expect(
          context.psqlAs(
            adminUsername,
            `SELECT bool_and(NOT has_function_privilege(principal,routine,'EXECUTE'))
             FROM unnest(ARRAY['${releaseUsername}','reviewrouter_api',
               'reviewrouter_web','reviewrouter_worker',
               'reviewrouter_comment_token_custody',
               'reviewrouter_codex_effect_authority']) principal
             CROSS JOIN unnest(ARRAY[
               'reviewrouter_activation.apply_runtime_database_acl(text)'::regprocedure,
               'reviewrouter_activation.apply_runtime_acl()'::regprocedure,
               'reviewrouter_activation.capture_runtime_acl_policy_pair()'::regprocedure
             ]) routine;`,
          ),
        ).toBe("t");
        for (const invocation of [
          "SELECT reviewrouter_activation.apply_runtime_database_acl('activated');",
          "SELECT reviewrouter_activation.apply_runtime_acl();",
          "SELECT reviewrouter_activation.capture_runtime_acl_policy_pair();",
        ]) {
          expect(
            context.psqlResultAs(releaseUsername, invocation).status,
          ).not.toBe(0);
        }
        expect(
          context.psqlAs(adminUsername, runtimeAclAuthoritySnapshotSql),
        ).toBe(before);
      }),
      120_000,
    );

    it(
      "rolls back catalog capture when a required authority routine is missing",
      isolatedCase(
        "runtime-acl-missing-routine",
        (context) => {
          context.psqlAs(adminUsername, attestDisposableCaptureSql());
          const before = context.psqlAs(
            adminUsername,
            runtimeAclAuthoritySnapshotSql,
          );
          const capture = context.psqlResultAs(
            releaseUsername,
            `BEGIN; ${captureCandidateSql()} COMMIT;`,
          );
          expect(capture.status).not.toBe(0);
          expect(capture.stderr).toContain("does not exist");
          expect(
            context.psqlAs(adminUsername, runtimeAclAuthoritySnapshotSql),
          ).toBe(before);
        },
        ({ psqlAs: runAs }) => {
          runAs(
            adversarialAdminUsername,
            `ALTER FUNCTION public."codex_oauth_database_authority_challenge"(text,text,integer)
               RENAME TO rr_injected_missing_authority_challenge;`,
          );
        },
      ),
      120_000,
    );

    it(
      "rejects an early rollback SQLSTATE collision without leaking ACL changes",
      isolatedCase(
        "runtime-acl-sqlstate-collision",
        (context) => {
          context.psqlAs(adminUsername, attestDisposableCaptureSql());
          const before = context.psqlAs(
            adminUsername,
            runtimeAclAuthoritySnapshotSql,
          );
          const capture = context.psqlResultAs(
            releaseUsername,
            `BEGIN; ${captureCandidateSql()} COMMIT;`,
          );
          expect(capture.status).not.toBe(0);
          expect(capture.stderr).toContain(
            "injected early runtime ACL collision",
          );
          expect(
            context.psqlAs(adminUsername, runtimeAclAuthoritySnapshotSql),
          ).toBe(before);
        },
        ({ psqlAs: runAs }) => {
          runAs(
            adversarialAdminUsername,
            `CREATE OR REPLACE FUNCTION reviewrouter_activation.apply_runtime_acl()
           RETURNS void LANGUAGE plpgsql SECURITY DEFINER
           SET search_path = pg_catalog, pg_temp
           AS $injected_rracl$
           BEGIN
             RAISE EXCEPTION 'injected early runtime ACL collision'
               USING ERRCODE = 'RRACL';
           END
           $injected_rracl$;`,
          );
        },
      ),
      120_000,
    );

    it(
      "rolls back converged owners and every temporary SET edge after a mid-transfer failure",
      isolatedCase(
        "owner-transfer-rollback",
        (context) => {
          const failed = context.psqlResultAs(
            adminUsername,
            roleProvisioningSql(configuration),
          );
          expect(failed.status).not.toBe(0);
          expect(failed.stderr).toContain(
            "injected release owner transfer failure",
          );
          expect(
            JSON.parse(
              context.psqlAs(
                adminUsername,
                `SELECT jsonb_build_object(
                 'relationOwner',pg_get_userbyid((
                   SELECT relowner FROM pg_class
                   WHERE oid='${applicationRelation}'::regclass
                 )),
                 'routineOwner',(
                   SELECT owner.rolname
                   FROM pg_proc routine
                   JOIN pg_namespace namespace ON namespace.oid=routine.pronamespace
                   JOIN pg_roles owner ON owner.oid=routine.proowner
                   WHERE namespace.nspname='public'
                     AND routine.proname='codex_oauth_database_authority_challenge'
                   ORDER BY routine.oid LIMIT 1
                 ),
                 'temporaryEdgeCount',(
                   SELECT count(*)
                   FROM pg_auth_members membership
                   JOIN pg_roles granted ON granted.oid=membership.roleid
                   JOIN pg_roles member ON member.oid=membership.member
                   WHERE (granted.rolname='reviewrouter_release_schema_owner'
                       AND member.rolname='${releaseUsername}') OR
                     (granted.rolname='${releaseUsername}'
                       AND member.rolname='${adminUsername}'
                       AND membership.set_option)
                 )
               );`,
              ),
            ),
          ).toEqual({
            relationOwner: releaseUsername,
            routineOwner: releaseUsername,
            temporaryEdgeCount: 0,
          });
          expect(
            context.psqlResultAs(
              releaseUsername,
              "SET ROLE reviewrouter_release_schema_owner;",
            ).status,
          ).not.toBe(0);
        },
        (context) => {
          context.psqlAs(
            adversarialAdminUsername,
            `ALTER TABLE ${applicationRelation} OWNER TO ${releaseUsername};
             DO $release_owned_routine$
             DECLARE target regprocedure;
             BEGIN
               SELECT routine.oid::regprocedure INTO STRICT target
               FROM pg_proc routine
               JOIN pg_namespace namespace ON namespace.oid=routine.pronamespace
               WHERE namespace.nspname='public'
                 AND routine.proname='codex_oauth_database_authority_challenge'
               ORDER BY routine.oid LIMIT 1;
               EXECUTE format('ALTER ROUTINE %s OWNER TO ${releaseUsername}',target);
             END
             $release_owned_routine$;
             CREATE SCHEMA owner_transfer_failure;
             CREATE FUNCTION owner_transfer_failure.reject_release_routine_transfer()
             RETURNS event_trigger LANGUAGE plpgsql AS $reject$
             BEGIN
               IF current_user='${releaseUsername}'
                  AND tg_tag IN ('ALTER FUNCTION','ALTER PROCEDURE','ALTER ROUTINE') THEN
                 RAISE EXCEPTION 'injected release owner transfer failure';
               END IF;
             END
             $reject$;
             CREATE EVENT TRIGGER reject_release_routine_transfer
               ON ddl_command_start
               EXECUTE FUNCTION owner_transfer_failure.reject_release_routine_transfer();`,
          );
          context.psqlAs(
            adversarialAdminUsername,
            `ALTER ROLE ${adminUsername} SUPERUSER CREATEROLE;`,
          );
          context.psqlAs(adminUsername, activationAuthorityProvisioningSql());
          return true;
        },
      ),
      120_000,
    );

    it(
      "rejects a parallel external schema-owner handoff grantor before provisioning",
      isolatedCase(
        "schema-owner-parallel-grantor",
        (context) => {
          const rejected = context.psqlResultAs(
            adminUsername,
            roleProvisioningSql(configuration),
          );
          expect(rejected.status).not.toBe(0);
          expect(rejected.stderr).toContain(
            "refusing non-canonical role membership topology",
          );
          expect(
            context.psqlAs(
              adminUsername,
              `SELECT count(*) FROM pg_auth_members membership
               JOIN pg_roles granted ON granted.oid=membership.roleid
               JOIN pg_roles member ON member.oid=membership.member
               WHERE granted.rolname='reviewrouter_release_schema_owner'
                 AND member.rolname='${adminUsername}';`,
            ),
          ).toBe("2");
        },
        ({ psqlAs: runAs }) => {
          runAs(
            adversarialAdminUsername,
            `ALTER ROLE ${adminUsername} SUPERUSER CREATEROLE;`,
          );
          runAs(adminUsername, activationAuthorityProvisioningSql());
          runAs(
            adversarialAdminUsername,
            `CREATE ROLE parallel_schema_owner_grantor NOLOGIN NOSUPERUSER
               NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
             GRANT reviewrouter_release_schema_owner
               TO parallel_schema_owner_grantor
               WITH ADMIN TRUE, INHERIT FALSE, SET TRUE;
             SET ROLE parallel_schema_owner_grantor;
             GRANT reviewrouter_release_schema_owner TO ${adminUsername}
               WITH ADMIN TRUE, INHERIT FALSE, SET TRUE;
             RESET ROLE;`,
          );
          return true;
        },
      ),
      120_000,
    );

    it(
      "detects hostile mutations across every V70-V72 catalog evidence class",
      isolatedCase(
        "v70-v72-catalog-drift",
        () => {},
        ({ psqlAs: runAs, psqlResultAs: runResultAs }) => {
          const observeDigest = (
            role: string,
            mutation = "",
            allowFailClosed = false,
          ) => {
            const result = runResultAs(
              role,
              `BEGIN;
             ${mutation}
             ${liveV70V72CatalogDigestSql};
             ROLLBACK;`,
            );
            if (result.status !== 0) {
              expect(allowFailClosed).toBe(true);
              expect(result.stderr).toContain(
                "activation migration manifest read request invalid",
              );
              return null;
            }
            const digests = result.stdout.match(/sha256:[a-f0-9]{64}/gu) ?? [];
            expect(digests).toHaveLength(1);
            return digests[0];
          };

          const canonicalDigest = observeDigest(releaseUsername);
          expect(canonicalDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
          const mutations = [
            [
              adversarialAdminUsername,
              `ALTER TABLE public."RuntimeCanaryChallenge"
               ALTER COLUMN "expiresAt" DROP NOT NULL;`,
            ],
            [
              adversarialAdminUsername,
              `ALTER TABLE public."RuntimeCanaryChallengeProof"
               DROP CONSTRAINT "RuntimeCanaryChallengeProof_nonce_fkey";`,
            ],
            [
              adversarialAdminUsername,
              `ALTER FUNCTION public.reviewrouter_answer_runtime_canary_challenge(
               text,text,text,text,text,text) SECURITY INVOKER
               SET search_path TO public;`,
            ],
            [
              adversarialAdminUsername,
              `GRANT SELECT ON public."RuntimeCanaryChallenge"
               TO reviewrouter_web;
             ALTER DEFAULT PRIVILEGES IN SCHEMA public
               GRANT DELETE ON TABLES TO reviewrouter_web;`,
            ],
            [
              adversarialAdminUsername,
              `GRANT SELECT ("expiresAt") ON public."RuntimeCanaryChallenge"
               TO reviewrouter_web;`,
            ],
            [
              adversarialAdminUsername,
              `GRANT CREATE ON SCHEMA public TO reviewrouter_web;`,
            ],
            [
              adversarialAdminUsername,
              `ALTER TABLE public."RuntimeCanaryChallenge" ENABLE ROW LEVEL SECURITY;
             ALTER TABLE public."RuntimeCanaryChallenge" FORCE ROW LEVEL SECURITY;`,
            ],
            [
              adversarialAdminUsername,
              `ALTER TABLE public."RuntimeCanaryChallenge" REPLICA IDENTITY FULL;`,
            ],
            [
              adversarialAdminUsername,
              `ALTER TABLE public."RuntimeCanaryChallenge"
               ADD COLUMN "identityDrift" bigint GENERATED ALWAYS AS IDENTITY;`,
            ],
            [
              adversarialAdminUsername,
              `ALTER TABLE public."RuntimeCanaryChallenge"
               ALTER COLUMN "rolloutId" TYPE text COLLATE "POSIX";`,
            ],
            [
              adversarialAdminUsername,
              `ALTER TABLE public."RuntimeCanaryChallenge"
               ADD COLUMN "generatedDrift" text GENERATED ALWAYS AS ("rolloutId") STORED;`,
            ],
            [
              adversarialAdminUsername,
              `CREATE INDEX "RuntimeCanaryChallenge_drift_idx"
               ON public."RuntimeCanaryChallenge" ("rolloutId");`,
            ],
          ] as const;
          for (const [role, mutation] of mutations) {
            const observed = observeDigest(role, mutation, true);
            expect(observed === null || observed !== canonicalDigest).toBe(
              true,
            );
          }
          const invalidManifest = runResultAs(
            adversarialAdminUsername,
            `BEGIN;
             UPDATE public._prisma_migrations SET checksum=repeat('0',64)
             WHERE migration_name='000072_runtime_canary_challenge';
             ${liveV70V72CatalogDigestSql};
             ROLLBACK;`,
          );
          expect(invalidManifest.status).not.toBe(0);
          expect(invalidManifest.stderr).toContain(
            "activation migration manifest read request invalid",
          );
          runAs(
            adversarialAdminUsername,
            "CREATE TABLE release_authority.rollout(id bigint);",
          );
          const fencedSchemaMutation = runResultAs(
            installerUsername,
            fencedLiveV70V72CatalogDigestSql,
          );
          if (fencedSchemaMutation.status === 0)
            expect(fencedSchemaMutation.stdout).not.toBe(canonicalDigest);
          else
            expect(fencedSchemaMutation.stderr).toContain(
              "activation migration manifest read request invalid",
            );
          runAs(
            adversarialAdminUsername,
            "DROP TABLE release_authority.rollout;",
          );
        },
      ),
      120_000,
    );

    it(
      "binds one-shot migration permits and closes quarantine and stale-worker races",
      isolatedCase(
        "migration-permit-races",
        (context) => {
          const witness = context.psqlAs(
            installerUsername,
            `SELECT CASE WHEN pg_input_is_valid(
            shobj_description(oid,'pg_database'),'jsonb')
            THEN shobj_description(oid,'pg_database')::jsonb->>'recoveryWitnessSha256'
            ELSE '' END FROM pg_database WHERE datname=current_database();`,
          );
          const transition = `sha256:${"1".repeat(64)}`;
          const previous = `sha256:${"2".repeat(64)}`;
          const observedPostCatalogDigest = context
            .psqlAs(
              installerUsername,
              `SET search_path = pg_catalog, pg_temp;
             ${fencedLiveV70V72CatalogDigestSql}`,
            )
            .split("\n")
            .at(-1);
          expect(observedPostCatalogDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
          const eligibilityCutoff = migrationPermitEligibilityCutoff;
          const evidenceFor = (rolloutId: string) => {
            const evidence = migrationPermitEvidenceByRollout.get(rolloutId);
            if (!evidence)
              throw new Error(
                `migration_permit_source_evidence_missing:${rolloutId}`,
              );
            return JSON.stringify(evidence).replaceAll("'", "''");
          };
          const install = (rolloutId: string, epoch: number) =>
            context.psqlAs(
              installerUsername,
              `SELECT reviewrouter_activation.install_migration_permit(
              '${rolloutId}','1','${context.systemIdentifier}','${witness}',
              '${transition}','${previous}','${context.migrationChecksum}',
              '${observedPostCatalogDigest}','${evidenceFor(rolloutId)}'::jsonb,
              '${eligibilityCutoff}'::timestamptz,${epoch},
              '${epoch.toString(16).padStart(32, "0")}');`,
            );

          expect(install("migration-quarantine", 31)).toBe("t");
          expect(install("migration-quarantine", 31)).toBe("f");
          expect(
            context.psqlResultAs(
              installerUsername,
              `SELECT reviewrouter_activation.install_migration_permit(
              'migration-quarantine','1','${context.systemIdentifier}','${witness}',
              '${transition}','${previous}','${context.migrationChecksum}',
              'sha256:${"9".repeat(64)}','${evidenceFor("migration-quarantine")}'::jsonb,
              '${eligibilityCutoff}'::timestamptz,31,'${"1f".padStart(32, "0")}');`,
            ).status,
          ).not.toBe(0);
          expect(
            context.psqlAs(
              installerUsername,
              `SELECT reviewrouter_activation.terminalize_migration_permit(
              'migration-quarantine',31,'${"1f".padStart(32, "0")}',
              'quarantined');`,
            ),
          ).toBe("t");
          expect(
            context.psqlResultAs(
              releaseUsername,
              `CALL public.reviewrouter_execute_release_migration(
              'migration-quarantine','${context.systemIdentifier}','${witness}',
              '${transition}','${previous}',31,'${"1f".padStart(32, "0")}',
              '${evidenceFor("migration-quarantine")}'::jsonb,
              '${eligibilityCutoff}'::timestamptz,true);`,
            ).stderr,
          ).toContain("release migration target permit unavailable");

          expect(install("migration-completed", 32)).toBe("t");
          const nonce = "20".padStart(32, "0");
          expect(
            context.psqlResultAs(
              releaseUsername,
              `SELECT reviewrouter_activation.consume_migration_permit(
              'migration-completed','${context.systemIdentifier}','${witness}',
              '${transition}','${previous}',
              '${evidenceFor("migration-completed")}'::jsonb,
              '${eligibilityCutoff}'::timestamptz,32,'${nonce}');`,
            ).status,
          ).not.toBe(0);
          expect(
            context.psqlAs(
              adminUsername,
              `SELECT has_function_privilege(
              'reviewrouter_release_migration',
              'reviewrouter_activation.complete_migration_permit(text,bigint,text,jsonb)',
              'EXECUTE');`,
            ),
          ).toBe("f");
          const fabricatedCompletion = context.psqlResultAs(
            releaseUsername,
            `SELECT reviewrouter_activation.complete_migration_permit(
            'migration-completed',32,'${nonce}',jsonb_build_object(
              'legacyReconciliation',jsonb_build_object(
                'status','reconciled',
                'inventorySha256','sha256:${"3".repeat(64)}'),
              'effectFingerprint','sha256:${"4".repeat(64)}',
              'postManifestIdentity','sha256:${"5".repeat(64)}',
              'postCatalogDigest','sha256:${"6".repeat(64)}'));`,
          );
          expect(fabricatedCompletion.status).not.toBe(0);
          expect(fabricatedCompletion.stderr).toContain("permission denied");
          expect(
            context.psqlResultAs(
              releaseUsername,
              "CREATE TABLE public.release_migration_direct_ddl_denied(id integer);",
            ).status,
          ).not.toBe(0);
          expect(
            context.psqlResultAs(
              releaseUsername,
              "SET ROLE reviewrouter_release_schema_owner;",
            ).status,
          ).not.toBe(0);
          expect(
            context.psqlResultAs(
              releaseUsername,
              `GRANT SELECT ON TABLE public."RuntimeCanaryChallenge"
             TO reviewrouter_web;`,
            ).status,
          ).not.toBe(0);
          const databaseName = context.psqlAs(
            adminUsername,
            "SELECT current_database();",
          );
          expect(
            context.psqlResultAs(
              releaseUsername,
              `REVOKE CONNECT ON DATABASE "${databaseName.replaceAll('"', '""')}"
             FROM reviewrouter_web
             GRANTED BY reviewrouter_release_schema_owner;`,
            ).status,
          ).not.toBe(0);
          context.psqlAs(
            releaseUsername,
            `CALL public.reviewrouter_execute_release_migration(
            'migration-completed','${context.systemIdentifier}','${witness}',
            '${transition}','${previous}',32,'${nonce}',
            '${evidenceFor("migration-completed")}'::jsonb,
            '${eligibilityCutoff}'::timestamptz,true);`,
          );
          expect(
            context.psqlResultAs(
              installerUsername,
              `SELECT reviewrouter_activation.terminalize_migration_permit(
              'migration-completed',32,'${nonce}','quarantined');`,
            ).stderr,
          ).toContain("release migration target quarantine conflict");
          expect(
            context.psqlAs(
              releaseUsername,
              `SELECT (reviewrouter_activation.read_migration_receipt(
              'migration-completed',32,'${nonce}')->>'effectFingerprint')
              ~ '^sha256:[a-f0-9]{64}$';`,
            ),
          ).toBe("t");
          expect(
            JSON.parse(
              context.psqlAs(
                releaseUsername,
                `SELECT jsonb_build_object(
                'postManifestIdentity',receipt->>'postManifestIdentity',
                'postCatalogDigest',receipt->>'postCatalogDigest')
               FROM (SELECT reviewrouter_activation.read_migration_receipt(
                 'migration-completed',32,'${nonce}') AS receipt) observed;`,
              ),
            ),
          ).toEqual({
            postManifestIdentity: context.migrationChecksum,
            postCatalogDigest: observedPostCatalogDigest,
          });
          expect(
            context.psqlAs(
              adminUsername,
              `SELECT bool_and(NOT has_database_privilege(
               role_name,current_database(),'CONNECT'))
             FROM unnest(ARRAY['reviewrouter_api','reviewrouter_web',
               'reviewrouter_worker','reviewrouter_comment_token_custody',
               'reviewrouter_codex_effect_authority'])
               AS roles(role_name);`,
            ),
          ).toBe("t");
          expect(
            context.psqlAs(
              adminUsername,
              `SELECT NOT EXISTS (
               SELECT 1
               FROM unnest(ARRAY['reviewrouter_api','reviewrouter_web',
                 'reviewrouter_worker','reviewrouter_comment_token_custody',
                 'reviewrouter_codex_effect_authority'])
                 AS roles(role_name)
               CROSS JOIN pg_class relation
               JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
               CROSS JOIN unnest(ARRAY['INSERT','UPDATE','DELETE','TRUNCATE'])
                 AS privileges(privilege)
               WHERE namespace.nspname='public'
                 AND relation.relkind IN ('r','p','v','m','f')
                 AND has_table_privilege(role_name,relation.oid,privilege));`,
            ),
          ).toBe("t");

          context.psqlAs(
            adminUsername,
            `GRANT CONNECT ON DATABASE "${databaseName.replaceAll('"', '""')}"
           TO reviewrouter_web;`,
          );
          expect(
            context.psqlResultAs(
              releaseUsername,
              `CALL public.reviewrouter_execute_release_migration(
              'migration-completed','${context.systemIdentifier}','${witness}',
              '${transition}','${previous}',32,'${nonce}',
              '${evidenceFor("migration-completed")}'::jsonb,
              '${eligibilityCutoff}'::timestamptz,true);`,
            ).stderr,
          ).toContain(
            "release migration executor replay ACL gate mode conflict",
          );
          expect(
            context.psqlAs(
              adminUsername,
              "SELECT has_database_privilege('reviewrouter_web',current_database(),'CONNECT');",
            ),
          ).toBe("t");

          context.psqlAs(adminUsername, runtimeGrantSql(configuration));
          expect(
            context.psqlAs(
              adminUsername,
              `SELECT bool_and(
                 has_table_privilege(role_name,
                   'public."HostedCodexRuntimeGate"','SELECT')
                 AND NOT has_table_privilege(role_name,
                   'public."HostedCodexRuntimeGate"','INSERT')
                 AND NOT has_table_privilege(role_name,
                   'public."HostedCodexRuntimeGate"','UPDATE')
                 AND NOT has_table_privilege(role_name,
                   'public."HostedCodexRuntimeGate"','DELETE'))
               FROM unnest(ARRAY['reviewrouter_api','reviewrouter_web',
                 'reviewrouter_worker']) AS roles(role_name);`,
            ),
          ).toBe("t");
          const runtimeGateMutation = context.psqlResultAs(
            "reviewrouter_web",
            `UPDATE public."HostedCodexRuntimeGate"
             SET "status"='active',"authzEpoch"="authzEpoch"+1,
                 "revision"="revision"+1,
                 "reasonCode"='runtime_reopen_attempt',
                 "changedAt"="changedAt"+interval '1 second'
             WHERE "id"='global';`,
          );
          expect(runtimeGateMutation.status).not.toBe(0);
          expect(runtimeGateMutation.stderr).toContain("permission denied");
          expect(
            context.psqlAs(
              adminUsername,
              `SELECT "status"::text FROM public."HostedCodexRuntimeGate"
               WHERE "id"='global';`,
            ),
          ).toBe("closed");
          const openCatalogDigest = context
            .psqlAs(installerUsername, fencedLiveV70V72CatalogDigestSql)
            .split("\n")
            .at(-1);
          expect(openCatalogDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
          context.psqlAs(
            adminUsername,
            runtimeGrantSql(configuration, { gateClosed: true }),
          );
          const openNonce = "21".padStart(32, "0");
          expect(
            context.psqlAs(
              installerUsername,
              `SELECT reviewrouter_activation.install_migration_permit(
              'migration-open','1','${context.systemIdentifier}','${witness}',
              '${transition}','${previous}','${context.migrationChecksum}',
              '${openCatalogDigest}','${evidenceFor("migration-open")}'::jsonb,
              '${eligibilityCutoff}'::timestamptz,33,'${openNonce}');`,
            ),
          ).toBe("t");
          const projectedOpenAttempt = context.psqlResultAs(
            releaseUsername,
            `CALL public.reviewrouter_execute_release_migration(
            'migration-open','${context.systemIdentifier}','${witness}',
            '${transition}','${previous}',33,'${openNonce}',
            '${evidenceFor("migration-open")}'::jsonb,
            '${eligibilityCutoff}'::timestamptz,false);`,
          );
          expect(projectedOpenAttempt.status).not.toBe(0);
          expect(projectedOpenAttempt.stderr).toContain(
            "live completion mismatch:catalog_digest_observed",
          );
          expect(
            context.psqlAs(
              adminUsername,
              `SELECT bool_and(NOT has_database_privilege(
               role_name,current_database(),'CONNECT'))
             FROM unnest(ARRAY['reviewrouter_api','reviewrouter_web',
               'reviewrouter_worker','reviewrouter_comment_token_custody',
               'reviewrouter_codex_effect_authority'])
               AS roles(role_name);`,
            ),
          ).toBe("t");
          const absentProjectedReceipt = context.psqlResultAs(
            readerUsername,
            `SELECT reviewrouter_activation.read_migration_receipt(
              'migration-open',33,'${openNonce}');`,
          );
          expect(absentProjectedReceipt.status).not.toBe(0);
          expect(absentProjectedReceipt.stderr).toContain(
            "release migration target receipt unavailable",
          );
        },
        (context) => {
          // This isolated permit-race proof derives both closed and open
          // post-state digests after the first migration. Final bootstrap
          // self-demotion is exercised by the production-readiness cases.
          context.psqlAs(
            adversarialAdminUsername,
            `ALTER ROLE ${adminUsername} SUPERUSER CREATEROLE;`,
          );
          const inventory = JSON.parse(
            context.psqlAs(
              adversarialAdminUsername,
              legacyAmbiguityInventorySql,
            ),
          );
          migrationPermitEvidenceByRollout.clear();
          for (const rolloutId of [
            "migration-quarantine",
            "migration-completed",
            "migration-open",
          ]) {
            const evidence = sourceLegacyAmbiguityFixture({
              rolloutId,
              sourceSystemIdentifier: "1",
              fenceEstablishedAt: "2026-08-12T00:00:02.000Z",
              firstObservedAt: "2026-08-12T00:00:02.100Z",
              eligibilityCutoff: migrationPermitEligibilityCutoff,
              inventory,
            });
            migrationPermitEvidenceByRollout.set(rolloutId, evidence);
            persistAdditionalSourceOwnedReceipt(context, evidence);
          }
          return true;
        },
      ),
      120_000,
    );

    it(
      "keeps forbidden witness writes visible while canonical ACL activation is digest-stable",
      (() => {
        let evidence:
          | {
              baselineDigest: string;
              activatedDigest: string;
              alternativeGrantorBaseline: string;
              alternativeGrantorDigest: string;
              alternativeGrantorEntry: string;
              forbiddenWriteDigest: string;
            }
          | undefined;
        return isolatedCase(
          "fenced-v70-v72-digest",
          () => {
            expect(evidence?.baselineDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
            expect(evidence?.forbiddenWriteDigest).not.toBe(
              evidence?.baselineDigest,
            );
            expect(evidence?.alternativeGrantorEntry).toBe(
              "reviewrouter_api=a/rr_digest_alt_grantor",
            );
            expect(evidence?.alternativeGrantorDigest).not.toBe(
              evidence?.alternativeGrantorBaseline,
            );
            expect(evidence?.activatedDigest).toBe(evidence?.baselineDigest);
          },
          (context) => {
            const baselineDigest = context.psqlAs(
              installerUsername,
              fencedLiveV70V72CatalogDigestSql,
            );
            context.psqlAs(
              adversarialAdminUsername,
              `GRANT INSERT ON TABLE public."RuntimeGenerationWitnessProof"
                 TO reviewrouter_api;`,
            );
            const forbiddenWriteDigest = context.psqlAs(
              installerUsername,
              fencedLiveV70V72CatalogDigestSql,
            );
            context.psqlAs(
              adversarialAdminUsername,
              `REVOKE INSERT ON TABLE public."RuntimeGenerationWitnessProof"
                 FROM reviewrouter_api;
               CREATE ROLE rr_digest_alt_grantor NOLOGIN;
               GRANT INSERT ON TABLE public."HostedCodexCommentRefreshUse"
                 TO rr_digest_alt_grantor WITH GRANT OPTION;`,
            );
            const alternativeGrantorBaseline = context.psqlAs(
              installerUsername,
              fencedLiveV70V72CatalogDigestSql,
            );
            context.psqlAs(
              adversarialAdminUsername,
              `SET ROLE rr_digest_alt_grantor;
               GRANT INSERT ON TABLE public."HostedCodexCommentRefreshUse"
                 TO reviewrouter_api;
               RESET ROLE;`,
            );
            const alternativeGrantorDigest = context.psqlAs(
              installerUsername,
              fencedLiveV70V72CatalogDigestSql,
            );
            const alternativeGrantorEntry = context.psqlAs(
              installerUsername,
              `SELECT acl::text
               FROM pg_class relation
               CROSS JOIN LATERAL unnest(relation.relacl) acl
               WHERE relation.oid='public."HostedCodexCommentRefreshUse"'::regclass
                 AND acl::text='reviewrouter_api=a/rr_digest_alt_grantor';`,
            );
            context.psqlAs(
              adversarialAdminUsername,
              `SET ROLE rr_digest_alt_grantor;
               REVOKE INSERT ON TABLE public."HostedCodexCommentRefreshUse"
                 FROM reviewrouter_api;
               RESET ROLE;
               REVOKE INSERT ON TABLE public."HostedCodexCommentRefreshUse"
                 FROM rr_digest_alt_grantor;
               DROP ROLE rr_digest_alt_grantor;
               GRANT EXECUTE ON FUNCTION reviewrouter_activation.apply_runtime_acl()
                 TO reviewrouter_release_migration;`,
            );
            context.psqlAs(
              releaseUsername,
              "SELECT reviewrouter_activation.apply_runtime_acl();",
            );
            context.psqlAs(
              adversarialAdminUsername,
              `REVOKE EXECUTE ON FUNCTION reviewrouter_activation.apply_runtime_acl()
                 FROM reviewrouter_release_migration;`,
            );
            evidence = {
              alternativeGrantorBaseline,
              alternativeGrantorDigest,
              alternativeGrantorEntry,
              activatedDigest: context.psqlAs(
                installerUsername,
                fencedLiveV70V72CatalogDigestSql,
              ),
              baselineDigest,
              forbiddenWriteDigest,
            };
          },
        );
      })(),
      120_000,
    );

    it(
      "keeps a hostile catalog mutator outside the shared target fence",
      isolatedCase(
        "shared-fence-mutator",
        () => {},
        ({ container }) => {
          const result = docker(
            [
              "exec",
              container,
              "bash",
              "-ec",
              `psql --username ${installerUsername} --dbname ${databaseName} --no-psqlrc --set ON_ERROR_STOP=1 --command "BEGIN; SELECT pg_advisory_xact_lock_shared(1381126735,1129271120); SELECT pg_sleep(1); COMMIT;" >/dev/null &
holder_pid=$!
lock_seen=0
for attempt in $(seq 1 40); do
  if [ "$(psql --username ${adversarialAdminUsername} --dbname ${databaseName} --no-psqlrc --tuples-only --no-align --command "SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype='advisory' AND classid=1381126735 AND objid=1129271120 AND mode='ShareLock' AND granted);")" = "t" ]; then
    lock_seen=1
    break
  fi
  sleep 0.05
done
if [ "$lock_seen" -ne 1 ]; then
  wait "$holder_pid"
  exit 30
fi
if psql --username ${adversarialAdminUsername} --dbname ${databaseName} --no-psqlrc --set ON_ERROR_STOP=1 --command "SET lock_timeout='200ms'; SELECT pg_advisory_xact_lock(1381126735,1129271120);" >/dev/null 2>&1; then
  wait "$holder_pid"
  exit 31
fi
wait "$holder_pid"
psql --username ${adversarialAdminUsername} --dbname ${databaseName} --no-psqlrc --set ON_ERROR_STOP=1 --command "BEGIN; SET LOCAL lock_timeout='1s'; SELECT pg_advisory_xact_lock(1381126735,1129271120); ALTER FUNCTION public.reviewrouter_answer_runtime_canary_challenge(text,text,text,text,text,text) SECURITY INVOKER; ROLLBACK;" >/dev/null
printf 'hostile_mutator_excluded\n'`,
            ],
            undefined,
            10_000,
          );
          expect(result.status, result.stderr).toBe(0);
          expect(result.stdout.trim()).toBe("hostile_mutator_excluded");
        },
      ),
      120_000,
    );

    it(
      "omits a disconnected role only while it has no application authority",
      isolatedCase(
        "disconnected-omission",
        ({ psqlAs: runAs }) => {
          runAs(adminUsername, attestDisposableCaptureSql());
          const captured = runAs(releaseUsername, captureCandidateSql());
          expect(captured).not.toContain(providerAdminUsername);
          expect(captured).not.toContain("another_disconnected_provider_role");
        },
        ({ psqlAs: runAs }) =>
          runAs(
            adversarialAdminUsername,
            "CREATE ROLE another_disconnected_provider_role NOLOGIN;",
          ),
      ),
      120_000,
    );

    it(
      "rejects a disconnected NOLOGIN role with a direct application ACL before trust-root readiness",
      isolatedCase(
        "disconnected-direct-acl",
        ({ container, psqlAs: runAs }) => {
          runAs(adminUsername, attestDisposableCaptureSql());
          const rejected = psqlResultAs(
            container,
            releaseUsername,
            captureCandidateSql(),
          );
          expect(rejected.status).not.toBe(0);
          expect(rejected.stderr).toContain("unexpected_grant_principal");
        },
        ({ psqlAs: runAs }) => {
          runAs(adversarialAdminUsername, "CREATE ROLE rr_inert_acl NOLOGIN;");
          runAs(
            adversarialAdminUsername,
            `GRANT SELECT ON ${applicationRelation} TO rr_inert_acl;`,
          );
        },
      ),
      120_000,
    );

    it(
      "rejects a second bootstrap grantor and an extra relevant edge",
      isolatedCase(
        "grantor-topology",
        ({ psqlAs: runAs, psqlResultAs: runResultAs }) => {
          runAs(adminUsername, attestDisposableCaptureSql());
          const result = runResultAs(releaseUsername, captureCandidateSql());
          expect(result.status).not.toBe(0);
          expect(result.stderr).toContain("candidate safety rejected");
        },
        ({ psqlAs: runAs }) => {
          runAs(
            adversarialAdminUsername,
            `CREATE ROLE second_provider_grantor NOLOGIN;
           CREATE ROLE relevant_edge_target NOLOGIN;
           GRANT reviewrouter_api TO second_provider_grantor
             WITH ADMIN TRUE, INHERIT FALSE, SET TRUE;
           GRANT reviewrouter_api TO reviewrouter_role_bootstrap
             WITH ADMIN TRUE, INHERIT FALSE, SET FALSE
             GRANTED BY second_provider_grantor;
           GRANT relevant_edge_target TO reviewrouter_api
             WITH ADMIN FALSE, INHERIT FALSE, SET FALSE;`,
          );
        },
      ),
      120_000,
    );

    it(
      "rejects durable binding and mismatched database identity before activation proof",
      isolatedCase("closed-capture", ({ psqlAs: runAs, systemIdentifier }) => {
        const binding = JSON.stringify({
          version: 1,
          systemIdentifier,
          recoveryWitnessSha256: "c".repeat(64),
          consumedMigrationEvidence: [
            { commit: "b".repeat(40), systemIdentifier },
          ],
          disposableCaptureAttestation: {
            kind: "reviewrouter-disposable-database-attestation-v1",
            identity: "rr-disposable-mismatched-database",
            systemIdentifier,
            databaseOid: "0",
            recoveryWitnessSha256: "c".repeat(64),
            nonce: "d".repeat(64),
          },
        }).replaceAll("'", "''");
        runAs(
          adminUsername,
          `COMMENT ON DATABASE review_router IS '${binding}';`,
        );
        expect(() =>
          runAs(adminUsername, attestDisposableCaptureSql()),
        ).toThrow("disposable capture test attestation precondition failed");
        expect(() => runAs(releaseUsername, captureCandidateSql())).toThrow();
      }),
      120_000,
    );

    it(
      "accepts the exact clean preactivation catalog projection",
      isolatedCase("exact-clean", ({ installPermit, psqlAs: runAs }) => {
        installPermit("exact-clean-stage");
        expect(
          runAs(
            releaseUsername,
            `BEGIN;
           SELECT reviewrouter_activation.stage_principal_evidence('exact-clean-stage');
           ROLLBACK;`,
          ),
        ).toContain("t");
        expect(
          runAs(
            readerUsername,
            "SELECT reviewrouter_activation.read_activation_receipt('exact-clean-stage') IS NULL;",
          ),
        ).toBe("t");
      }),
      120_000,
    );

    it(
      "applies runtime grants only inside a permit-guarded activation call",
      isolatedCase("permit-guarded-runtime-acl", (context) => {
        const preactivationDigest = context.psqlAs(
          installerUsername,
          fencedLiveV70V72CatalogDigestSql,
        );
        const before = context.psqlAs(
          adminUsername,
          runtimeAclAuthoritySnapshotSql,
        );
        const unpermitted = context.psqlResultAs(
          releaseUsername,
          canonicalActivationSql(configuration, {
            rolloutId: "runtime-acl-without-permit",
          }).sql,
        );
        expect(unpermitted.status).not.toBe(0);
        expect(unpermitted.stderr).toContain("activation permit absent");
        expect(
          context.psqlAs(adminUsername, runtimeAclAuthoritySnapshotSql),
        ).toBe(before);

        context.psqlAs(
          adminUsername,
          `DO $record_consumed_migration$
           DECLARE binding jsonb;
           BEGIN
             SELECT shobj_description(oid,'pg_database')::jsonb INTO STRICT binding
             FROM pg_database WHERE datname=current_database();
             binding := binding || jsonb_build_object(
               'consumedMigrationEvidence',jsonb_build_array(jsonb_build_object(
                 'commit','${"b".repeat(40)}',
                 'systemIdentifier','${context.systemIdentifier}'
               ))
             );
             EXECUTE format(
               'COMMENT ON DATABASE %I IS %L',current_database(),binding::text
             );
           END
           $record_consumed_migration$;`,
        );
        context.installPermit("permit-guarded-runtime-acl");
        const activationOutput = context.psqlAs(
          releaseUsername,
          canonicalActivationSql(configuration, {
            rolloutId: "permit-guarded-runtime-acl",
          }).sql,
        );
        const receipt = JSON.parse(
          activationOutput
            .split("\n")
            .findLast((line) => line.startsWith("{")) ?? "null",
        ) as { firstWriteBoundary: boolean; rolloutId: string };
        expect(receipt.rolloutId).toBe("permit-guarded-runtime-acl");
        expect(receipt.firstWriteBoundary).toBe(true);
        expect(
          context.psqlAs(installerUsername, fencedLiveV70V72CatalogDigestSql),
        ).toBe(preactivationDigest);
        expect(
          context.psqlAs(
            adminUsername,
            `SELECT bool_and(has_database_privilege(role_name,current_database(),'CONNECT'))
             FROM unnest(ARRAY['reviewrouter_api','reviewrouter_web',
               'reviewrouter_worker','reviewrouter_comment_token_custody',
               'reviewrouter_codex_effect_authority']) role_name;`,
          ),
        ).toBe("t");
      }),
      120_000,
    );

    it(
      "rejects an unexpected login with direct CONNECT/table ACL and legacy forged JSON",
      isolatedCase(
        "direct-acl-attack",
        (context) => {
          const legacy = context.psqlResultAs(
            releaseUsername,
            `SELECT reviewrouter_activation.stage_principal_evidence(
          'direct-acl-attack','{}'::jsonb,'{}'::jsonb,'{}'::jsonb,'{}'::jsonb,
          '{}'::jsonb,'sha256:${"0".repeat(64)}','sha256:${"0".repeat(64)}',
          'sha256:${"0".repeat(64)}','sha256:${"0".repeat(64)}');`,
          );
          expect(legacy.status).not.toBe(0);
          context.rejectedWithoutReceipt("direct-acl-attack");
        },
        (context) => {
          context.installPermit("direct-acl-attack");
          context.psqlAs(
            adversarialAdminUsername,
            "CREATE ROLE rr_unexpected_direct LOGIN;",
          );
          context.psqlAs(
            adversarialAdminUsername,
            `GRANT CONNECT ON DATABASE review_router TO rr_unexpected_direct;
         GRANT SELECT ON ${applicationRelation} TO rr_unexpected_direct;`,
          );
        },
      ),
      120_000,
    );

    it(
      "rejects nested INHERIT/SET ROLE privilege reachability",
      isolatedCase(
        "membership-attack",
        (context) => {
          context.rejectedWithoutReceipt("membership-attack");
        },
        (context) => {
          context.installPermit("membership-attack");
          context.psqlAs(
            adversarialAdminUsername,
            `CREATE ROLE rr_attack_parent NOLOGIN;
         CREATE ROLE rr_attack_grandparent NOLOGIN;
         GRANT rr_attack_parent TO reviewrouter_api WITH INHERIT TRUE, SET TRUE;
         GRANT rr_attack_grandparent TO rr_attack_parent WITH INHERIT TRUE, SET TRUE;`,
          );
          context.psqlAs(
            adversarialAdminUsername,
            `GRANT SELECT ON ${applicationRelation} TO rr_attack_grandparent;`,
          );
        },
      ),
      120_000,
    );

    it("rejects PUBLIC and unexpected-owner paths", () => {
      isolatedCase(
        "public-attack",
        (context) => {
          context.rejectedWithoutReceipt("public-attack");
        },
        (context) => {
          context.installPermit("public-attack");
          context.psqlAs(
            adversarialAdminUsername,
            `GRANT SELECT ON ${applicationRelation} TO PUBLIC;`,
          );
        },
      )();
      isolatedCase(
        "owner-attack",
        (context) => context.rejectedWithoutReceipt("ownership-attack"),
        (context) => {
          context.installPermit("ownership-attack");
          context.psqlAs(
            adversarialAdminUsername,
            `CREATE ROLE rr_unexpected_owner LOGIN;
              ALTER TABLE ${applicationRelation} OWNER TO rr_unexpected_owner;`,
          );
        },
      )();
    }, 120_000);

    it("rejects non-login administrative, ACL, and RLS authority", () => {
      isolatedCase(
        "admin-authority",
        (context) => context.rejectedWithoutReceipt("admin-authority"),
        (context) => {
          context.installPermit("admin-authority");
          context.psqlAs(
            adversarialAdminUsername,
            "CREATE ROLE rr_unexpected_admin NOLOGIN CREATEROLE;",
          );
        },
      )();
      isolatedCase(
        "inert-direct-acl",
        (context) => context.rejectedWithoutReceipt("inert-direct-acl"),
        (context) => {
          context.installPermit("inert-direct-acl");
          context.psqlAs(
            adversarialAdminUsername,
            "CREATE ROLE rr_inert_acl NOLOGIN;",
          );
          context.psqlAs(
            adversarialAdminUsername,
            `GRANT SELECT ON ${applicationRelation} TO rr_inert_acl;`,
          );
        },
      )();
      isolatedCase(
        "rls-authority",
        (context) => context.rejectedWithoutReceipt("rls-authority"),
        (context) => {
          context.installPermit("rls-authority");
          context.psqlAs(
            adversarialAdminUsername,
            "CREATE ROLE rr_rls_principal NOLOGIN;",
          );
          context.psqlAs(
            adversarialAdminUsername,
            `ALTER TABLE ${applicationRelation} ENABLE ROW LEVEL SECURITY;
               CREATE POLICY rr_attack_policy ON ${applicationRelation}
                 TO rr_rls_principal USING (true);`,
          );
        },
      )();
    }, 120_000);

    it(
      "rejects an unauthorized direct grant to an approved runtime login",
      isolatedCase(
        "approved-direct-grant",
        (context) => {
          context.rejectedWithoutReceipt(
            "approved-direct-grant",
            "activation catalog policy mismatch",
          );
        },
        (context) => {
          context.installPermit("approved-direct-grant");
          context.psqlAs(
            adversarialAdminUsername,
            `GRANT TRUNCATE ON ${applicationRelation} TO reviewrouter_api;`,
          );
        },
      ),
      120_000,
    );

    it(
      "rejects an approved login owning an unexpected object",
      isolatedCase(
        "approved-owner-drift",
        (context) =>
          context.rejectedWithoutReceipt(
            "approved-owner-drift",
            "activation catalog policy mismatch",
          ),
        (context) => {
          context.installPermit("approved-owner-drift");
          context.psqlAs(
            adversarialAdminUsername,
            `CREATE TABLE public.unexpected_owned_object(id integer);
           ALTER TABLE public.unexpected_owned_object OWNER TO reviewrouter_api;`,
          );
        },
      ),
      120_000,
    );

    it(
      "rejects exact ACL drift in a non-public schema",
      isolatedCase(
        "non-public-schema",
        (context) => {
          context.rejectedWithoutReceipt("non-public-schema-grant");
        },
        (context) => {
          context.installPermit("non-public-schema-grant");
          context.psqlAs(
            adversarialAdminUsername,
            "CREATE SCHEMA private_sensitive;",
          );
          context.psqlAs(
            adversarialAdminUsername,
            "GRANT USAGE ON SCHEMA private_sensitive TO reviewrouter_api;",
          );
        },
      ),
      120_000,
    );

    it(
      "rejects default ACL drift",
      isolatedCase(
        "default-acl-drift",
        (context) => {
          context.rejectedWithoutReceipt(
            "default-acl-drift",
            "activation catalog policy mismatch",
          );
        },
        (context) => {
          context.installPermit("default-acl-drift");
          context.psqlAs(
            adversarialAdminUsername,
            `ALTER DEFAULT PRIVILEGES FOR ROLE reviewrouter_release_schema_owner IN SCHEMA public
         GRANT TRUNCATE ON TABLES TO reviewrouter_api;`,
          );
        },
      ),
      120_000,
    );

    it(
      "rejects a reviewed policy digest mismatch at permit installation",
      isolatedCase("policy-digest-mismatch", (context) => {
        const before = JSON.stringify(
          canonicalActivationCatalogPolicies.preactivation.policy,
        ).replaceAll("'", "''");
        const activated = JSON.stringify(
          canonicalActivationCatalogPolicies.activated.policy,
        ).replaceAll("'", "''");
        const rejected = context.psqlResultAs(
          installerUsername,
          `SELECT reviewrouter_activation.install_activation_permit(
          'policy-digest-mismatch','1','${context.systemIdentifier}',17,
          '${"b".repeat(40)}','${context.migrationChecksum}',
          '["dep-disposable"]'::jsonb,1,'${"1".padStart(32, "0")}',
          '${before}'::jsonb,'sha256:${"0".repeat(64)}',
          '${activated}'::jsonb,'sha256:${"0".repeat(64)}');`,
        );
        expect(rejected.status).not.toBe(0);
        expect(rejected.stderr).toContain("activation permit invalid");
      }),
      120_000,
    );

    it(
      "permanently rejects an old unconsumed permit after a newer epoch exists",
      isolatedCase("permit-supersession", (context) => {
        context.installPermit("old-unconsumed-permit", 1);
        context.installPermit("newer-unconsumed-permit", 2);
        context.rejectedWithoutReceipt(
          "old-unconsumed-permit",
          "activation permit superseded",
        );
      }),
      120_000,
    );

    it(
      "fails closed when recovery encounters caller-attested legacy evidence",
      isolatedCase(
        "legacy-evidence",
        (context) => {
          const rejected = context.psqlResultAs(
            readerUsername,
            "SELECT reviewrouter_activation.read_activation_receipt('legacy-evidence');",
          );
          expect(rejected.status).not.toBe(0);
          expect(rejected.stderr).toContain(
            "activation principal evidence contract invalid",
          );
        },
        (context) => {
          context.installPermit("legacy-evidence");
          const digest = `sha256:${"0".repeat(64)}`;
          context.psqlAs(
            adversarialAdminUsername,
            `INSERT INTO reviewrouter_activation.activation_principal_evidence (
            rollout_id,source_system_identifier,target_system_identifier,postgres_major,
            expected_commit_sha,migration_checksum,target_deploy_ids,permit_epoch,permit_nonce,
            preactivation_catalog_policy,preactivation_catalog_policy_sha256,
            activated_catalog_policy,activated_catalog_policy_sha256,
            before_inventory,before_policy,activated_inventory,activated_policy,
            before_principal_inventory_sha256,before_principal_policy_sha256,
            activated_principal_inventory_sha256,activated_principal_policy_sha256,transaction_id
          ) SELECT
            'legacy-evidence','1','${context.systemIdentifier}',17,'${"b".repeat(40)}',
            '${context.migrationChecksum}','["dep-disposable"]'::jsonb,1,
            '${"1".padStart(32, "0")}',preactivation_catalog_policy,
            preactivation_catalog_policy_sha256,activated_catalog_policy,
            activated_catalog_policy_sha256,
            '{"version":1,"forgedClean":true}'::jsonb,
            '{"version":1,"forgedClean":true}'::jsonb,
            '{"version":1,"forgedClean":true}'::jsonb,
            '{"version":1,"forgedClean":true}'::jsonb,
            '${digest}','${digest}','${digest}','${digest}',1
          FROM reviewrouter_activation.activation_permit
          WHERE rollout_id='legacy-evidence';
          INSERT INTO reviewrouter_activation.activation_receipt (
            rollout_id,source_system_identifier,target_system_identifier,postgres_major,
            expected_commit_sha,migration_checksum,target_deploy_ids,permit_epoch,permit_nonce,
            canonical_privileges_sha256,catalog_facts_sha256,
            preactivation_catalog_policy,preactivation_catalog_policy_sha256,
            activated_catalog_policy,activated_catalog_policy_sha256,
            before_principal_inventory_sha256,before_principal_policy_sha256,
            activated_principal_inventory_sha256,activated_principal_policy_sha256,
            first_write_receipt_sha256,transaction_id
          ) SELECT
            'legacy-evidence','1','${context.systemIdentifier}',17,'${"b".repeat(40)}',
            '${context.migrationChecksum}','["dep-disposable"]'::jsonb,1,
            '${"1".padStart(32, "0")}', '${digest}','${digest}',
            preactivation_catalog_policy,preactivation_catalog_policy_sha256,
            activated_catalog_policy,activated_catalog_policy_sha256,
            '${digest}','${digest}','${digest}','${digest}','${digest}',1
          FROM reviewrouter_activation.activation_permit
          WHERE rollout_id='legacy-evidence';`,
          );
        },
      ),
      120_000,
    );
  },
);
