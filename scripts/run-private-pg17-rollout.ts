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
  roleBootstrapRunner: RunnerIdentity;
  backup: unknown;
  quiescence: unknown;
  equivalence: unknown;
};
let rollout = copy.rollout;
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
const exactRoles = serviceExpectations.map((item) => item.databaseRole).sort();
if (
  serviceExpectations.length !== 3 ||
  new Set(serviceExpectations.map((item) => item.serviceId)).size !== 3 ||
  new Set(serviceExpectations.map((item) => item.databaseRole)).size !== 3 ||
  serviceExpectations.some(
    (item) => !sourceUrls[item.databaseRole] || !targetUrls[item.databaseRole],
  ) ||
  Object.keys(sourceUrls).sort().join("\0") !== exactRoles.join("\0") ||
  Object.keys(targetUrls).sort().join("\0") !== exactRoles.join("\0")
)
  throw new Error("private_pg17_service_environment_scope_invalid");
const protectedSourceEnvironment = Object.fromEntries(
  serviceExpectations.map((item) => [
    item.serviceId,
    {
      DATABASE_URL: sourceUrls[item.databaseRole]!,
      REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS: sourceWitness,
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
    imageUrl: `ghcr.io/777genius/review-router-saas-runtime@${required("REVIEW_ROUTER_RELEASE_IMAGE_DIGEST")}`,
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
let activation: StepObservation;
let staged: StepObservation;
const useCases = new ReleaseRolloutUseCases({
  authority,
  preflight: { observeProtectedEnvironment: unavailable },
  provider: {
    freezeAndObserve: unavailable,
    compensateAndObserve: async ({ decision, databaseWitness }) => {
      if (
        decision.decision !== "allow" ||
        decision.operation !== "resume_source" ||
        databaseWitness.sourceWritesRestored !== true
      )
        throw new Error("private_pg17_service_recovery_authority_invalid");
      await transactionalServices.finalizeAuthorizedSourceRecovery({
        source: sourceRecoveryManifest,
        protectedEnvironment: protectedSourceEnvironment,
        target: targetServiceContracts,
        restoreSourceWritesAndVerify: async () => undefined,
      });
      const restored = await ledger.read(rollout.rolloutId);
      return {
        serviceIds: sourceRecoveryManifest.services.map(
          (item) => item.serviceId,
        ),
        deployIds: sourceRecoveryManifest.services.map((service) => {
          const deployId = [...restored]
            .reverse()
            .find(
              (item) =>
                item.serviceId === service.serviceId &&
                item.step === "source_verified",
            )?.deployId;
          if (!deployId)
            throw new Error("private_pg17_source_deploy_checkpoint_missing");
          return deployId;
        }),
        observedAt: new Date().toISOString(),
        resumed: true,
      };
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
      const observation = canonical.runReleaseMigration(process.env);
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
  `${JSON.stringify({ rollout, runners: [copy.roleBootstrapRunner, cutoverRunner], backup: copy.backup, quiescence: copy.quiescence, equivalence: copy.equivalence, migration, staged, activation })}\n`,
);
