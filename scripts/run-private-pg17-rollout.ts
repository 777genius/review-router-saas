#!/usr/bin/env node
import { readFileSync } from "node:fs";
import {
  AuthenticatedRunnerLedgerAdapter,
  HttpProviderAuthorityDecisionAdapter,
  PostgreSqlGenerationAdapter,
  RedactedProcessCommandAdapter,
  ReleaseRolloutUseCases,
  RenderTransactionalServicesAdapter,
  TransactionalServiceCutover,
  RolloutPhase,
  type ReleaseRollout,
  type RunnerIdentity,
  type StepObservation,
  type ProtectedSourceEnvironment,
  type TargetServiceContract,
  type TargetServiceExpectation,
  targetServiceContractSha256,
  assertVerifiedReleaseImageProvenance,
  sameReleaseImageProvenance,
  type VerifiedReleaseImageProvenance,
} from "../packages/features/release-rollout/src/index";
import { PrivatePg17CanonicalAdapter } from "./lib/private-pg17-canonical-adapter";

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`private_pg17_rollout_required:${name}`);
  return value;
};
const copy = JSON.parse(
  readFileSync(required("REVIEW_ROUTER_COPY_BOOTSTRAP_EVIDENCE_FILE"), "utf8"),
) as {
  rollout: ReleaseRollout;
  releaseImageProvenance: VerifiedReleaseImageProvenance;
  roleBootstrapRunner: RunnerIdentity;
  backup: unknown;
  quiescence: unknown;
  equivalence: unknown;
};
let rollout = copy.rollout;
const releaseImageProvenance = assertVerifiedReleaseImageProvenance(
  copy.releaseImageProvenance,
  {
    repository: required("GITHUB_REPOSITORY"),
    commit: required("REVIEW_ROUTER_RELEASE_COMMIT_SHA"),
  },
);
const preflightReleaseImageProvenance = assertVerifiedReleaseImageProvenance(
  JSON.parse(
    readFileSync(
      required("REVIEW_ROUTER_RELEASE_IMAGE_PROVENANCE_FILE"),
      "utf8",
    ),
  ) as VerifiedReleaseImageProvenance,
  {
    repository: required("GITHUB_REPOSITORY"),
    commit: required("REVIEW_ROUTER_RELEASE_COMMIT_SHA"),
  },
);
if (
  !sameReleaseImageProvenance(
    releaseImageProvenance,
    preflightReleaseImageProvenance,
  )
)
  throw new Error("private_pg17_release_image_provenance_transplanted");
const canonicalReleaseEnvironment = {
  ...process.env,
  REVIEW_ROUTER_RELEASE_COMMIT_SHA: releaseImageProvenance.identity.commit,
  REVIEW_ROUTER_RELEASE_IMAGE_DIGEST:
    releaseImageProvenance.identity.imageDigest,
};
if (
  rollout.phase !== RolloutPhase.TargetRolesBootstrapped ||
  rollout.rolloutId !== required("REVIEW_ROUTER_ROLLOUT_ID") ||
  rollout.expectedCommitSha !== required("REVIEW_ROUTER_RELEASE_COMMIT_SHA")
)
  throw new Error("private_pg17_rollout_copy_evidence_mismatch");
const ledger = new AuthenticatedRunnerLedgerAdapter(
  required("REVIEW_ROUTER_RUNNER_LEDGER_URL"),
  required("REVIEW_ROUTER_RUNNER_LEDGER_TOKEN"),
);
const authority = new HttpProviderAuthorityDecisionAdapter(
  required("REVIEW_ROUTER_PROVIDER_AUTHORITY_URL"),
  required("REVIEW_ROUTER_PROVIDER_AUTHORITY_TOKEN"),
);
const currentRunner = await ledger.currentRunner(rollout.rolloutId, "cutover");
const cutoverRunner = currentRunner.identity;
const cutoverProvision = currentRunner.observation;
const roleCleanup = await ledger.cleanupObservation(
  copy.roleBootstrapRunner.renderJobId,
);
const serviceExpectations = JSON.parse(
  required("REVIEW_ROUTER_TARGET_SERVICE_EXPECTATIONS_JSON"),
) as TargetServiceExpectation[];
const sourceUrls = JSON.parse(
  required("REVIEW_ROUTER_SOURCE_RECONNECT_URLS_JSON"),
) as Record<string, string>;
const targetUrls = JSON.parse(
  required("REVIEW_ROUTER_TARGET_DATABASE_URLS_JSON"),
) as Record<string, string>;
const sourceWitness = required("REVIEW_ROUTER_SOURCE_RECOVERY_WITNESS");
const sourceWitnessSha256 = required(
  "REVIEW_ROUTER_SOURCE_RECOVERY_WITNESS_SHA256",
);
const targetWitnessSha256 = required(
  "REVIEW_ROUTER_TARGET_RECOVERY_WITNESS_SHA256",
);
const serviceRoles = [
  "reviewrouter_api",
  "reviewrouter_web",
  "reviewrouter_worker",
].sort();
const reconnectRoles = [
  ...serviceRoles,
  "reviewrouter_codex_effect_authority",
].sort();
const targetEffectAuthorityUrl = required(
  "REVIEW_ROUTER_CODEX_EFFECT_AUTHORITY_DATABASE_URL",
);
if (
  serviceExpectations.length !== 3 ||
  new Set(serviceExpectations.map((item) => item.serviceId)).size !== 3 ||
  new Set(serviceExpectations.map((item) => item.databaseRole)).size !== 3 ||
  serviceExpectations.some(
    (item) => !sourceUrls[item.databaseRole] || !targetUrls[item.databaseRole],
  ) ||
  serviceExpectations
    .map((item) => item.databaseRole)
    .sort()
    .join("\0") !== serviceRoles.join("\0") ||
  Object.keys(sourceUrls).sort().join("\0") !== reconnectRoles.join("\0") ||
  Object.keys(targetUrls).sort().join("\0") !== serviceRoles.join("\0")
)
  throw new Error("private_pg17_service_environment_scope_invalid");
const protectedSourceEnvironment = Object.fromEntries(
  serviceExpectations.map((item) => [
    item.serviceId,
    {
      DATABASE_URL: sourceUrls[item.databaseRole]!,
      REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS: sourceWitness,
      REVIEW_ROUTER_EXPECTED_RECOVERY_WITNESS_SHA256: sourceWitnessSha256,
      ...(["reviewrouter_api", "reviewrouter_web"].includes(item.databaseRole)
        ? {
            REVIEW_ROUTER_CODEX_EFFECT_AUTHORITY_DATABASE_URL:
              sourceUrls.reviewrouter_codex_effect_authority!,
          }
        : {}),
    },
  ]),
) as ProtectedSourceEnvironment;
const renderServices = new RenderTransactionalServicesAdapter(
  required("RENDER_TARGET_SWITCH_API_KEY"),
);
const sourceRecoveryManifest = await renderServices.captureSourceManifest({
  rolloutId: rollout.rolloutId,
  services: serviceExpectations.map(
    ({ serviceId, databaseEnvKey, databaseRole }) => ({
      serviceId,
      databaseEnvKey,
      databaseRole,
    }),
  ),
  protectedEnvironment: protectedSourceEnvironment,
});
const rolloutStartedAt = new Date().toISOString();
const targetServiceContracts: TargetServiceContract[] = [];
for (const expectation of serviceExpectations) {
  const sourceContract = sourceRecoveryManifest.services.find(
    (item) => item.serviceId === expectation.serviceId,
  )!;
  const environmentDelta = {
    DATABASE_URL: targetUrls[expectation.databaseRole]!,
    REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS: required(
      "REVIEW_ROUTER_TARGET_RECOVERY_WITNESS",
    ),
    REVIEW_ROUTER_EXPECTED_RECOVERY_WITNESS_SHA256: targetWitnessSha256,
    ...(["reviewrouter_api", "reviewrouter_web"].includes(
      expectation.databaseRole,
    )
      ? {
          REVIEW_ROUTER_CODEX_EFFECT_AUTHORITY_DATABASE_URL:
            targetEffectAuthorityUrl,
        }
      : {}),
    REVIEW_ROUTER_RUNTIME_RELEASE_COMMIT_SHA: rollout.expectedCommitSha,
    REVIEW_ROUTER_RUNTIME_ROLLOUT_ID: rollout.rolloutId,
    REVIEW_ROUTER_RUNTIME_ROLLOUT_STARTED_AT: rolloutStartedAt,
  };
  if (!environmentDelta.DATABASE_URL)
    throw new Error("private_pg17_target_database_url_missing");
  const planned = await renderServices.planEnvironmentDelta({
    serviceId: expectation.serviceId,
    set: environmentDelta,
    remove: [],
    expectedBeforeSha256: sourceContract.sourceEnvSha256,
  });
  const value = {
    serviceId: expectation.serviceId,
    imageUrl: releaseImageProvenance.identity.imageUrl,
    environmentDelta,
    removeKeys: [] as string[],
    environmentSha256: planned.environmentSha256,
  };
  targetServiceContracts.push({
    ...value,
    serviceContractSha256: targetServiceContractSha256(value),
  });
}
const transactionalServices = new TransactionalServiceCutover(
  ledger,
  renderServices,
);
const generation = new PostgreSqlGenerationAdapter(
  new RedactedProcessCommandAdapter(),
);
const canonical = new PrivatePg17CanonicalAdapter();
const unavailable = async (): Promise<never> => {
  throw new Error("private_pg17_port_not_available_in_cutover_phase");
};
let migration: unknown;
let activation!: StepObservation;
let staged!: StepObservation;
const useCases = new ReleaseRolloutUseCases({
  authority,
  preflight: { observeProtectedEnvironment: unavailable },
  provider: {
    freezeAndObserve: unavailable,
    compensateAndObserve: async ({
      decision,
      databaseWitness,
      sourceWriterServiceIds,
    }) => {
      if (
        decision.decision !== "allow" ||
        decision.operation !== "resume_source" ||
        databaseWitness.sourceWritesRestored !== true
      )
        throw new Error("private_pg17_service_recovery_authority_invalid");
      return await transactionalServices.finalizeAuthorizedSourceRecovery({
        source: sourceRecoveryManifest,
        protectedEnvironment: protectedSourceEnvironment,
        target: targetServiceContracts,
        sourceWriterServiceIds,
        restoreSourceWritesAndVerify: async () => undefined,
      });
    },
  },
  runner: {
    provision: async () => ({
      identity: cutoverRunner,
      observation: cutoverProvision,
    }),
    cleanup: async () => roleCleanup,
    reconcileOrphans: async () => {
      await ledger.reconcileRollout(rollout.rolloutId);
      return [];
    },
  },
  database: {
    captureBackup: unavailable,
    quiesce: unavailable,
    copy: unavailable,
    verifyEquivalence: unavailable,
    bootstrapTargetRoles: unavailable,
    runReleaseMigration: async () => {
      const observation = canonical.runReleaseMigration(
        canonicalReleaseEnvironment,
      );
      migration = observation.facts;
      return observation;
    },
    activate: async (rolloutId) => {
      activation = canonical.activateTarget(process.env, rolloutId);
      return activation;
    },
    compensateSource: async () => {
      if ((await ledger.read(rollout.rolloutId)).length > 0)
        await transactionalServices.recover({
          source: sourceRecoveryManifest,
          protectedEnvironment: protectedSourceEnvironment,
          target: targetServiceContracts,
        });
      return generation.compensateSource({
        adminUrl: required("REVIEW_ROUTER_SOURCE_DATABASE_URL"),
        source: rollout.source,
        reconnectUrls: JSON.parse(
          required("REVIEW_ROUTER_SOURCE_RECONNECT_URLS_JSON"),
        ) as Record<string, string>,
      });
    },
  },
  services: {
    stageTarget: async (fence, decision) => {
      if (
        decision.decision !== "allow" ||
        decision.operation !== "deploy_target" ||
        decision.rolloutId !== fence.rolloutId ||
        decision.sourceSystemIdentifier !== fence.sourceSystemIdentifier ||
        decision.targetSystemIdentifier !== fence.targetSystemIdentifier ||
        decision.expectedReceiptSha256 !== fence.previousReceiptSha256 ||
        decision.activationBoundary !== "before"
      )
        throw new Error("private_pg17_target_stage_authority_denied");
      const deployIds = await transactionalServices.stage({
        source: sourceRecoveryManifest,
        protectedEnvironment: protectedSourceEnvironment,
        target: targetServiceContracts,
      });
      staged = {
        step: "stage_target_services" as never,
        observedAt: new Date().toISOString(),
        facts: deployIds.map((deployId, index) => ({
          serviceId: targetServiceContracts[index]!.serviceId,
          deployId,
          provenance: {
            kind: "image",
            imageSha: targetServiceContracts[index]!.imageUrl.slice(
              targetServiceContracts[index]!.imageUrl.indexOf("sha256:"),
            ),
          },
          envSha256: targetServiceContracts[index]!.environmentSha256,
          recoveryWitnessSha256: required(
            "REVIEW_ROUTER_TARGET_RECOVERY_WITNESS_SHA256",
          ),
          suspended: true,
        })),
        provider: {
          renderServiceIds: targetServiceContracts.map(
            (item) => item.serviceId,
          ),
          renderDeployIds: deployIds,
          serviceRecoveryManifestSha256: sourceRecoveryManifest.manifestSha256,
          targetServiceContractSha256: await (async () => {
            const checkpoints = await ledger.read(rollout.rolloutId);
            const hash = checkpoints.at(-1)?.targetContractSha256;
            if (!hash)
              throw new Error(
                "private_pg17_target_contract_checkpoint_missing",
              );
            return hash;
          })(),
          targetSwitchFenceNonce: fence.nonce,
          targetSwitchFenceVersion: fence.version,
        },
      };
      return staged;
    },
    resumeDeployAndObserve: unavailable,
    verifyLiveCanary: unavailable,
  },
  evidence: { assembleAndVerify: unavailable },
  ledger,
});
try {
  rollout = await useCases.cleanupRoleRunner(rollout, copy.roleBootstrapRunner);
  ({ rollout } = await useCases.provisionCutoverRunner(rollout));
  rollout = await useCases.runReleaseMigration(rollout);
  rollout = await useCases.stageTargetServices(rollout);
} catch (error) {
  try {
    rollout = await useCases.recoverFromFailure(
      rollout,
      "definite_pre_activation",
    );
  } catch (compensationError) {
    throw new AggregateError(
      [error, compensationError],
      "private_pg17_cutover_failed_and_compensation_incomplete",
      { cause: compensationError },
    );
  }
  throw new Error("private_pg17_cutover_failed_source_compensated", {
    cause: error,
  });
}
try {
  rollout = await useCases.activateTargetGeneration(
    rollout,
    cutoverRunner.workflowJobId,
  );
} catch (error) {
  rollout = await useCases.recoverFromFailure(rollout, "activation_uncertain");
  throw new Error(
    `private_pg17_activation_uncertain:${error instanceof Error ? error.message : "unknown"}`,
    { cause: error },
  );
}
process.stdout.write(
  `${JSON.stringify({ rollout, releaseImageProvenance, runners: [copy.roleBootstrapRunner, cutoverRunner], backup: copy.backup, quiescence: copy.quiescence, equivalence: copy.equivalence, migration, staged, activation })}\n`,
);
