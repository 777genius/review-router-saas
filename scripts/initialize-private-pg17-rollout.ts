#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import {
  AuthenticatedRunnerLedgerAdapter,
  createReleaseRollout,
  assertVerifiedReleaseImageProvenance,
  ReleaseRolloutUseCases,
  RolloutStep,
  type DatabaseGenerationIdentity,
  type StepObservation,
  type VerifiedReleaseImageProvenance,
} from "../packages/features/release-rollout/src/index";
import { privatePg17ReleaseImagePolicy } from "./lib/private-pg17-release-image-policy";

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`private_pg17_initialize_missing:${name}`);
  return value;
};
const generation = (kind: "SOURCE" | "TARGET"): DatabaseGenerationIdentity => ({
  renderResourceId: required(`REVIEW_ROUTER_${kind}_RENDER_DATABASE_ID`),
  internalHostname: required(`REVIEW_ROUTER_${kind}_INTERNAL_HOSTNAME`),
  databaseName: required(`REVIEW_ROUTER_${kind}_DATABASE_NAME`),
  systemIdentifier: required(
    `REVIEW_ROUTER_${kind}_DATABASE_SYSTEM_IDENTIFIER`,
  ),
  majorVersion: kind === "SOURCE" ? 16 : 17,
  recoveryWitnessSha256: required(
    `REVIEW_ROUTER_${kind}_RECOVERY_WITNESS_SHA256`,
  ),
});
const preflight = JSON.parse(
  readFileSync(
    required("REVIEW_ROUTER_PROTECTED_ENVIRONMENT_PREFLIGHT_FILE"),
    "utf8",
  ),
) as Record<string, unknown>;
const { observationSha256, ...observedFacts } = preflight;
const expectedPreflightDigest = `sha256:${createHash("sha256")
  .update(JSON.stringify(observedFacts))
  .digest("hex")}`;
if (observationSha256 !== expectedPreflightDigest)
  throw new Error("private_pg17_preflight_digest_mismatch");
const trustedImagePolicy = privatePg17ReleaseImagePolicy({
  sourceRepository: required("REVIEW_ROUTER_RELEASE_CONTROL_REPOSITORY"),
  sourceRevision: required("REVIEW_ROUTER_EXPECTED_SHA"),
});
const releaseImageProvenance = assertVerifiedReleaseImageProvenance(
  JSON.parse(
    readFileSync(
      required("REVIEW_ROUTER_RELEASE_IMAGE_PROVENANCE_FILE"),
      "utf8",
    ),
  ) as VerifiedReleaseImageProvenance,
  trustedImagePolicy,
);

let rollout = createReleaseRollout({
  rolloutId: required("REVIEW_ROUTER_ROLLOUT_ID"),
  expectedCommitSha: required("REVIEW_ROUTER_EXPECTED_SHA"),
  execution: {
    organization: required("REVIEW_ROUTER_RELEASE_CONTROL_ORG"),
    controlRepository: required("REVIEW_ROUTER_RELEASE_CONTROL_REPOSITORY"),
    workflowPath: required("REVIEW_ROUTER_RELEASE_CONTROL_WORKFLOW_PATH"),
    workflowRef: required("GITHUB_REF") as "refs/heads/main",
    event: required("GITHUB_EVENT_NAME") as "workflow_dispatch",
    actor: required("GITHUB_ACTOR"),
    runId: required("GITHUB_RUN_ID"),
    runAttempt: Number(required("GITHUB_RUN_ATTEMPT")),
    roleJobName: required("REVIEW_ROUTER_ROLE_WORKFLOW_JOB_NAME"),
    cutoverJobName: required("REVIEW_ROUTER_CUTOVER_WORKFLOW_JOB_NAME"),
  },
  source: generation("SOURCE"),
  target: generation("TARGET"),
});
const unavailable = async (): Promise<never> => {
  throw new Error("private_pg17_port_not_available_in_initialize_phase");
};
const ledger = new AuthenticatedRunnerLedgerAdapter(
  required("REVIEW_ROUTER_RUNNER_LEDGER_URL"),
  required("REVIEW_ROUTER_RUNNER_LEDGER_TOKEN"),
);
const preflightObservation: StepObservation = {
  step: RolloutStep.VerifyProtectedEnvironment,
  observedAt: new Date().toISOString(),
  facts: preflight,
};
const useCases = new ReleaseRolloutUseCases({
  preflight: { observeProtectedEnvironment: async () => preflightObservation },
  provider: {
    freezeAndObserve: unavailable,
    compensateAndObserve: unavailable,
  },
  runner: {
    provision: unavailable,
    cleanup: unavailable,
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
    resumeDeployAndObserve: unavailable,
    verifyLiveCanary: unavailable,
  },
  evidence: { assembleAndVerify: unavailable },
  ledger,
});
rollout = await useCases.claimRollout(rollout);
rollout = await useCases.verifyProtectedEnvironment(rollout);
writeFileSync(
  required("REVIEW_ROUTER_INITIAL_ROLLOUT_FILE"),
  `${JSON.stringify({ rollout, releaseImageProvenance })}\n`,
  { encoding: "utf8", mode: 0o600 },
);
