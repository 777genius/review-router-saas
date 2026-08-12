#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  assembleTrustedRolloutEvidence,
  assertPromotionAllowed,
  beginCompensation,
  completeCompensation,
  createReleaseRollout,
  ReleaseRolloutUseCases,
  AuthenticatedRunnerLedgerAdapter,
  HttpProviderAuthorityDecisionAdapter,
  RolloutStep,
  sha256Canonical,
  transitionFailure,
} from "../packages/features/release-rollout/src/index.ts";
import { createPrismaClient } from "../packages/platform/db/src/index.ts";
import { createReleaseControlApp } from "../apps/api/src/release-control-composition.ts";
import {
  canonicalActivationSql,
  executeCanonicalReleaseMigration,
  executeCanonicalRoleBootstrap,
  activationAuthorityProvisioningSql,
  roleProvisioningSql,
  runtimeGrantSql,
} from "./run-codex-rotating-release-migration.mjs";
import { executePrivateGenerationActivation } from "./activate-private-pg17-generation.mjs";
import { createSecureCanonicalRun } from "./private-pg17-secure-canonical.ts";

const imagePattern =
  /^postgres:(16\.13|17(?:\.[0-9]+)?)-bookworm@sha256:[a-f0-9]{64}$/u;

export function validateRehearsalConfiguration(env) {
  if (env.REVIEW_ROUTER_PRIVATE_PG17_REHEARSAL !== "1")
    throw new Error("private_pg17_rehearsal_explicit_opt_in_required");
  const sourceImage = env.REVIEW_ROUTER_REHEARSAL_PG16_IMAGE;
  const targetImage = env.REVIEW_ROUTER_REHEARSAL_PG17_IMAGE;
  if (
    !imagePattern.test(sourceImage ?? "") ||
    !imagePattern.test(targetImage ?? "")
  )
    throw new Error("private_pg17_rehearsal_immutable_images_required");
  if (
    !sourceImage.startsWith("postgres:16.13-") ||
    !targetImage.startsWith("postgres:17")
  )
    throw new Error("private_pg17_rehearsal_versions_invalid");
  return Object.freeze({ sourceImage, targetImage });
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

const disposableSqlConfiguration = () => ({
  roles: [
    { role: "api", username: "reviewrouter_api", password: "disposable-api" },
    { role: "web", username: "reviewrouter_web", password: "disposable-web" },
    {
      role: "worker",
      username: "reviewrouter_worker",
      password: "disposable-worker",
    },
    {
      role: "effect-authority",
      username: "reviewrouter_codex_effect_authority",
      password: "disposable-effect",
    },
  ],
  releasePassword: "disposable-release",
});

export async function executeDisposableRehearsal(
  env = process.env,
  execute = (args, options = {}) => {
    const result = spawnSync("docker", args, {
      encoding: options.encoding ?? "utf8",
      input: options.input,
      maxBuffer: 32 * 1024 * 1024,
    });
    if (result.status !== 0) {
      const diagnostic = String(result.stderr ?? "")
        .replace(/PASSWORD\s+'[^']*'/giu, "PASSWORD '[redacted]'")
        .replace(/postgres(?:ql)?:\/\/[^\s]+/giu, "[redacted-database-url]")
        .slice(0, 2_000)
        .trim();
      throw new Error(
        `private_pg17_rehearsal_docker_failed:${args[0]}${diagnostic ? `:${diagnostic}` : ""}`,
      );
    }
    return result.stdout;
  },
) {
  const images = validateRehearsalConfiguration(env);
  const suffix = randomBytes(6).toString("hex");
  const source = `rr-pg16-${suffix}`;
  const target = `rr-pg17-${suffix}`;
  const authority = `rr-authority-pg17-${suffix}`;
  const network = `rr-pg-cutover-${suffix}`;
  const directory = mkdtempSync(join(tmpdir(), "reviewrouter-pg17-rehearsal-"));
  const dumpPath = join(directory, "source.dump");
  const password = "disposable-reviewrouter-only";
  const postgresEnvFile = join(directory, "postgres.env");
  writeFileSync(
    postgresEnvFile,
    `POSTGRES_PASSWORD=${password}\nPOSTGRES_DB=reviewrouter\n`,
    { mode: 0o600, flag: "wx" },
  );
  let networkCreated = false;
  let releaseControl;
  let controlPrisma;
  let providerAuthorityPrisma;
  let permitInstallerPrisma;
  let targetReceiptReaderPrisma;
  const createdContainers = [];
  const docker = (...args) => execute(args);
  const sql = (container, statement) =>
    docker(
      "exec",
      container,
      "psql",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "postgres",
      "-d",
      "reviewrouter",
      "-Atqc",
      statement,
    ).trim();
  try {
    docker("network", "create", network);
    networkCreated = true;
    for (const [name, image] of [
      [source, images.sourceImage],
      [target, images.targetImage],
      [authority, images.targetImage],
    ]) {
      docker(
        "run",
        "--detach",
        "--name",
        name,
        "--network",
        network,
        "--network-alias",
        name,
        "--publish",
        "127.0.0.1::5432",
        "--env-file",
        postgresEnvFile,
        image,
      );
      createdContainers.push(name);
    }
    for (const name of [source, target, authority]) {
      let ready = false;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        try {
          docker(
            "exec",
            name,
            "pg_isready",
            "-U",
            "postgres",
            "-d",
            "reviewrouter",
          );
          ready = true;
          break;
        } catch {
          docker("exec", name, "sh", "-c", "sleep 1");
        }
      }
      if (!ready) throw new Error("private_pg17_rehearsal_database_timeout");
    }
    if (
      !sql(source, "SHOW server_version_num").startsWith("160") ||
      !sql(target, "SHOW server_version_num").startsWith("170") ||
      !sql(authority, "SHOW server_version_num").startsWith("170")
    )
      throw new Error("private_pg17_rehearsal_server_version_mismatch");
    const publishedPort = (container) => {
      const port = docker("port", container, "5432/tcp")
        .trim()
        .split(":")
        .at(-1);
      if (!port || !/^[1-9][0-9]*$/u.test(port))
        throw new Error("private_pg17_rehearsal_published_port_invalid");
      return port;
    };
    const sourcePort = publishedPort(source);
    const targetPort = publishedPort(target);
    const authorityPort = publishedPort(authority);
    sql(
      authority,
      "CREATE EXTENSION IF NOT EXISTS pgcrypto; CREATE ROLE reviewrouter_release_control LOGIN PASSWORD 'disposable-control'; CREATE ROLE reviewrouter_provider_authority LOGIN PASSWORD 'disposable-provider'",
    );
    execute(
      [
        "exec",
        "--interactive",
        authority,
        "psql",
        "-U",
        "postgres",
        "-d",
        "reviewrouter",
      ],
      {
        input: readFileSync(
          join(
            process.cwd(),
            "packages/platform/release-authority-db/migrations/000001_release_authority/migration.sql",
          ),
          "utf8",
        ),
      },
    );
    const preReleasePrisma = join(directory, "pre-release-prisma");
    cpSync(
      join(process.cwd(), "packages/platform/db/prisma"),
      preReleasePrisma,
      {
        recursive: true,
      },
    );
    for (const migration of [
      "000060_codex_oauth_setup_serialization",
      "000061_codex_oauth_provider_mutation_fence",
      "000062_codex_oauth_remote_outcome_unknown",
      "000063_codex_oauth_setup_payload_claim",
      "000064_codex_oauth_versioned_secret_namespaces",
      "000065_codex_oauth_authority_acl_hardening",
      "000066_codex_oauth_rotating_cascade_authority",
      "000067_release_rollout_ledger",
    ])
      rmSync(join(preReleasePrisma, "migrations", migration), {
        recursive: true,
      });
    const preReleasePrismaConfig = join(directory, "prisma.config.mjs");
    const sourceDatabaseCredential = join(directory, "source-database-url");
    writeFileSync(
      sourceDatabaseCredential,
      `postgresql://postgres:${password}@127.0.0.1:${sourcePort}/reviewrouter?sslmode=disable`,
      { mode: 0o600, flag: "wx" },
    );
    writeFileSync(
      preReleasePrismaConfig,
      `import { readFileSync } from "node:fs"; export default { schema: ${JSON.stringify(join(preReleasePrisma, "schema.prisma"))}, migrations: { path: ${JSON.stringify(join(preReleasePrisma, "migrations"))} }, datasource: { url: readFileSync(process.env.REVIEW_ROUTER_DATABASE_URL_FILE, "utf8").trim() } };\n`,
      { mode: 0o600 },
    );
    const sourceMigration = spawnSync(
      "pnpm",
      [
        "--filter",
        "@reviewrouter/platform-db",
        "exec",
        "prisma",
        "migrate",
        "deploy",
        "--config",
        preReleasePrismaConfig,
      ],
      {
        cwd: new URL("..", import.meta.url),
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          LANG: "C.UTF-8",
          REVIEW_ROUTER_DATABASE_URL_FILE: sourceDatabaseCredential,
        },
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    if (sourceMigration.status !== 0) {
      const diagnostic = String(sourceMigration.stderr ?? "")
        .replace(/PASSWORD\s+'[^']*'/giu, "PASSWORD '[redacted]'")
        .replace(/postgres(?:ql)?:\/\/[^\s]+/giu, "[redacted-database-url]")
        .replaceAll(password, "[redacted]")
        .slice(0, 2_000)
        .trim();
      throw new Error(
        `private_pg17_rehearsal_source_migration_failed:exit=${sourceMigration.status ?? "signal"}${diagnostic ? `:${diagnostic}` : ""}`,
      );
    }
    sql(
      source,
      `COMMENT ON DATABASE reviewrouter IS '{"recoveryWitnessSha256":"${"a".repeat(64)}"}'; CREATE ROLE rehearsal_writer LOGIN; GRANT CONNECT ON DATABASE reviewrouter TO rehearsal_writer; CREATE TABLE rehearsal_items(id bigserial PRIMARY KEY, value text NOT NULL UNIQUE); INSERT INTO rehearsal_items(value) VALUES ('one'),('two'),('three'); CREATE SCHEMA app_private; CREATE TABLE app_private.rehearsal_private(id integer PRIMARY KEY, value text); INSERT INTO app_private.rehearsal_private VALUES (1,'private'); CREATE SEQUENCE app_private.called_sequence; SELECT nextval('app_private.called_sequence'); CREATE SEQUENCE app_private.uncalled_sequence;`,
    );
    sql(
      target,
      `COMMENT ON DATABASE reviewrouter IS '{"recoveryWitnessSha256":"${"c".repeat(64)}"}'`,
    );
    const dump = execute(
      [
        "exec",
        source,
        "pg_dump",
        "-U",
        "postgres",
        "-d",
        "reviewrouter",
        "--format=custom",
        "--no-owner",
        "--no-privileges",
      ],
      { encoding: "buffer" },
    );
    writeFileSync(dumpPath, dump);
    sql(
      source,
      "BEGIN; REVOKE CONNECT ON DATABASE reviewrouter FROM PUBLIC; REVOKE CONNECT ON DATABASE reviewrouter FROM rehearsal_writer; COMMIT; SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid();",
    );
    const zeroSeries = [0, 1, 2].map(() =>
      Number(
        sql(
          source,
          "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()",
        ),
      ),
    );
    if (zeroSeries.some((value) => value !== 0))
      throw new Error("private_pg17_rehearsal_session_stabilization_failed");
    let reconnectDenied = false;
    try {
      docker(
        "exec",
        source,
        "psql",
        "-U",
        "rehearsal_writer",
        "-d",
        "reviewrouter",
        "-Atqc",
        "SELECT 1",
      );
    } catch {
      reconnectDenied = true;
    }
    if (!reconnectDenied)
      throw new Error("private_pg17_rehearsal_reconnect_denial_failed");
    // Exercise the reversible side before activation, then quiesce again.
    sql(source, "GRANT CONNECT ON DATABASE reviewrouter TO rehearsal_writer");
    docker(
      "exec",
      source,
      "psql",
      "-U",
      "rehearsal_writer",
      "-d",
      "reviewrouter",
      "-Atqc",
      "SELECT 1",
    );
    sql(
      source,
      "REVOKE CONNECT ON DATABASE reviewrouter FROM rehearsal_writer",
    );
    docker("cp", dumpPath, `${target}:/tmp/source.dump`);
    docker(
      "exec",
      target,
      "pg_restore",
      "-U",
      "postgres",
      "-d",
      "reviewrouter",
      "--no-owner",
      "--no-privileges",
      "--exit-on-error",
      "/tmp/source.dump",
    );
    const snapshotSql = `SELECT json_build_object('rows',(SELECT count(*) FROM rehearsal_items),'hash',(SELECT md5(string_agg(row_to_json(t)::text,'' ORDER BY id)) FROM rehearsal_items t),'sequence',(SELECT json_build_object('lastValue',last_value,'isCalled',is_called) FROM rehearsal_items_id_seq),'privateRows',(SELECT json_agg(row_to_json(t) ORDER BY id) FROM app_private.rehearsal_private t),'calledSequence',(SELECT json_build_object('lastValue',last_value,'isCalled',is_called) FROM app_private.called_sequence),'uncalledSequence',(SELECT json_build_object('lastValue',last_value,'isCalled',is_called) FROM app_private.uncalled_sequence),'constraints',(SELECT count(*) FROM pg_constraint WHERE connamespace='public'::regnamespace),'indexes',(SELECT count(*) FROM pg_indexes WHERE schemaname='public'),'migrations',(SELECT json_agg(m ORDER BY migration_name) FROM "_prisma_migrations" m))`;
    const sourceSnapshot = sql(source, snapshotSql);
    const targetSnapshot = sql(target, snapshotSql);
    if (sourceSnapshot !== targetSnapshot)
      throw new Error("private_pg17_rehearsal_equivalence_failed");
    sql(source, "DROP SCHEMA app_private CASCADE");
    sql(target, "DROP SCHEMA app_private CASCADE");
    const configuration = disposableSqlConfiguration();
    sql(
      target,
      `CREATE ROLE reviewrouter_role_bootstrap LOGIN CREATEROLE PASSWORD 'disposable-bootstrap';
       CREATE ROLE reviewrouter_api LOGIN PASSWORD 'disposable-api';
       CREATE ROLE reviewrouter_web LOGIN PASSWORD 'disposable-web';
       CREATE ROLE reviewrouter_worker LOGIN PASSWORD 'disposable-worker';
       CREATE ROLE reviewrouter_codex_effect_authority LOGIN PASSWORD 'disposable-effect';
       CREATE ROLE reviewrouter_release_migration LOGIN PASSWORD 'disposable-release';
       CREATE ROLE reviewrouter_activation_receipt_guard NOLOGIN;
       CREATE ROLE reviewrouter_activation_permit_installer LOGIN PASSWORD 'disposable-installer';
       CREATE ROLE reviewrouter_activation_receipt_reader LOGIN PASSWORD 'disposable-receipt-reader';
       ALTER DATABASE reviewrouter OWNER TO reviewrouter_role_bootstrap;
       GRANT reviewrouter_api TO reviewrouter_role_bootstrap WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;
       GRANT reviewrouter_web TO reviewrouter_role_bootstrap WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;
       GRANT reviewrouter_worker TO reviewrouter_role_bootstrap WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;
       GRANT reviewrouter_codex_effect_authority TO reviewrouter_role_bootstrap WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;
       GRANT reviewrouter_release_migration TO reviewrouter_role_bootstrap WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;
       ALTER TABLE rehearsal_items OWNER TO reviewrouter_role_bootstrap;
       ALTER SEQUENCE rehearsal_items_id_seq OWNER TO reviewrouter_role_bootstrap;
       GRANT CREATE ON DATABASE reviewrouter TO reviewrouter_role_bootstrap;
       DO $transfer$ DECLARE item record; BEGIN
         FOR item IN SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proowner='postgres'::regrole LOOP
           EXECUTE format('ALTER ROUTINE %s OWNER TO reviewrouter_role_bootstrap', item.oid::regprocedure);
         END LOOP;
         FOR item IN SELECT t.typname, t.typtype FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' AND t.typowner='postgres'::regrole AND t.typtype IN ('d','e','m','r') LOOP
           EXECUTE CASE WHEN item.typtype='d' THEN format('ALTER DOMAIN public.%I OWNER TO reviewrouter_role_bootstrap',item.typname) ELSE format('ALTER TYPE public.%I OWNER TO reviewrouter_role_bootstrap',item.typname) END;
         END LOOP;
       END $transfer$;
       ALTER SCHEMA public OWNER TO reviewrouter_role_bootstrap;
       SET ROLE reviewrouter_role_bootstrap;
       CREATE EXTENSION IF NOT EXISTS pgcrypto;
       RESET ROLE;
       DO $extension_owners$ DECLARE item record; BEGIN
         FOR item IN SELECT c.oid, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relowner='postgres'::regrole AND c.relkind IN ('r','p','v','m','S','f') AND (c.relkind <> 'S' OR NOT EXISTS (SELECT 1 FROM pg_depend dependency WHERE dependency.classid='pg_class'::regclass AND dependency.objid=c.oid AND dependency.refclassid='pg_class'::regclass AND dependency.deptype IN ('a','i'))) LOOP
           EXECUTE CASE item.relkind WHEN 'S' THEN format('ALTER SEQUENCE %s OWNER TO reviewrouter_role_bootstrap',item.oid::regclass) WHEN 'v' THEN format('ALTER VIEW %s OWNER TO reviewrouter_role_bootstrap',item.oid::regclass) WHEN 'm' THEN format('ALTER MATERIALIZED VIEW %s OWNER TO reviewrouter_role_bootstrap',item.oid::regclass) WHEN 'f' THEN format('ALTER FOREIGN TABLE %s OWNER TO reviewrouter_role_bootstrap',item.oid::regclass) ELSE format('ALTER TABLE %s OWNER TO reviewrouter_role_bootstrap',item.oid::regclass) END;
         END LOOP;
         FOR item IN SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proowner='postgres'::regrole LOOP
           EXECUTE format('ALTER ROUTINE %s OWNER TO reviewrouter_role_bootstrap', item.oid::regprocedure);
         END LOOP;
         FOR item IN SELECT t.typname, t.typtype FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' AND t.typowner='postgres'::regrole AND t.typtype IN ('d','e','m','r') LOOP
           EXECUTE CASE WHEN item.typtype='d' THEN format('ALTER DOMAIN public.%I OWNER TO reviewrouter_role_bootstrap',item.typname) ELSE format('ALTER TYPE public.%I OWNER TO reviewrouter_role_bootstrap',item.typname) END;
         END LOOP;
       END $extension_owners$;
       DO $generation$ DECLARE binding jsonb; BEGIN
         binding := jsonb_build_object(
           'version', 1,
           'systemIdentifier', (SELECT system_identifier::text FROM pg_control_system()),
           'recoveryWitnessSha256', '${"c".repeat(64)}'
         );
         EXECUTE format('COMMENT ON DATABASE %I IS %L', current_database(), binding::text);
       END $generation$;`,
    );
    const url = (username, password) =>
      `postgresql://${username}:${password}@target.internal:${targetPort}/reviewrouter?sslmode=disable`;
    const canonicalEnv = {
      REVIEW_ROUTER_ROLE_BOOTSTRAP_DATABASE_URL: url(
        "reviewrouter_role_bootstrap",
        "disposable-bootstrap",
      ),
      REVIEW_ROUTER_RELEASE_MIGRATION_DATABASE_URL: url(
        "reviewrouter_release_migration",
        configuration.releasePassword,
      ),
      REVIEW_ROUTER_API_DATABASE_URL: url(
        "reviewrouter_api",
        configuration.roles[0].password,
      ),
      REVIEW_ROUTER_WEB_DATABASE_URL: url(
        "reviewrouter_web",
        configuration.roles[1].password,
      ),
      REVIEW_ROUTER_WORKER_DATABASE_URL: url(
        "reviewrouter_worker",
        configuration.roles[2].password,
      ),
      REVIEW_ROUTER_CODEX_EFFECT_AUTHORITY_DATABASE_URL: url(
        "reviewrouter_codex_effect_authority",
        configuration.roles[3].password,
      ),
      REVIEW_ROUTER_RELEASE_COMMIT_SHA: "d".repeat(40),
      REVIEW_ROUTER_RELEASE_IMAGE_DIGEST: sha256(sourceSnapshot),
      REVIEW_ROUTER_ROLLOUT_ID: "disposable-rehearsal",
      REVIEW_ROUTER_SOURCE_DATABASE_SYSTEM_IDENTIFIER: sql(
        source,
        "SELECT system_identifier::text FROM pg_control_system()",
      ),
      REVIEW_ROUTER_TARGET_DATABASE_SYSTEM_IDENTIFIER: sql(
        target,
        "SELECT system_identifier::text FROM pg_control_system()",
      ),
      REVIEW_ROUTER_TARGET_RECOVERY_WITNESS_SHA256: "c".repeat(64),
      GITHUB_RUN_ID: "1",
      GITHUB_RUN_ATTEMPT: "1",
      REVIEW_ROUTER_CUTOVER_WORKFLOW_JOB_ID: "11",
    };
    execute(
      [
        "exec",
        "--interactive",
        target,
        "psql",
        "-U",
        "postgres",
        "-d",
        "reviewrouter",
      ],
      { input: activationAuthorityProvisioningSql() },
    );
    sql(
      target,
      "GRANT USAGE ON SCHEMA reviewrouter_activation TO reviewrouter_role_bootstrap",
    );
    const controlToken = randomBytes(32).toString("hex");
    const providerAuthorityToken = randomBytes(32).toString("hex");
    const authorityUrl = `postgresql://reviewrouter_release_control:disposable-control@127.0.0.1:${authorityPort}/reviewrouter?sslmode=disable`;
    const providerAuthorityUrl = `postgresql://reviewrouter_provider_authority:disposable-provider@127.0.0.1:${authorityPort}/reviewrouter?sslmode=disable`;
    const installerUrl = `postgresql://reviewrouter_activation_permit_installer:disposable-installer@127.0.0.1:${targetPort}/reviewrouter?sslmode=disable`;
    const receiptReaderUrl = `postgresql://reviewrouter_activation_receipt_reader:disposable-receipt-reader@127.0.0.1:${targetPort}/reviewrouter?sslmode=disable`;
    controlPrisma = createPrismaClient({
      databaseUrl: authorityUrl,
      poolMax: 2,
    });
    providerAuthorityPrisma = createPrismaClient({
      databaseUrl: providerAuthorityUrl,
      poolMax: 1,
    });
    permitInstallerPrisma = createPrismaClient({
      databaseUrl: installerUrl,
      poolMax: 1,
    });
    targetReceiptReaderPrisma = createPrismaClient({
      databaseUrl: receiptReaderUrl,
      poolMax: 1,
    });
    releaseControl = await createReleaseControlApp({
      controlPrisma,
      providerAuthorityPrisma,
      permitInstallerPrisma,
      targetReceiptReaderPrisma,
      credentials: {
        controlTokenSha256: createHash("sha256")
          .update(controlToken)
          .digest("hex"),
        providerAuthorityTokenSha256: createHash("sha256")
          .update(providerAuthorityToken)
          .digest("hex"),
      },
    });
    await releaseControl.ready();
    const controlFetch = async (input, init) => {
      const requestUrl = new URL(String(input));
      const response = await releaseControl.inject({
        method: init?.method ?? "GET",
        url: `${requestUrl.pathname}${requestUrl.search}`,
        headers: init?.headers,
        payload: init?.body,
      });
      return new globalThis.Response(response.body, {
        status: response.statusCode,
        headers: response.headers,
      });
    };
    const authorityOrigin = "https://disposable-release-authority.invalid";
    const ledger = new AuthenticatedRunnerLedgerAdapter(
      authorityOrigin,
      controlToken,
      controlFetch,
    );
    const providerAuthority = new HttpProviderAuthorityDecisionAdapter(
      authorityOrigin,
      providerAuthorityToken,
      controlFetch,
    );
    const productionPath = await verifyProductionPathRehearsal({
      dumpSha256: sha256(dump),
      equivalenceSha256: sha256(sourceSnapshot),
      sourceSystemIdentifier: sql(
        source,
        "SELECT system_identifier::text FROM pg_control_system()",
      ),
      targetSystemIdentifier: sql(
        target,
        "SELECT system_identifier::text FROM pg_control_system()",
      ),
      canonicalEnv,
      targetPort,
      rehearsalDirectory: directory,
      ledger,
      providerAuthority,
      controlFetch,
      authorityOrigin,
      controlToken,
      providerAuthorityToken,
      authorityContainer: authority,
      targetContainer: target,
      sql,
      closeBootstrapGuardRead: () =>
        sql(
          target,
          "REVOKE SELECT ON reviewrouter_activation.activation_receipt FROM reviewrouter_role_bootstrap; REVOKE USAGE ON SCHEMA reviewrouter_activation FROM reviewrouter_role_bootstrap",
        ),
    });
    if (
      sql(
        target,
        "SELECT count(*) FROM reviewrouter_activation.activation_receipt WHERE rollout_id='disposable-rehearsal'",
      ) !== "1" ||
      sql(
        target,
        "SELECT has_table_privilege('reviewrouter_api','rehearsal_items','INSERT')",
      ) !== "t"
    )
      throw new Error("private_pg17_rehearsal_activation_failed");
    if (!productionPath.activationReplayStable)
      throw new Error("private_pg17_rehearsal_activation_replay_unstable");
    return Object.freeze({
      schemaVersion: 1,
      disposable: true,
      sourceMajor: 16,
      targetMajor: 17,
      dumpSha256: sha256(dump),
      equivalenceSha256: sha256(sourceSnapshot),
      aclGateBeforeActivation: "closed",
      activationReceipt: "disposable-rehearsal",
      activationReplayStable: true,
      authorityDatabaseMajor: 17,
      authorityDatabaseSeparate: true,
      productionPath,
    });
  } finally {
    if (releaseControl) await releaseControl.close();
    await Promise.allSettled([
      controlPrisma?.$disconnect(),
      providerAuthorityPrisma?.$disconnect(),
      permitInstallerPrisma?.$disconnect(),
      targetReceiptReaderPrisma?.$disconnect(),
    ]);
    let cleanupError;
    for (const name of createdContainers.reverse()) {
      try {
        docker("rm", "--force", name);
      } catch (error) {
        if (
          !/No such container|removal of container .* is already in progress/u.test(
            String(error),
          )
        )
          cleanupError ??= error;
      }
    }
    if (networkCreated) docker("network", "rm", network);
    rmSync(directory, { force: true, recursive: true });
    // The disposable rehearsal must fail when resource cleanup is incomplete.
    // eslint-disable-next-line no-unsafe-finally
    if (cleanupError) throw cleanupError;
  }
}

async function verifyProductionPathRehearsal(facts) {
  const digest = facts.equivalenceSha256;
  const redirect = (value) =>
    typeof value === "string"
      ? value.replace(
          `target.internal:${facts.targetPort}`,
          `127.0.0.1:${facts.targetPort}`,
        )
      : value;
  const connectCanonicalRun = createSecureCanonicalRun(
    () => "127.0.0.1",
    (step, detail) => {
      throw new Error(
        `private_pg17_rehearsal_canonical_failed:${step}:${detail}`,
      );
    },
  );
  const canonicalProcessRun = (step, command, args, options = {}) => {
    if (command !== "psql")
      return connectCanonicalRun(step, command, args, options);
    const urlIndex = args.findIndex(
      (arg) => arg.startsWith("postgres://") || arg.startsWith("postgresql://"),
    );
    if (urlIndex < 0) {
      const hostIndex = args.indexOf("--host");
      if (hostIndex < 0 || args[hostIndex + 1] !== "target.internal")
        throw new Error("rehearsal_psql_target_invalid");
      const result = spawnSync("psql", [...args], {
        encoding: "utf8",
        env: {
          ...options.env,
          PATH: process.env.PATH,
          LANG: "C.UTF-8",
          PGHOSTADDR: "127.0.0.1",
          PGSSLMODE: "disable",
        },
        input: options.input,
        maxBuffer: 8 * 1024 * 1024,
      });
      if (result.status !== 0)
        throw new Error(
          `private_pg17_rehearsal_canonical_failed:${step}:${String(result.stderr).slice(0, 2_000)}`,
        );
      return result.stdout;
    }
    const url = new URL(args[urlIndex]);
    const passDirectory = mkdtempSync(join(tmpdir(), "rr-rehearsal-pass-"));
    const passfile = join(passDirectory, "pgpass");
    writeFileSync(
      passfile,
      `${url.hostname}:${url.port}:${url.pathname.slice(1)}:${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}\n`,
      { mode: 0o600 },
    );
    const result = spawnSync(
      "psql",
      [
        "--host",
        url.hostname,
        "--port",
        url.port,
        "--username",
        decodeURIComponent(url.username),
        "--dbname",
        url.pathname.slice(1),
        ...args.filter((_, index) => index !== urlIndex),
      ],
      {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          LANG: "C.UTF-8",
          PGPASSFILE: passfile,
          PGHOSTADDR: "127.0.0.1",
          PGSSLMODE: "disable",
        },
        input: options.input,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    rmSync(passDirectory, { force: true, recursive: true });
    if (result.status !== 0)
      throw new Error(
        `private_pg17_rehearsal_canonical_failed:${step}:${String(result.stderr).slice(0, 2_000)}`,
      );
    return result.stdout;
  };
  const canonicalRun = (step, command, args, options = {}) =>
    canonicalProcessRun(step, command, args, {
      ...options,
      ...(options.env
        ? {
            env: Object.fromEntries(
              Object.entries(options.env).map(([key, value]) => [
                key,
                redirect(value),
              ]),
            ),
          }
        : {}),
    });
  const activationCommands = {
    execute(command, args, options) {
      return {
        stdout: canonicalProcessRun("activation", command, args, options),
      };
    },
  };
  const execution = {
    organization: "disposable-control",
    controlRepository: "disposable-control/releases",
    workflowPath: ".github/workflows/private-network-pg17-rollout.yml",
    workflowRef: "refs/heads/main",
    event: "workflow_dispatch",
    actor: "rehearsal",
    runId: "1",
    runAttempt: 1,
    roleJobName: "private-role-job",
    cutoverJobName: "private-cutover-job",
  };
  let rollout = createReleaseRollout({
    rolloutId: "disposable-rehearsal",
    expectedCommitSha: "d".repeat(40),
    execution,
    source: {
      renderResourceId: "dpg-disposable-source",
      internalHostname: "source.internal",
      databaseName: "reviewrouter",
      systemIdentifier: facts.sourceSystemIdentifier,
      majorVersion: 16,
      recoveryWitnessSha256: "a".repeat(64),
    },
    target: {
      renderResourceId: "dpg-disposable-target",
      internalHostname: "target.internal",
      databaseName: "reviewrouter",
      systemIdentifier: facts.targetSystemIdentifier,
      majorVersion: 17,
      recoveryWitnessSha256: "c".repeat(64),
    },
  });
  const runner = (lifecycle, job) => ({
    organization: execution.organization,
    repository: execution.controlRepository,
    workflowPath: execution.workflowPath,
    workflowRef: execution.workflowRef,
    event: execution.event,
    actor: execution.actor,
    runId: execution.runId,
    runAttempt: 1,
    workflowJobId: lifecycle === "role" ? "10" : "11",
    workflowJobName:
      lifecycle === "role" ? execution.roleJobName : execution.cutoverJobName,
    commitSha: "d".repeat(40),
    runnerName: `rr-${lifecycle}`,
    cleanupCanary: `rr-cleanup:disposable-rehearsal:rr-${lifecycle}`,
    renderJobId: job,
    baseServiceId: "srv-disposable",
    runnerGroupId: 1,
    runnerGroupName: "private-pg17",
    uniqueRunnerLabel: `rr-${lifecycle}`,
    workFolder: `_work/rr-${lifecycle}`,
    provenance: { kind: "image", deployId: "dep-disposable", imageSha: digest },
    imageAttestation: {
      subjectDigest: digest,
      sourceCommitSha: "d".repeat(40),
      statementSha256: digest,
      builderId: "disposable-rehearsal-builder",
    },
  });
  const roleRunner = runner("role", "job-role");
  const cutoverRunner = runner("cutover", "job-cutover");
  let tick = 0;
  const observed = (step, value = {}, provider) => ({
    step,
    observedAt: new Date(Date.UTC(2026, 7, 12, 0, 0, tick++)).toISOString(),
    facts: value,
    ...(provider ? { provider } : {}),
  });
  const sqlConfiguration = disposableSqlConfiguration();
  const generated = {
    roleBootstrapSha256: `sha256:${sha256Canonical(roleProvisioningSql(sqlConfiguration))}`,
    migrationSha256: `sha256:${sha256Canonical(runtimeGrantSql(sqlConfiguration, { gateClosed: true }))}`,
    activation: canonicalActivationSql(sqlConfiguration, {
      rolloutId: "disposable-rehearsal",
    }),
  };
  const catalogSha256 = {
    sequences: digest,
    columnsDefaults: digest,
    constraintsIndexesTriggers: digest,
    policiesRls: digest,
    functionsViewsSchemas: digest,
    aclOwnershipDefaults: digest,
    migrationHistory: digest,
  };
  let provision = roleRunner;
  let cleanupStep = RolloutStep.CleanupRoleRunner;
  const ledger = facts.ledger;
  let evidence;
  const useCases = new ReleaseRolloutUseCases({
    authority: facts.providerAuthority,
    preflight: {
      observeProtectedEnvironment: async () =>
        observed(RolloutStep.VerifyProtectedEnvironment, {
          organization: execution.organization,
          repository: execution.controlRepository,
          workflowPath: execution.workflowPath,
          workflowRef: execution.workflowRef,
          sha: rollout.expectedCommitSha,
          event: execution.event,
          actor: execution.actor,
          runId: execution.runId,
          runAttempt: 1,
          environments: [
            {
              name: "disposable-rehearsal",
              requiredReviewerCount: 1,
              preventSelfReview: true,
              protectedBranchesOnly: true,
            },
          ],
          runnerGroupId: 1,
          observationSha256: digest,
        }),
    },
    provider: {
      freezeAndObserve: async () =>
        observed(
          RolloutStep.FreezeProviderServices,
          {
            services: [
              {
                serviceId: "source-writer",
                suspended: true,
                observedAt: "2026-08-12T00:00:02.000Z",
                latestSuccessfulDeployId: "dep-source",
              },
            ],
            complete: true,
          },
          {
            renderServiceIds: ["source-writer"],
            renderDeployIds: ["dep-source"],
          },
        ),
      compensateAndObserve: async () =>
        observed(RolloutStep.CompleteCompensation, { resumed: true }),
    },
    runner: {
      provision: async () => ({
        identity: provision,
        observation: observed(
          provision === roleRunner
            ? RolloutStep.ProvisionRoleRunner
            : RolloutStep.ProvisionCutoverRunner,
          provision,
          {
            renderJobId: provision.renderJobId,
            renderDeployId: provision.provenance.deployId,
            githubWorkflowJobId: provision.workflowJobId,
          },
        ),
      }),
      cleanup: async () => {
        const observedAt = new Date(
          Date.UTC(2026, 7, 12, 0, 0, tick++),
        ).toISOString();
        return {
          step: cleanupStep,
          observedAt,
          facts: {
            provider: { id: provision.renderJobId, status: "succeeded" },
            runner: {
              listenerStopped: true,
              workspaceRemoved: true,
              credentialProcessGone: true,
              canary: provision.cleanupCanary,
              observedAt,
            },
          },
          provider: { renderJobId: provision.renderJobId },
        };
      },
      reconcileOrphans: async () => [],
    },
    database: {
      captureBackup: async () =>
        observed(RolloutStep.CaptureSourceBackup, {
          dumpSha256: facts.dumpSha256,
          backup: {
            renderResourceId: rollout.source.renderResourceId,
            internalHostname: rollout.source.internalHostname,
            databaseName: rollout.source.databaseName,
            systemIdentifier: rollout.source.systemIdentifier,
            lsn: "0/1",
            capturedAt: "2026-08-12T00:00:03.000Z",
            recoveryWindowStartsAt: "2026-08-11T00:00:00.000Z",
            recoveryWindowEndsAt: "2026-08-13T00:00:00.000Z",
            dumpSha256: facts.dumpSha256,
            externalWitnessSha256: digest,
            recoveryStatus: "AVAILABLE",
          },
        }),
      quiesce: async () =>
        observed(RolloutStep.QuiesceSource, {
          writerServices: [
            {
              serviceId: "source-writer",
              suspended: true,
              observedAt: "2026-08-12T00:00:02.000Z",
            },
          ],
          aclSha256: digest,
          stabilizationSeries: [0, 0, 0],
          reconnectDeniedRoles: [
            "reviewrouter_api",
            "reviewrouter_web",
            "reviewrouter_worker",
            "reviewrouter_codex_effect_authority",
          ],
          complete: true,
        }),
      copy: async () =>
        observed(RolloutStep.CopyDatabaseGeneration, {
          dumpSha256: facts.dumpSha256,
          ownershipRestored: false,
          privilegesRestored: false,
        }),
      verifyEquivalence: async () =>
        observed(RolloutStep.VerifyDataEquivalence, {
          tables: [
            {
              table: "public.rehearsal_items",
              sourceRows: 3,
              targetRows: 3,
              sourceSha256: digest,
              targetSha256: digest,
            },
          ],
          catalogSha256,
          equivalent: true,
          streamingHash: true,
          maxProcessBufferBytes: 8 * 1024 * 1024,
        }),
      bootstrapTargetRoles: async () =>
        observed(
          RolloutStep.BootstrapTargetRoles,
          executeCanonicalRoleBootstrap(facts.canonicalEnv, canonicalRun),
        ),
      runReleaseMigration: async () => {
        const migration = executeCanonicalReleaseMigration(
          {
            ...facts.canonicalEnv,
            REVIEW_ROUTER_RELEASE_ACL_GATE_MODE: "closed",
          },
          canonicalRun,
        );
        const migrationChecksum = facts.sql(
          facts.targetContainer,
          "SELECT 'sha256:' || encode(pg_catalog.sha256(convert_to(coalesce(string_agg(migration_name || ':' || checksum, ',' ORDER BY migration_name), ''), 'UTF8')), 'hex') FROM public._prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL",
        );
        if (!/^sha256:[a-f0-9]{64}$/u.test(migrationChecksum))
          throw new Error("private_pg17_rehearsal_migration_checksum_unproven");
        canonicalRun(
          "claim_trusted_migration_evidence",
          "psql",
          [
            facts.canonicalEnv.REVIEW_ROUTER_RELEASE_MIGRATION_DATABASE_URL,
            "--no-psqlrc",
            "--quiet",
          ],
          {
            env: {
              DATABASE_URL:
                facts.canonicalEnv.REVIEW_ROUTER_RELEASE_MIGRATION_DATABASE_URL,
            },
            input: String.raw`\set ON_ERROR_STOP on
BEGIN;
SELECT reviewrouter_bootstrap.consume_migration_evidence(
  'sha256:${"e".repeat(64)}',
  '303',
  'disposable-rehearsal',
  '1',
  1,
  '11',
  '.github/workflows/codex-rotating-release-migration.yml',
  '${facts.canonicalEnv.REVIEW_ROUTER_RELEASE_COMMIT_SHA}',
  '${facts.canonicalEnv.REVIEW_ROUTER_RELEASE_IMAGE_DIGEST}',
  '${facts.targetSystemIdentifier}',
  '${facts.canonicalEnv.REVIEW_ROUTER_TARGET_RECOVERY_WITNESS_SHA256}'
);
COMMIT;
`,
          },
        );
        const evidenceClaimed = facts.sql(
          facts.targetContainer,
          `SELECT EXISTS (
             SELECT 1
             FROM pg_database database,
                  LATERAL jsonb_array_elements(
                    coalesce(
                      shobj_description(database.oid, 'pg_database')::jsonb
                        ->'consumedMigrationEvidence',
                      '[]'::jsonb
                    )
                  ) evidence
             WHERE database.datname = current_database()
               AND evidence->>'commit' = '${facts.canonicalEnv.REVIEW_ROUTER_RELEASE_COMMIT_SHA}'
               AND evidence->>'systemIdentifier' = '${facts.targetSystemIdentifier}'
           )`,
        );
        if (evidenceClaimed !== "t")
          throw new Error(
            "private_pg17_rehearsal_migration_evidence_claim_unproven",
          );
        return observed(RolloutStep.RunReleaseMigration, {
          ...migration,
          migrationChecksum,
        });
      },
      activate: async (rolloutId) => {
        return executePrivateGenerationActivation(
          { ...facts.canonicalEnv, REVIEW_ROUTER_ROLLOUT_ID: rolloutId },
          activationCommands,
        );
      },
      compensateSource: async () =>
        observed(RolloutStep.CompleteCompensation, { aclRestored: true }),
    },
    services: {
      stageTarget: async (fence) =>
        observed(
          RolloutStep.StageTargetServices,
          [
            {
              serviceId: "srv-target",
              deployId: "dep-disposable",
              provenance: {
                kind: "git",
                commitSha: rollout.expectedCommitSha,
              },
              envSha256: digest,
              suspended: true,
              targetSwitchFenceNonce: fence.nonce,
              targetSwitchFenceVersion: fence.version,
            },
          ],
          {
            renderServiceIds: ["srv-target"],
            renderDeployIds: ["dep-disposable"],
            targetSwitchFenceNonce: fence.nonce,
            targetSwitchFenceVersion: fence.version,
          },
        ),
      resumeDeployAndObserve: async () =>
        observed(
          RolloutStep.ResumeTargetServices,
          [
            {
              serviceId: "srv-target",
              deployId: "dep-disposable",
              resumed: true,
            },
          ],
          {
            renderServiceIds: ["srv-target"],
            renderDeployIds: ["dep-disposable"],
          },
        ),
      verifyLiveCanary: async () =>
        observed(RolloutStep.VerifyLiveCanary, {
          commitSha: rollout.expectedCommitSha,
          databaseSystemIdentifier: rollout.target.systemIdentifier,
          writeReadRoundTrip: true,
        }),
    },
    evidence: {
      assembleAndVerify: async (current) => {
        const assembledAt = new Date(
          Math.max(
            ...current.receipts.map((receipt) =>
              Date.parse(receipt.observedAt),
            ),
            Date.parse(current.activationReceipt.observedAt),
          ) + 1_000,
        ).toISOString();
        evidence = assembleTrustedRolloutEvidence({
          rolloutId: current.rolloutId,
          releaseCommitSha: current.expectedCommitSha,
          execution: current.execution,
          runners: [roleRunner, cutoverRunner],
          source: current.source,
          target: current.target,
          backup: {
            renderResourceId: current.source.renderResourceId,
            internalHostname: current.source.internalHostname,
            databaseName: current.source.databaseName,
            systemIdentifier: current.source.systemIdentifier,
            lsn: "0/1",
            capturedAt: "2026-08-12T00:00:02.000Z",
            recoveryWindowStartsAt: "2026-08-11T00:00:00.000Z",
            recoveryWindowEndsAt: "2026-08-13T00:00:00.000Z",
            dumpSha256: facts.dumpSha256,
            externalWitnessSha256: digest,
            recoveryStatus: "AVAILABLE",
          },
          quiescence: {
            writerServices: [
              {
                serviceId: "source-writer",
                suspended: true,
                observedAt: "2026-08-12T00:00:01.000Z",
              },
            ],
            aclSha256: digest,
            stabilizationSeries: [0, 0, 0],
            reconnectDeniedRoles: [
              "reviewrouter_api",
              "reviewrouter_web",
              "reviewrouter_worker",
              "reviewrouter_codex_effect_authority",
            ],
            complete: true,
          },
          equivalence: {
            tables: [
              {
                table: "public.rehearsal_items",
                sourceRows: 3,
                targetRows: 3,
                sourceSha256: digest,
                targetSha256: digest,
              },
            ],
            catalogSha256,
            equivalent: true,
            streamingHash: true,
            maxProcessBufferBytes: 8 * 1024 * 1024,
          },
          protectedEnvironmentPreflightSha256: current.receipts.find(
            (receipt) =>
              receipt.step === RolloutStep.VerifyProtectedEnvironment,
          ).observationSha256,
          receipts: current.receipts,
          activation: current.activationReceipt,
          resumedTargetDeployIds: ["dep-disposable"],
          liveCanarySha256: digest,
          cleanups: [
            {
              renderJobId: roleRunner.renderJobId,
              providerStatus: "succeeded",
              listenerStopped: true,
              workspaceRemoved: true,
              credentialProcessGone: true,
              cleanupCanary: roleRunner.cleanupCanary,
              observedAt: current.receipts.find(
                (receipt) => receipt.step === RolloutStep.CleanupRoleRunner,
              ).observedAt,
            },
            {
              renderJobId: cutoverRunner.renderJobId,
              providerStatus: "succeeded",
              listenerStopped: true,
              workspaceRemoved: true,
              credentialProcessGone: true,
              cleanupCanary: cutoverRunner.cleanupCanary,
              observedAt: current.receipts.find(
                (receipt) => receipt.step === RolloutStep.CleanupCutoverRunner,
              ).observedAt,
            },
          ],
          assembledAt,
        });
        return observed(RolloutStep.VerifyTrustedRollout, {
          evidenceSha256: evidence.evidenceSha256,
        });
      },
    },
    ledger,
  });
  rollout = await useCases.claimRollout(rollout);
  rollout = await useCases.verifyProtectedEnvironment(rollout);
  rollout = await useCases.freezeProviderServices(rollout);
  ({ rollout } = await useCases.provisionPrivateRunner(rollout));
  rollout = await useCases.captureSourceBackup(rollout);
  rollout = await useCases.quiesceSource(rollout);
  rollout = await useCases.copyDatabaseGeneration(rollout);
  rollout = await useCases.bootstrapTargetRoles(rollout);
  facts.closeBootstrapGuardRead();
  rollout = await useCases.verifyDataEquivalence(rollout);
  rollout = await useCases.cleanupRoleRunner(rollout, roleRunner);
  provision = cutoverRunner;
  ({ rollout } = await useCases.provisionCutoverRunner(rollout));
  rollout = await useCases.runReleaseMigration(rollout);
  rollout = await useCases.stageTargetServices(rollout);
  rollout = await useCases.activateTargetGeneration(
    rollout,
    cutoverRunner.workflowJobId,
  );
  cleanupStep = RolloutStep.CleanupCutoverRunner;
  rollout = await useCases.cleanupCutoverRunner(rollout, cutoverRunner);
  rollout = await useCases.resumeTargetServices(rollout);
  rollout = await useCases.verifyLiveCanary(rollout);
  rollout = await useCases.verifyTrustedRollout(rollout);
  const authorityState = await ledger.observeActivationState({
    rolloutId: rollout.rolloutId,
    sourceSystemIdentifier: rollout.source.systemIdentifier,
    targetSystemIdentifier: rollout.target.systemIdentifier,
  });
  if (authorityState !== "activated")
    throw new Error("private_pg17_rehearsal_durable_ledger_unproven");
  const replayedActivation = executePrivateGenerationActivation(
    facts.canonicalEnv,
    activationCommands,
  );
  const activationReplayStable =
    replayedActivation.facts.firstWriteReceiptSha256 ===
      rollout.activationReceipt?.firstWriteReceiptSha256 &&
    facts.sql(
      facts.targetContainer,
      "SELECT count(*) = 1 AND bool_and(permit.consumed_at IS NOT NULL) FROM reviewrouter_activation.activation_receipt receipt JOIN reviewrouter_activation.activation_permit permit USING (rollout_id) WHERE receipt.rollout_id='disposable-rehearsal'",
    ) === "t";
  const uncertain = transitionFailure(rollout, "activation_uncertain");
  let sourceBanProven = false;
  try {
    assertPromotionAllowed(uncertain, uncertain.source.systemIdentifier);
  } catch {
    sourceBanProven = true;
  }
  if (!sourceBanProven)
    throw new Error("private_pg17_rehearsal_source_ban_unproven");
  const adversarial = await verifyAuthorityAdversarialChecks(facts, rollout);
  const compensated = completeCompensation(
    beginCompensation(
      transitionFailure(
        createReleaseRollout({
          rolloutId: "disposable-compensation",
          expectedCommitSha: "e".repeat(40),
          execution: { ...execution, runId: "2" },
          source: rollout.source,
          target: rollout.target,
        }),
        "definite_pre_activation",
      ),
    ),
  );
  return {
    phase: rollout.phase,
    generated: {
      roleBootstrapSha256: generated.roleBootstrapSha256,
      migrationSha256: generated.migrationSha256,
      activationSqlSha256: `sha256:${sha256Canonical(generated.activation.sql)}`,
      canonicalPrivilegesSha256: generated.activation.canonicalPrivilegesSha256,
    },
    receiptCount: rollout.receipts.length,
    sourceBanProven,
    compensationProven: compensated.phase === "recovery_compensated",
    activationReplayStable,
    adversarial,
    evidenceSha256: evidence.evidenceSha256,
  };
}

async function verifyAuthorityAdversarialChecks(facts, rollout) {
  const request = async (path, body, token = facts.controlToken) =>
    facts.controlFetch(`${facts.authorityOrigin}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  const binding = {
    rolloutId: rollout.rolloutId,
    expectedCommitSha: rollout.expectedCommitSha,
    runId: rollout.execution.runId,
    runAttempt: rollout.execution.runAttempt,
    sourceSystemIdentifier: rollout.source.systemIdentifier,
    targetSystemIdentifier: rollout.target.systemIdentifier,
  };
  const replay = await request("/v1/rollouts/claim", binding);
  if (replay.status !== 200 || (await replay.json()).result !== "duplicate")
    throw new Error("private_pg17_rehearsal_authority_replay_unproven");
  const conflict = await request("/v1/rollouts/claim", {
    ...binding,
    expectedCommitSha: "f".repeat(40),
  });
  if (conflict.status < 400)
    throw new Error("private_pg17_rehearsal_authority_conflict_unproven");
  const unauthorized = await request(
    "/v1/rollouts/claim",
    binding,
    "wrong-token",
  );
  if (unauthorized.status !== 401)
    throw new Error("private_pg17_rehearsal_authority_auth_unproven");
  const deployAfterActivation = await request(
    "/v1/provider-authority/decisions",
    {
      rolloutId: rollout.rolloutId,
      operation: "deploy_target",
      sourceSystemIdentifier: rollout.source.systemIdentifier,
      targetSystemIdentifier: rollout.target.systemIdentifier,
      expectedReceiptSha256: rollout.receipts.at(-1).receiptSha256,
      activationBoundary: "before",
    },
    facts.providerAuthorityToken,
  );
  if (deployAfterActivation.status !== 409)
    throw new Error("private_pg17_rehearsal_provider_conflict_unproven");
  const outageAuthority = new HttpProviderAuthorityDecisionAdapter(
    facts.authorityOrigin,
    facts.providerAuthorityToken,
    async () => {
      throw new Error("disposable_authority_outage");
    },
  );
  let outageRejected = false;
  try {
    await outageAuthority.decide({
      rolloutId: rollout.rolloutId,
      operation: "resume_target",
      sourceSystemIdentifier: rollout.source.systemIdentifier,
      targetSystemIdentifier: rollout.target.systemIdentifier,
      expectedReceiptSha256: rollout.receipts.at(-1).receiptSha256,
      activationBoundary: "activated",
    });
  } catch {
    outageRejected = true;
  }
  if (!outageRejected)
    throw new Error("private_pg17_rehearsal_authority_outage_unproven");
  const authorityHasTargetState = facts.sql(
    facts.authorityContainer,
    "SELECT to_regclass('reviewrouter_activation.activation_permit') IS NOT NULL",
  );
  const targetHasAuthorityState = facts.sql(
    facts.targetContainer,
    "SELECT to_regclass('release_authority.rollout') IS NOT NULL",
  );
  if (authorityHasTargetState !== "f" || targetHasAuthorityState !== "f")
    throw new Error(
      "private_pg17_rehearsal_authority_database_isolation_unproven",
    );
  return Object.freeze({
    replayRejected: true,
    conflictRejected: true,
    unauthorizedRejected: true,
    providerConflictRejected: true,
    outageRejected: true,
    credentialStoresIsolated: true,
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    if (process.argv.includes("--check-only"))
      validateRehearsalConfiguration(process.env);
    else
      process.stdout.write(
        `${JSON.stringify(await executeDisposableRehearsal())}\n`,
      );
  } catch (error) {
    process.stderr.write(
      `FAIL: ${error instanceof Error ? error.message : "private_pg17_rehearsal_failed"}\n`,
    );
    process.exitCode = 1;
  }
}
