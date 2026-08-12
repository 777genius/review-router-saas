#!/usr/bin/env node
import { readFileSync } from "node:fs";
import {
  AuthenticatedRunnerLedgerAdapter,
  ReleaseRolloutUseCases,
  RenderTargetServicesAdapter,
  RolloutPhase,
  type ReleaseRollout,
  type RunnerIdentity,
  type StepObservation,
  type TargetServiceExpectation,
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
const currentRunner = await ledger.currentRunner(rollout.rolloutId, "cutover");
const cutoverRunner = currentRunner.identity;
const cutoverProvision = currentRunner.observation;
const roleCleanup = await ledger.cleanupObservation(
  copy.roleBootstrapRunner.renderJobId,
);
const targetAdapter = new RenderTargetServicesAdapter();
const canonical = new PrivatePg17CanonicalAdapter();
const unavailable = async (): Promise<never> => {
  throw new Error("private_pg17_port_not_available_in_cutover_phase");
};
let migration: unknown;
let activation: StepObservation;
let staged: StepObservation;
const useCases = new ReleaseRolloutUseCases({
  preflight: { observeProtectedEnvironment: unavailable },
  provider: {
    freezeAndObserve: unavailable,
    compensateAndObserve: unavailable,
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
    activate: async (_source, _target, fence) => {
      activation = canonical.activateTarget(process.env, fence);
      return activation;
    },
    compensateSource: unavailable,
  },
  services: {
    stageTarget: async (fence) => {
      staged = await targetAdapter.stage({
        apiKey: required("RENDER_TARGET_SWITCH_API_KEY"),
        targetInternalHostname: rollout.target.internalHostname,
        targetSystemIdentifier: rollout.target.systemIdentifier,
        targetDatabaseUrls: JSON.parse(
          required("REVIEW_ROUTER_TARGET_DATABASE_URLS_JSON"),
        ) as Record<string, string>,
        releaseCommitSha: rollout.expectedCommitSha,
        services: JSON.parse(
          required("REVIEW_ROUTER_TARGET_SERVICE_EXPECTATIONS_JSON"),
        ) as TargetServiceExpectation[],
        fence,
      });
      return staged;
    },
    resumeDeployAndObserve: unavailable,
    verifyLiveCanary: unavailable,
  },
  evidence: { assembleAndVerify: unavailable },
  ledger,
});
rollout = await useCases.cleanupRoleRunner(rollout, copy.roleBootstrapRunner);
({ rollout } = await useCases.provisionCutoverRunner(rollout));
rollout = await useCases.runReleaseMigration(rollout);
rollout = await useCases.stageTargetServices(rollout);
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
