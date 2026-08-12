#!/usr/bin/env node
import { chmodSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AuthenticatedRunnerLedgerAdapter,
  PostgreSqlGenerationAdapter,
  RedactedProcessCommandAdapter,
  ReleaseRolloutUseCases,
  RenderBackupIdentityAdapter,
  type DatabaseGenerationIdentity,
  type ReleaseRollout,
  type RunnerIdentity,
  type StepObservation,
  type WriterSuspensionObservation,
} from "../packages/features/release-rollout/src/index";
import { PrivatePg17CanonicalAdapter } from "./lib/private-pg17-canonical-adapter";

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`private_pg17_copy_required:${name}`);
  return value;
};
const decode = <T>(name: string): T =>
  JSON.parse(Buffer.from(required(name), "base64url").toString("utf8")) as T;
const source: DatabaseGenerationIdentity = {
  renderResourceId: required("REVIEW_ROUTER_SOURCE_RENDER_DATABASE_ID"),
  internalHostname: required("REVIEW_ROUTER_SOURCE_INTERNAL_HOSTNAME"),
  databaseName: required("REVIEW_ROUTER_SOURCE_DATABASE_NAME"),
  systemIdentifier: required("REVIEW_ROUTER_SOURCE_DATABASE_SYSTEM_IDENTIFIER"),
  majorVersion: 16,
  recoveryWitnessSha256: required(
    "REVIEW_ROUTER_SOURCE_RECOVERY_WITNESS_SHA256",
  ),
};
const target: DatabaseGenerationIdentity = {
  renderResourceId: required("REVIEW_ROUTER_TARGET_RENDER_DATABASE_ID"),
  internalHostname: required("REVIEW_ROUTER_TARGET_INTERNAL_HOSTNAME"),
  databaseName: required("REVIEW_ROUTER_TARGET_DATABASE_NAME"),
  systemIdentifier: required("REVIEW_ROUTER_TARGET_DATABASE_SYSTEM_IDENTIFIER"),
  majorVersion: 17,
  recoveryWitnessSha256: required(
    "REVIEW_ROUTER_TARGET_RECOVERY_WITNESS_SHA256",
  ),
};
let rollout = (
  JSON.parse(
    readFileSync(required("REVIEW_ROUTER_INITIAL_ROLLOUT_FILE"), "utf8"),
  ) as { rollout: ReleaseRollout }
).rollout;
if (
  rollout.phase !== "preflight_verified" ||
  rollout.rolloutId !== required("REVIEW_ROUTER_ROLLOUT_ID") ||
  rollout.expectedCommitSha !== required("REVIEW_ROUTER_RELEASE_COMMIT_SHA") ||
  JSON.stringify(rollout.source) !== JSON.stringify(source) ||
  JSON.stringify(rollout.target) !== JSON.stringify(target)
)
  throw new Error("private_pg17_initial_rollout_mismatch");
const commands = new RedactedProcessCommandAdapter();
const database = new PostgreSqlGenerationAdapter(commands);
const sourceUrl = required("REVIEW_ROUTER_SOURCE_DATABASE_URL");
const targetUrl = required("REVIEW_ROUTER_ROLE_BOOTSTRAP_DATABASE_URL");
const freezeObservation = decode<
  StepObservation<{
    services: WriterSuspensionObservation["services"];
    complete: true;
  }>
>("REVIEW_ROUTER_FREEZE_OBSERVATION");
let backupResult: ReturnType<PostgreSqlGenerationAdapter["captureBackup"]>;
let quiescence: ReturnType<PostgreSqlGenerationAdapter["quiesceSource"]>;
let equivalence: Awaited<
  ReturnType<PostgreSqlGenerationAdapter["verifyEquivalence"]>
>;
let roleBootstrap: StepObservation;
const unavailable = async (): Promise<never> => {
  throw new Error("private_pg17_port_not_available_in_copy_phase");
};
const ledger = new AuthenticatedRunnerLedgerAdapter(
  required("REVIEW_ROUTER_RUNNER_LEDGER_URL"),
  required("REVIEW_ROUTER_RUNNER_LEDGER_TOKEN"),
);
const currentRunner = await ledger.currentRunner(rollout.rolloutId, "role");
const canonical = new PrivatePg17CanonicalAdapter();
const runner: RunnerIdentity = currentRunner.identity;
const dumpDirectory = mkdtempSync(join(required("RUNNER_TEMP"), "rr-dump-"));
chmodSync(dumpDirectory, 0o700);
const runnerObservation: StepObservation = currentRunner.observation;
const useCases = new ReleaseRolloutUseCases({
  preflight: { observeProtectedEnvironment: unavailable },
  provider: {
    freezeAndObserve: async () => freezeObservation,
    compensateAndObserve: unavailable,
  },
  runner: {
    provision: async () => ({
      identity: runner,
      observation: runnerObservation,
    }),
    cleanup: unavailable,
    reconcileOrphans: async () => [],
  },
  database: {
    captureBackup: async () => {
      database.observeIdentity(sourceUrl, source);
      database.observeIdentity(targetUrl, target);
      const backup = await new RenderBackupIdentityAdapter().capture({
        apiKey: required("RENDER_PROVENANCE_READ_API_KEY"),
        sourceDatabaseId: source.renderResourceId,
        externalWitness: JSON.parse(
          required("REVIEW_ROUTER_SOURCE_BACKUP_WITNESS_JSON"),
        ),
      });
      backupResult = database.captureBackup({
        sourceUrl,
        dumpPath: join(dumpDirectory, "source.dump"),
        backup,
      });
      if (backupResult.dumpSha256 !== backup.dumpSha256)
        throw new Error("private_pg17_dump_external_witness_mismatch");
      return backupResult.observation;
    },
    quiesce: async () => {
      quiescence = database.quiesceSource({
        adminUrl: sourceUrl,
        writerSuspension: {
          services: freezeObservation.facts.services,
          complete: true,
        },
        reconnectUrls: JSON.parse(
          required("REVIEW_ROUTER_SOURCE_RECONNECT_URLS_JSON"),
        ),
      });
      return quiescence.observation;
    },
    copy: async () =>
      database.restoreCopy({
        targetUrl,
        dumpPath: `/runner/_work/job/${rollout.rolloutId}.dump`,
        dumpSha256: backupResult.dumpSha256,
      }),
    verifyEquivalence: async () => {
      equivalence = await database.verifyEquivalence(
        sourceUrl,
        targetUrl,
        JSON.parse(
          required("REVIEW_ROUTER_APPLICATION_SCHEMAS_JSON"),
        ) as string[],
      );
      return equivalence.observation;
    },
    bootstrapTargetRoles: async () => {
      roleBootstrap = canonical.bootstrapTargetRoles(process.env);
      return roleBootstrap;
    },
    runReleaseMigration: unavailable,
    activate: unavailable,
    compensateSource: unavailable,
  },
  services: {
    stageTarget: unavailable,
    resumeDeployAndObserve: unavailable,
    verifyLiveCanary: unavailable,
  },
  evidence: { assembleAndVerify: unavailable },
  ledger,
});
rollout = await useCases.freezeProviderServices(rollout);
({ rollout } = await useCases.provisionPrivateRunner(rollout));
rollout = await useCases.captureSourceBackup(rollout);
rollout = await useCases.quiesceSource(rollout);
rollout = await useCases.copyDatabaseGeneration(rollout);
rollout = await useCases.bootstrapTargetRoles(rollout);
rollout = await useCases.verifyDataEquivalence(rollout);
process.stdout.write(
  `${JSON.stringify({ rollout, roleBootstrapRunner: runner, backup: backupResult!.backup, quiescence: quiescence!.evidence, equivalence: equivalence!.evidence, roleBootstrap: roleBootstrap!.facts })}\n`,
);
