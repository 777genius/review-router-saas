#!/usr/bin/env node
import { readFileSync } from "node:fs";
import {
  assembleTrustedRolloutEvidence,
  AuthenticatedRunnerLedgerAdapter,
  HttpProviderAuthorityDecisionAdapter,
  ReleaseRolloutUseCases,
  RenderTargetServicesAdapter,
  RolloutStep,
  sha256Canonical,
  type CleanupEvidence,
  type ReleaseRollout,
  type RunnerIdentity,
  type StepObservation,
  type TargetServiceExpectation,
  type TrustedRolloutEvidence,
  assertVerifiedReleaseImageProvenance,
  sameReleaseImageProvenance,
  type VerifiedReleaseImageProvenance,
} from "../packages/features/release-rollout/src/index";

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`private_pg17_finalize_required:${name}`);
  return value;
};
const read = <T>(name: string): T =>
  JSON.parse(readFileSync(required(name), "utf8")) as T;
const body = read<{
  rollout: ReleaseRollout;
  releaseImageProvenance: VerifiedReleaseImageProvenance;
  runners: [RunnerIdentity, RunnerIdentity];
  backup: TrustedRolloutEvidence["backup"];
  quiescence: TrustedRolloutEvidence["quiescence"];
  equivalence: TrustedRolloutEvidence["equivalence"];
  staged: StepObservation<
    readonly {
      serviceId: string;
      deployId: string;
      provenance: { kind: "image"; imageSha: string };
    }[]
  >;
  migration: {
    legacyReconciliation: TrustedRolloutEvidence["legacyReconciliation"];
  };
}>("REVIEW_ROUTER_PRIVATE_ROLLOUT_BODY_FILE");
const releaseImageProvenance = assertVerifiedReleaseImageProvenance(
  body.releaseImageProvenance,
  {
    sourceRepository: required("GITHUB_REPOSITORY"),
    sourceRevision: body.rollout.expectedCommitSha,
  },
);
const preflightReleaseImageProvenance = assertVerifiedReleaseImageProvenance(
  read<VerifiedReleaseImageProvenance>(
    "REVIEW_ROUTER_RELEASE_IMAGE_PROVENANCE_FILE",
  ),
  {
    sourceRepository: required("GITHUB_REPOSITORY"),
    sourceRevision: body.rollout.expectedCommitSha,
  },
);
if (
  !sameReleaseImageProvenance(
    releaseImageProvenance,
    preflightReleaseImageProvenance,
  )
)
  throw new Error("private_pg17_release_image_provenance_transplanted");
const targetDeploys = body.staged.facts.map((deploy) => ({
  serviceId: deploy.serviceId,
  deployId: deploy.deployId,
  imageDigest: deploy.provenance.imageSha,
}));
if (
  targetDeploys.length === 0 ||
  targetDeploys.some(
    (deploy) =>
      deploy.imageDigest !== releaseImageProvenance.identity.imageDigest,
  )
)
  throw new Error("private_pg17_staged_release_image_mismatch");
const preflight = read<Record<string, unknown>>(
  "REVIEW_ROUTER_PROTECTED_ENVIRONMENT_PREFLIGHT_FILE",
);
const expectations = JSON.parse(
  required("REVIEW_ROUTER_TARGET_SERVICE_EXPECTATIONS_JSON"),
) as TargetServiceExpectation[];
const render = new RenderTargetServicesAdapter();
const ledger = new AuthenticatedRunnerLedgerAdapter(
  required("REVIEW_ROUTER_RUNNER_LEDGER_URL"),
  required("REVIEW_ROUTER_RUNNER_LEDGER_TOKEN"),
);
const authority = new HttpProviderAuthorityDecisionAdapter(
  required("REVIEW_ROUTER_PROVIDER_AUTHORITY_URL"),
  required("REVIEW_ROUTER_PROVIDER_AUTHORITY_TOKEN"),
);
const roleCleanupWitness = await ledger.observe(
  body.runners[0].renderJobId,
  body.runners[0].cleanupCanary,
);
const cutoverCleanupWitness = await ledger.observe(
  body.runners[1].renderJobId,
  body.runners[1].cleanupCanary,
);
const cutoverCleanupObservation: StepObservation = {
  step: RolloutStep.CleanupCutoverRunner,
  observedAt: cutoverCleanupWitness.observedAt,
  facts: {
    providerStatus: cutoverCleanupWitness.providerStatus,
    listenerStopped: cutoverCleanupWitness.listenerStopped,
    workspaceRemoved: cutoverCleanupWitness.workspaceRemoved,
    credentialProcessGone: cutoverCleanupWitness.credentialProcessGone,
    canary: cutoverCleanupWitness.canary,
  },
  provider: { renderJobId: body.runners[1].renderJobId },
};
let rollout = body.rollout;
const preflightReceipt = rollout.receipts.find(
  (receipt) => receipt.step === RolloutStep.VerifyProtectedEnvironment,
);
if (
  !preflightReceipt ||
  preflightReceipt.observationSha256 !== `sha256:${sha256Canonical(preflight)}`
)
  throw new Error("private_pg17_preflight_receipt_binding_invalid");
let resumed: StepObservation<
  readonly { serviceId: string; deployId: string; resumed: true }[]
>;
let canary: StepObservation;
let evidence: TrustedRolloutEvidence;
const unavailable = async (): Promise<never> => {
  throw new Error("private_pg17_port_not_available_in_finalize_phase");
};
const cleanupEvidence = (
  witness: Awaited<ReturnType<AuthenticatedRunnerLedgerAdapter["observe"]>>,
  runner: RunnerIdentity,
): CleanupEvidence => {
  return {
    renderJobId: runner.renderJobId,
    providerStatus: witness.providerStatus,
    listenerStopped: witness.listenerStopped,
    workspaceRemoved: witness.workspaceRemoved,
    credentialProcessGone: witness.credentialProcessGone,
    cleanupCanary: witness.canary,
    observedAt: witness.observedAt,
  };
};
const useCases = new ReleaseRolloutUseCases({
  authority,
  preflight: { observeProtectedEnvironment: unavailable },
  provider: {
    freezeAndObserve: unavailable,
    compensateAndObserve: unavailable,
  },
  runner: {
    provision: unavailable,
    cleanup: async () => cutoverCleanupObservation,
    reconcileOrphans: async () => [],
  },
  database: {
    captureBackup: unavailable,
    quiesce: unavailable,
    copy: unavailable,
    verifyEquivalence: unavailable,
    bootstrapTargetRoles: unavailable,
    runReleaseMigration: unavailable,
    activate: unavailable,
    compensateSource: unavailable,
  },
  services: {
    stageTarget: unavailable,
    resumeDeployAndObserve: async (decision) => {
      resumed = (await render.resumeDeployAndObserve({
        apiKey: required("RENDER_SERVICE_SUSPENSION_API_KEY"),
        services: expectations,
        rolloutId: rollout.rolloutId,
        sourceSystemIdentifier: rollout.source.systemIdentifier,
        targetSystemIdentifier: rollout.target.systemIdentifier,
        expectedReceiptSha256: rollout.receipts.at(-1)!.receiptSha256,
        decision,
      })) as typeof resumed;
      return resumed;
    },
    verifyLiveCanary: async () => {
      canary = await render.verifyLiveCanary({
        url: required("REVIEW_ROUTER_LIVE_CANARY_URL"),
        expectedCommitSha: rollout.expectedCommitSha,
        expectedSystemIdentifier: rollout.target.systemIdentifier,
        expectedRecoveryWitnessSha256: required(
          "REVIEW_ROUTER_TARGET_RECOVERY_WITNESS_SHA256",
        ),
        rolloutId: rollout.rolloutId,
        bearerToken: required("REVIEW_ROUTER_LIVE_CANARY_TOKEN"),
      });
      return canary;
    },
  },
  evidence: {
    assembleAndVerify: async (current) => {
      evidence = assembleTrustedRolloutEvidence({
        rolloutId: current.rolloutId,
        releaseCommitSha: current.expectedCommitSha,
        releaseImageProvenance,
        targetDeploys,
        execution: current.execution,
        runners: body.runners,
        source: current.source,
        target: current.target,
        backup: body.backup,
        quiescence: body.quiescence,
        equivalence: body.equivalence,
        legacyReconciliation: body.migration.legacyReconciliation,
        protectedEnvironmentPreflightSha256: preflightReceipt.observationSha256,
        receipts: current.receipts,
        activation: current.activationReceipt!,
        resumedTargetDeployIds: resumed.facts.map((item) => item.deployId),
        liveCanarySha256: `sha256:${sha256Canonical(canary.facts)}`,
        cleanups: [
          cleanupEvidence(roleCleanupWitness, body.runners[0]),
          cleanupEvidence(cutoverCleanupWitness, body.runners[1]),
        ],
        assembledAt: new Date().toISOString(),
      });
      return {
        step: RolloutStep.VerifyTrustedRollout,
        observedAt: new Date().toISOString(),
        facts: { evidenceSha256: evidence.evidenceSha256 },
      };
    },
  },
  ledger,
});
rollout = await useCases.cleanupCutoverRunner(rollout, body.runners[1]);
rollout = await useCases.resumeTargetServices(rollout);
rollout = await useCases.verifyLiveCanary(rollout);
rollout = await useCases.verifyTrustedRollout(rollout);
process.stdout.write(
  `${JSON.stringify({ evidence: evidence!, finalReceipt: rollout.receipts.at(-1), phase: rollout.phase })}\n`,
);
