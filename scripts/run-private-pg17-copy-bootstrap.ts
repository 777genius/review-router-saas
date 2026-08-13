#!/usr/bin/env node
import { chmodSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AuthenticatedRunnerLedgerAdapter,
  HttpProviderAuthorityDecisionAdapter,
  PostgreSqlGenerationAdapter,
  RedactedProcessCommandAdapter,
  ReleaseRolloutUseCases,
  RenderBackupIdentityAdapter,
  RenderProviderFreezeAdapter,
  type DatabaseGenerationIdentity,
  type ReleaseRollout,
  type RunnerIdentity,
  type StepObservation,
  type WriterSuspensionObservation,
  assertVerifiedReleaseImageProvenance,
  type VerifiedReleaseImageProvenance,
} from "../packages/features/release-rollout/src/index";
import { PrivatePg17CanonicalAdapter } from "./lib/private-pg17-canonical-adapter";
import { executePrivatePg17GenerationBinding } from "./initialize-private-pg17-generation-binding.mjs";

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
const initial = JSON.parse(
  readFileSync(required("REVIEW_ROUTER_INITIAL_ROLLOUT_FILE"), "utf8"),
) as {
  rollout: ReleaseRollout;
  releaseImageProvenance: VerifiedReleaseImageProvenance;
};
let rollout = initial.rollout;
const releaseImageProvenance = assertVerifiedReleaseImageProvenance(
  initial.releaseImageProvenance,
  {
    repository: required("GITHUB_REPOSITORY"),
    commit: required("REVIEW_ROUTER_RELEASE_COMMIT_SHA"),
  },
);
const canonicalReleaseEnvironment = {
  ...process.env,
  REVIEW_ROUTER_RELEASE_COMMIT_SHA: releaseImageProvenance.identity.commit,
  REVIEW_ROUTER_RELEASE_IMAGE_DIGEST:
    releaseImageProvenance.identity.imageDigest,
};
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
let generationBinding: StepObservation;
const unavailable = async (): Promise<never> => {
  throw new Error("private_pg17_port_not_available_in_copy_phase");
};
const ledger = new AuthenticatedRunnerLedgerAdapter(
  required("REVIEW_ROUTER_RUNNER_LEDGER_URL"),
  required("REVIEW_ROUTER_RUNNER_LEDGER_TOKEN"),
);
const authority = new HttpProviderAuthorityDecisionAdapter(
  required("REVIEW_ROUTER_PROVIDER_AUTHORITY_URL"),
  required("REVIEW_ROUTER_PROVIDER_AUTHORITY_TOKEN"),
);
const provider = new RenderProviderFreezeAdapter();
const currentRunner = await ledger.currentRunner(rollout.rolloutId, "role");
const canonical = new PrivatePg17CanonicalAdapter();
const runner: RunnerIdentity = currentRunner.identity;
const dumpDirectory = mkdtempSync(join(required("RUNNER_TEMP"), "rr-dump-"));
chmodSync(dumpDirectory, 0o700);
const dumpPath = join(dumpDirectory, "source.dump");
const runnerObservation: StepObservation = currentRunner.observation;
const useCases = new ReleaseRolloutUseCases({
  authority,
  preflight: { observeProtectedEnvironment: unavailable },
  provider: {
    freezeAndObserve: async () => freezeObservation,
    compensateAndObserve: async ({
      decision,
      databaseWitness,
      sourceWriterServiceIds,
    }) =>
      await provider.compensateAndObserve({
        apiKey: required("RENDER_SERVICE_SUSPENSION_API_KEY"),
        sourceWriterServiceIds,
        sourceSystemIdentifier: source.systemIdentifier,
        decision,
        databaseWitness,
      }),
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
      database.observeTargetBeforeBinding(targetUrl, target);
      const backup = await new RenderBackupIdentityAdapter().capture({
        apiKey: required("RENDER_PROVENANCE_READ_API_KEY"),
        sourceDatabaseId: source.renderResourceId,
        externalWitness: JSON.parse(
          required("REVIEW_ROUTER_SOURCE_BACKUP_WITNESS_JSON"),
        ),
      });
      backupResult = database.captureBackup({
        sourceUrl,
        dumpPath,
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
        dumpPath,
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
      generationBinding = executePrivatePg17GenerationBinding(
        process.env,
        commands,
      );
      roleBootstrap = canonical.bootstrapTargetRoles(
        canonicalReleaseEnvironment,
      );
      return roleBootstrap;
    },
    runReleaseMigration: unavailable,
    activate: unavailable,
    compensateSource: async () =>
      database.compensateSource({
        adminUrl: sourceUrl,
        source,
        reconnectUrls: JSON.parse(
          required("REVIEW_ROUTER_SOURCE_RECONNECT_URLS_JSON"),
        ) as Record<string, string>,
      }),
  },
  services: {
    stageTarget: unavailable,
    resumeDeployAndObserve: unavailable,
    verifyLiveCanary: unavailable,
  },
  evidence: { assembleAndVerify: unavailable },
  ledger,
});
try {
  rollout = await useCases.freezeProviderServices(rollout);
  ({ rollout } = await useCases.provisionPrivateRunner(rollout));
  rollout = await useCases.captureSourceBackup(rollout);
  rollout = await useCases.quiesceSource(rollout);
  rollout = await useCases.copyDatabaseGeneration(rollout);
  rollout = await useCases.bootstrapTargetRoles(rollout);
  rollout = await useCases.verifyDataEquivalence(rollout);
} catch (error) {
  try {
    rollout = await useCases.recoverFromFailure(
      rollout,
      "definite_pre_activation",
    );
  } catch (compensationError) {
    throw new AggregateError(
      [error, compensationError],
      "private_pg17_copy_failed_and_compensation_incomplete",
      { cause: compensationError },
    );
  }
  throw new Error("private_pg17_copy_failed_source_compensated", {
    cause: error,
  });
}
process.stdout.write(
  `${JSON.stringify({ rollout, releaseImageProvenance, roleBootstrapRunner: runner, backup: backupResult!.backup, quiescence: quiescence!.evidence, equivalence: equivalence!.evidence, generationBinding: generationBinding!.facts, roleBootstrap: roleBootstrap!.facts })}\n`,
);
