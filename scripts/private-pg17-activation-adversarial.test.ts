import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
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
} from "./rehearse-private-pg17-rollout.mjs";
import {
  canonicalActivationCatalogPolicies,
  canonicalActivationCatalogPolicyTrustRootReadiness,
} from "../packages/features/release-rollout/src/index.js";

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
    docker(["exec", container, "sh", "-c", "sleep 1"]);
  }
  throw new Error(`disposable_pg17_not_ready:${container}`);
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
    }),
  );
  const migration = spawnSync(
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
  psqlAs(
    seedContainer,
    adminUsername,
    canonicalRoleBootstrapSetup.activationAuthorityProvisioning,
  );
  psqlAs(
    seedContainer,
    adminUsername,
    canonicalRoleBootstrapSetup.bootstrapDemotion,
  );
  psqlAs(seedContainer, adminUsername, roleProvisioningSql(configuration));
  psqlAs(
    seedContainer,
    adminUsername,
    runtimeGrantSql(configuration, { gateClosed: true }),
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

type ArrangeHook = (context: CaseContext) => void;

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

const lockDownProvider = (context: CaseContext) => {
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
       WHERE rolsuper OR rolcreatedb OR rolreplication OR rolbypassrls
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
      startContainer(container, volume, false);
      const context = createContext(container);
      arrange?.(context);
      lockDownProvider(context);
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
SELECT reviewrouter_activation.capture_catalog_policy_candidate('preactivation');`;

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
  live_recovery_witness_sha256 := encode(sha256(convert_to(
    'reviewrouter-pg17-adversarial:'||live_system_identifier||':'||
      live_database_oid||':'||current_database(),'UTF8')),'hex');
  live_identity := 'rr-disposable-'||encode(sha256(convert_to(
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
    'nonce',encode(sha256(convert_to('attestation:'||live_identity,'UTF8')),'hex')
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
      "detects hostile mutations across every V70-V72 catalog evidence class",
      isolatedCase("v70-v72-catalog-drift", ({ psqlAs: runAs }) => {
        const observeDigest = (role: string, mutation = "") => {
          const output = runAs(
            role,
            `BEGIN;
             ${mutation}
             ${liveV70V72CatalogDigestSql};
             ROLLBACK;`,
          );
          const digests = output.match(/sha256:[a-f0-9]{64}/gu) ?? [];
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
          [
            adversarialAdminUsername,
            `UPDATE public._prisma_migrations SET checksum=repeat('0',64)
             WHERE migration_name='000072_runtime_canary_challenge';`,
          ],
        ] as const;
        for (const [role, mutation] of mutations)
          expect(observeDigest(role, mutation)).not.toBe(canonicalDigest);
        runAs(adminUsername, "CREATE SCHEMA release_authority;");
        expect(
          runAs(installerUsername, fencedLiveV70V72CatalogDigestSql),
        ).not.toBe(canonicalDigest);
        runAs(adminUsername, "DROP SCHEMA release_authority;");
      }),
      120_000,
    );

    it(
      "binds one-shot migration permits and closes quarantine and stale-worker races",
      isolatedCase("migration-permit-races", (context) => {
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
        const install = (rolloutId: string, epoch: number) =>
          context.psqlAs(
            installerUsername,
            `SELECT reviewrouter_activation.install_migration_permit(
              '${rolloutId}','1','${context.systemIdentifier}','${witness}',
              '${transition}','${previous}','${context.migrationChecksum}',
              '${observedPostCatalogDigest}',${epoch},
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
              'sha256:${"9".repeat(64)}',31,'${"1f".padStart(32, "0")}');`,
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
              '{"status":"reconciled"}'::jsonb);`,
          ).stderr,
        ).toContain("release migration target permit unavailable");

        expect(install("migration-completed", 32)).toBe("t");
        const nonce = "20".padStart(32, "0");
        expect(
          context.psqlResultAs(
            releaseUsername,
            `SELECT reviewrouter_activation.consume_migration_permit(
              'migration-completed','${context.systemIdentifier}','${witness}',
              '${transition}','${previous}',32,'${nonce}');`,
          ).status,
        ).not.toBe(0);
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
        const inventory = JSON.parse(
          context.psqlAs(releaseUsername, legacyAmbiguityInventorySql),
        );
        const inventorySha256 = `sha256:${createHash("sha256")
          .update(JSON.stringify(inventory))
          .digest("hex")}`;
        const legacyReceipt = JSON.stringify({
          version: 1,
          acknowledgement: "all_prior_installers_and_writers_are_stopped",
          inventory,
          inventorySha256,
          stableSamples: 2,
          status: "reconciled",
        }).replaceAll("'", "''");
        context.psqlAs(
          releaseUsername,
          `CALL public.reviewrouter_execute_release_migration(
            'migration-completed','${context.systemIdentifier}','${witness}',
            '${transition}','${previous}',32,'${nonce}',
            '${legacyReceipt}'::jsonb);`,
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
      }),
      120_000,
    );

    it(
      "recomputes the live V70-V72 digest through the fenced installer connection",
      isolatedCase("fenced-v70-v72-digest", ({ psqlAs: runAs }) => {
        const canonicalDigest = runAs(
          installerUsername,
          fencedLiveV70V72CatalogDigestSql,
        );
        expect(canonicalDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
        runAs(
          adversarialAdminUsername,
          `ALTER FUNCTION public.reviewrouter_answer_runtime_canary_challenge(
             text,text,text,text,text,text) SECURITY INVOKER;`,
        );
        expect(
          runAs(installerUsername, fencedLiveV70V72CatalogDigestSql),
        ).not.toBe(canonicalDigest);
      }),
      120_000,
    );

    it(
      "keeps a hostile catalog mutator outside the shared target fence",
      isolatedCase("shared-fence-mutator", ({ container }) => {
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
      }),
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
          runAs(adminUsername, "CREATE ROLE rr_inert_acl NOLOGIN;");
          runAs(
            adversarialAdminUsername,
            `GRANT SELECT ON ${applicationRelation} TO rr_inert_acl;`,
          );
          runAs(adminUsername, attestDisposableCaptureSql());
          const rejected = psqlResultAs(
            container,
            releaseUsername,
            captureCandidateSql(),
          );
          expect(rejected.status).not.toBe(0);
          expect(rejected.stderr).toContain("unexpected_grant_principal");
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
      "rejects an unexpected login with direct CONNECT/table ACL and legacy forged JSON",
      isolatedCase("direct-acl-attack", (context) => {
        context.installPermit("direct-acl-attack");
        context.psqlAs(
          adminUsername,
          "CREATE ROLE rr_unexpected_direct LOGIN;",
        );
        context.psqlAs(
          adversarialAdminUsername,
          `GRANT CONNECT ON DATABASE review_router TO rr_unexpected_direct;
         GRANT SELECT ON ${applicationRelation} TO rr_unexpected_direct;`,
        );
        const legacy = context.psqlResultAs(
          releaseUsername,
          `SELECT reviewrouter_activation.stage_principal_evidence(
          'direct-acl-attack','{}'::jsonb,'{}'::jsonb,'{}'::jsonb,'{}'::jsonb,
          '{}'::jsonb,'sha256:${"0".repeat(64)}','sha256:${"0".repeat(64)}',
          'sha256:${"0".repeat(64)}','sha256:${"0".repeat(64)}');`,
        );
        expect(legacy.status).not.toBe(0);
        context.rejectedWithoutReceipt("direct-acl-attack");
      }),
      120_000,
    );

    it(
      "rejects nested INHERIT/SET ROLE privilege reachability",
      isolatedCase("membership-attack", (context) => {
        context.installPermit("membership-attack");
        context.psqlAs(
          adminUsername,
          `CREATE ROLE rr_attack_parent NOLOGIN;
         CREATE ROLE rr_attack_grandparent NOLOGIN;
         GRANT rr_attack_parent TO reviewrouter_api WITH INHERIT TRUE, SET TRUE;
         GRANT rr_attack_grandparent TO rr_attack_parent WITH INHERIT TRUE, SET TRUE;`,
        );
        context.psqlAs(
          adversarialAdminUsername,
          `GRANT SELECT ON ${applicationRelation} TO rr_attack_grandparent;`,
        );
        context.rejectedWithoutReceipt("membership-attack");
      }),
      120_000,
    );

    it("rejects PUBLIC and unexpected-owner paths", () => {
      isolatedCase("public-attack", (context) => {
        context.installPermit("public-attack");
        context.psqlAs(
          adversarialAdminUsername,
          `GRANT SELECT ON ${applicationRelation} TO PUBLIC;`,
        );
        context.rejectedWithoutReceipt("public-attack");
      })();
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

    it(
      "rejects non-login administrative, ACL, and RLS authority",
      isolatedCase("admin-acl-rls", (context) => {
        context.installPermit("admin-acl-rls");
        context.psqlAs(
          adminUsername,
          "CREATE ROLE rr_unexpected_admin NOLOGIN CREATEROLE;",
        );
        context.rejectedWithoutReceipt("admin-acl-rls");
        context.psqlAs(adminUsername, "DROP ROLE rr_unexpected_admin;");

        context.psqlAs(adminUsername, "CREATE ROLE rr_inert_acl NOLOGIN;");
        context.psqlAs(
          adversarialAdminUsername,
          `GRANT SELECT ON ${applicationRelation} TO rr_inert_acl;`,
        );
        context.rejectedWithoutReceipt("admin-acl-rls");
        context.psqlAs(
          adversarialAdminUsername,
          `REVOKE SELECT ON ${applicationRelation} FROM rr_inert_acl;`,
        );
        context.psqlAs(adminUsername, "DROP ROLE rr_inert_acl;");

        context.psqlAs(adminUsername, "CREATE ROLE rr_rls_principal NOLOGIN;");
        context.psqlAs(
          adversarialAdminUsername,
          `ALTER TABLE ${applicationRelation} ENABLE ROW LEVEL SECURITY;
           CREATE POLICY rr_attack_policy ON ${applicationRelation}
             TO rr_rls_principal USING (true);`,
        );
        context.rejectedWithoutReceipt("admin-acl-rls");
      }),
      120_000,
    );

    it(
      "rejects an unauthorized direct grant to an approved runtime login",
      isolatedCase("approved-direct-grant", (context) => {
        context.installPermit("approved-direct-grant");
        context.psqlAs(
          adversarialAdminUsername,
          `GRANT TRUNCATE ON ${applicationRelation} TO reviewrouter_api;`,
        );
        context.rejectedWithoutReceipt(
          "approved-direct-grant",
          "activation catalog policy mismatch",
        );
      }),
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
      isolatedCase("non-public-schema", (context) => {
        context.installPermit("non-public-schema-grant");
        context.psqlAs(
          adversarialAdminUsername,
          "CREATE SCHEMA private_sensitive;",
        );
        context.psqlAs(
          adversarialAdminUsername,
          "GRANT USAGE ON SCHEMA private_sensitive TO reviewrouter_api;",
        );
        context.rejectedWithoutReceipt(
          "non-public-schema-grant",
          "activation catalog policy mismatch",
        );
      }),
      120_000,
    );

    it(
      "rejects default ACL drift",
      isolatedCase("default-acl-drift", (context) => {
        context.installPermit("default-acl-drift");
        context.psqlAs(
          adversarialAdminUsername,
          `ALTER DEFAULT PRIVILEGES FOR ROLE reviewrouter_release_schema_owner IN SCHEMA public
         GRANT TRUNCATE ON TABLES TO reviewrouter_api;`,
        );
        context.rejectedWithoutReceipt(
          "default-acl-drift",
          "activation catalog policy mismatch",
        );
      }),
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
