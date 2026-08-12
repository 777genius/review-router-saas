#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  RolloutStep,
  sha256Canonical,
  transitionFailure,
} from "../packages/features/release-rollout/src/index.ts";
import {
  canonicalActivationSql,
  roleProvisioningSql,
  runtimeGrantSql,
} from "./run-codex-rotating-release-migration.mjs";

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

export async function executeDisposableRehearsal(
  env = process.env,
  execute = (args, options = {}) => {
    const result = spawnSync("docker", args, {
      encoding: options.encoding ?? "utf8",
      input: options.input,
      maxBuffer: 32 * 1024 * 1024,
    });
    if (result.status !== 0)
      throw new Error(`private_pg17_rehearsal_docker_failed:${args[0]}`);
    return result.stdout;
  },
) {
  const images = validateRehearsalConfiguration(env);
  const suffix = randomBytes(6).toString("hex");
  const source = `rr-pg16-${suffix}`;
  const target = `rr-pg17-${suffix}`;
  const network = `rr-pg-cutover-${suffix}`;
  const directory = mkdtempSync(join(tmpdir(), "reviewrouter-pg17-rehearsal-"));
  const dumpPath = join(directory, "source.dump");
  const password = "disposable-reviewrouter-only";
  let networkCreated = false;
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
        "--env",
        `POSTGRES_PASSWORD=${password}`,
        "--env",
        "POSTGRES_DB=reviewrouter",
        image,
      );
      createdContainers.push(name);
    }
    for (const name of [source, target]) {
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
      !sql(target, "SHOW server_version_num").startsWith("170")
    )
      throw new Error("private_pg17_rehearsal_server_version_mismatch");
    sql(
      source,
      `COMMENT ON DATABASE reviewrouter IS '{"recoveryWitnessSha256":"${"a".repeat(64)}"}'; CREATE ROLE rehearsal_writer LOGIN; GRANT CONNECT ON DATABASE reviewrouter TO rehearsal_writer; CREATE TABLE rehearsal_items(id bigserial PRIMARY KEY, value text NOT NULL UNIQUE); CREATE TABLE "_prisma_migrations"(migration_name text PRIMARY KEY, checksum text NOT NULL); INSERT INTO rehearsal_items(value) VALUES ('one'),('two'),('three'); INSERT INTO "_prisma_migrations" VALUES ('rehearsal_001','${"b".repeat(64)}');`,
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
    const snapshotSql = `SELECT json_build_object('rows',(SELECT count(*) FROM rehearsal_items),'hash',(SELECT md5(string_agg(row_to_json(t)::text,'' ORDER BY id)) FROM rehearsal_items t),'sequence',(SELECT last_value FROM rehearsal_items_id_seq),'constraints',(SELECT count(*) FROM pg_constraint WHERE connamespace='public'::regnamespace),'indexes',(SELECT count(*) FROM pg_indexes WHERE schemaname='public'),'migrations',(SELECT json_agg(m ORDER BY migration_name) FROM "_prisma_migrations" m))`;
    const sourceSnapshot = sql(source, snapshotSql);
    const targetSnapshot = sql(target, snapshotSql);
    if (sourceSnapshot !== targetSnapshot)
      throw new Error("private_pg17_rehearsal_equivalence_failed");
    sql(
      target,
      `CREATE ROLE reviewrouter_api LOGIN; GRANT CONNECT ON DATABASE reviewrouter TO reviewrouter_api; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO reviewrouter_api; BEGIN; REVOKE CONNECT ON DATABASE reviewrouter FROM reviewrouter_api; REVOKE INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public FROM reviewrouter_api; CREATE TABLE "ReleaseGenerationActivationReceipt"("rolloutId" text PRIMARY KEY, "activatedAt" timestamptz NOT NULL DEFAULT transaction_timestamp()); COMMIT;`,
    );
    if (
      sql(
        target,
        "SELECT has_table_privilege('reviewrouter_api','rehearsal_items','INSERT')",
      ) !== "f"
    )
      throw new Error("private_pg17_rehearsal_acl_gate_open");
    sql(
      target,
      `BEGIN; GRANT CONNECT ON DATABASE reviewrouter TO reviewrouter_api; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO reviewrouter_api; INSERT INTO "ReleaseGenerationActivationReceipt"("rolloutId") VALUES ('disposable-rehearsal'); COMMIT;`,
    );
    if (
      sql(
        target,
        'SELECT count(*) FROM "ReleaseGenerationActivationReceipt" WHERE "rolloutId"=\'disposable-rehearsal\'',
      ) !== "1" ||
      sql(
        target,
        "SELECT has_table_privilege('reviewrouter_api','rehearsal_items','INSERT')",
      ) !== "t"
    )
      throw new Error("private_pg17_rehearsal_activation_failed");
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
    });
    return Object.freeze({
      schemaVersion: 1,
      disposable: true,
      sourceMajor: 16,
      targetMajor: 17,
      dumpSha256: sha256(dump),
      equivalenceSha256: sha256(sourceSnapshot),
      aclGateBeforeActivation: "closed",
      activationReceipt: "disposable-rehearsal",
      productionPath,
    });
  } finally {
    for (const name of createdContainers.reverse())
      docker("rm", "--force", name);
    if (networkCreated) docker("network", "rm", network);
    rmSync(directory, { force: true, recursive: true });
  }
}

async function verifyProductionPathRehearsal(facts) {
  const digest = facts.equivalenceSha256;
  const execution = {
    organization: "disposable-control",
    controlRepository: "disposable-control/releases",
    workflowPath: ".github/workflows/private-network-pg17-rollout.yml",
    workflowRef: "refs/heads/main",
    event: "workflow_dispatch",
    actor: "rehearsal",
    runId: "1",
    runAttempt: 1,
    expectedJobName: "private-job",
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
      recoveryWitnessSha256: "b".repeat(64),
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
    workflowJobName: execution.expectedJobName,
    commitSha: "d".repeat(40),
    runnerName: `rr-${lifecycle}`,
    cleanupCanary: `rr-cleanup:disposable-rehearsal:rr-${lifecycle}`,
    renderJobId: job,
    baseServiceId: "srv-disposable",
    runnerGroupId: 1,
    provenance: { kind: "image", deployId: "dep-disposable", imageSha: digest },
  });
  const roleRunner = runner("role", "job-role");
  const cutoverRunner = runner("cutover", "job-cutover");
  let tick = 0;
  const observed = (step, value = {}) => ({
    step,
    observedAt: new Date(Date.UTC(2026, 7, 12, 0, 0, tick++)).toISOString(),
    facts: value,
  });
  const sqlConfiguration = {
    roles: [
      { role: "api", username: "reviewrouter_api", password: "disposable" },
      { role: "web", username: "reviewrouter_web", password: "disposable" },
      {
        role: "worker",
        username: "reviewrouter_worker",
        password: "disposable",
      },
      {
        role: "effect-authority",
        username: "reviewrouter_codex_effect_authority",
        password: "disposable",
      },
    ],
    releasePassword: "disposable",
  };
  const generated = {
    roleBootstrapSha256: `sha256:${sha256Canonical(roleProvisioningSql(sqlConfiguration))}`,
    migrationSha256: `sha256:${sha256Canonical(runtimeGrantSql(sqlConfiguration, { gateClosed: true }))}`,
    activation: canonicalActivationSql(sqlConfiguration, {
      rolloutId: rollout.rolloutId,
      sourceSystemIdentifier: rollout.source.systemIdentifier,
      targetSystemIdentifier: rollout.target.systemIdentifier,
    }),
  };
  let provision = roleRunner;
  let cleanupStep = RolloutStep.CleanupRoleRunner;
  const ledger = {
    last: `sha256:${"0".repeat(64)}`,
    async claim() {
      return "claimed";
    },
    async compareAndSet(input) {
      if (input.expectedReceiptSha256 !== this.last) return false;
      this.last = input.nextReceiptSha256;
      return true;
    },
  };
  let evidence;
  const useCases = new ReleaseRolloutUseCases({
    provider: {
      freezeAndObserve: async () =>
        observed(RolloutStep.FreezeProviderServices, {
          services: [{ serviceId: "source-writer", suspended: true }],
          complete: true,
        }),
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
        ),
      }),
      cleanup: async () =>
        observed(cleanupStep, {
          provider: { status: "succeeded" },
          runner: {
            listenerStopped: true,
            workspaceRemoved: true,
            credentialProcessGone: true,
            canary: provision.cleanupCanary,
          },
        }),
      reconcileOrphans: async () => [],
    },
    database: {
      captureBackup: async () =>
        observed(RolloutStep.CaptureSourceBackup, {
          dumpSha256: facts.dumpSha256,
        }),
      quiesce: async () =>
        observed(RolloutStep.QuiesceSource, {
          stabilizationSeries: [0, 0, 0],
          reconnectDenied: true,
        }),
      copy: async () =>
        observed(RolloutStep.CopyDatabaseGeneration, {
          dumpSha256: facts.dumpSha256,
        }),
      verifyEquivalence: async () =>
        observed(RolloutStep.VerifyDataEquivalence, {
          equivalent: true,
          streamingHash: true,
        }),
      bootstrapTargetRoles: async () =>
        observed(RolloutStep.BootstrapTargetRoles, {
          sqlSha256: generated.roleBootstrapSha256,
        }),
      runReleaseMigration: async () =>
        observed(RolloutStep.RunReleaseMigration, {
          sqlSha256: generated.migrationSha256,
          gate: "closed",
        }),
      activate: async () =>
        observed(RolloutStep.ActivateTargetGeneration, {
          firstWriteBoundary: true,
          canonicalPrivilegesSha256:
            generated.activation.canonicalPrivilegesSha256,
          catalogFactsSha256: digest,
          firstWriteReceiptSha256: digest,
          transactionId: "1",
        }),
      compensateSource: async () =>
        observed(RolloutStep.CompleteCompensation, { aclRestored: true }),
    },
    services: {
      stageTarget: async () =>
        observed(RolloutStep.StageTargetServices, { suspended: true }),
      resumeDeployAndObserve: async () =>
        observed(RolloutStep.ResumeTargetServices, { resumed: true }),
      verifyLiveCanary: async () =>
        observed(RolloutStep.VerifyLiveCanary, { writeReadRoundTrip: true }),
    },
    evidence: {
      assembleAndVerify: async (current) => {
        const catalogSha256 = {
          sequences: digest,
          columnsDefaults: digest,
          constraintsIndexesTriggers: digest,
          policiesRls: digest,
          functionsViewsSchemas: digest,
          aclOwnershipDefaults: digest,
          migrationHistory: digest,
        };
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
            recoveryStatus: "available",
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
          protectedEnvironmentPreflightSha256: digest,
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
          assembledAt: "2026-08-12T00:01:00.000Z",
        });
        return observed(RolloutStep.VerifyTrustedRollout, {
          evidenceSha256: evidence.evidenceSha256,
        });
      },
    },
    ledger,
  });
  rollout = await useCases.claimRollout(rollout);
  rollout = await useCases.freezeProviderServices(rollout);
  ({ rollout } = await useCases.provisionPrivateRunner(rollout));
  rollout = await useCases.captureSourceBackup(rollout);
  rollout = await useCases.quiesceSource(rollout);
  rollout = await useCases.copyDatabaseGeneration(rollout);
  rollout = await useCases.verifyDataEquivalence(rollout);
  rollout = await useCases.bootstrapTargetRoles(rollout);
  rollout = await useCases.cleanupRoleRunner(rollout, roleRunner);
  provision = cutoverRunner;
  ({ rollout } = await useCases.provisionCutoverRunner(rollout));
  rollout = await useCases.runReleaseMigration(rollout);
  rollout = await useCases.stageTargetServices(rollout);
  rollout = await useCases.activateTargetGeneration(rollout);
  cleanupStep = RolloutStep.CleanupCutoverRunner;
  rollout = await useCases.cleanupCutoverRunner(rollout, cutoverRunner);
  rollout = await useCases.resumeTargetServices(rollout);
  rollout = await useCases.verifyLiveCanary(rollout);
  rollout = await useCases.verifyTrustedRollout(rollout);
  const uncertain = transitionFailure(rollout, "activation_uncertain");
  let sourceBanProven = false;
  try {
    assertPromotionAllowed(uncertain, uncertain.source.systemIdentifier);
  } catch {
    sourceBanProven = true;
  }
  if (!sourceBanProven)
    throw new Error("private_pg17_rehearsal_source_ban_unproven");
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
    generated,
    receiptCount: rollout.receipts.length,
    sourceBanProven,
    compensationProven: compensated.phase === "recovery_compensated",
    evidenceSha256: evidence.evidenceSha256,
  };
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
