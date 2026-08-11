#!/usr/bin/env node
import { readFileSync } from "node:fs";
import {
  applyStepReceipt,
  createReleaseRollout,
  RenderTargetServicesAdapter,
  RolloutPhase,
  RolloutStep,
  sha256Canonical,
  type EquivalenceEvidence,
  type QuiescenceEvidence,
  type ReleaseRollout,
  type RunnerIdentity,
  type StepReceipt,
} from "../packages/features/release-rollout/src/index";
import { executePrivateGenerationActivation } from "./activate-private-pg17-generation.mjs";
import { executeCanonicalReleaseMigration } from "./run-codex-rotating-release-migration.mjs";

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`private_pg17_rollout_required:${name}`);
  return value;
};
const decode = <T>(name: string): T =>
  JSON.parse(Buffer.from(required(name), "base64url").toString("utf8")) as T;
const syntheticReceipt = (
  step: StepReceipt["step"],
  payload: unknown,
): StepReceipt => {
  const hash = sha256Canonical(payload);
  return {
    step,
    receiptId: `${step}-${hash.slice(0, 24)}`,
    observedAt: new Date().toISOString(),
    payloadSha256: `sha256:${hash}`,
  };
};
const copy = JSON.parse(
  readFileSync(required("REVIEW_ROUTER_COPY_BOOTSTRAP_EVIDENCE_FILE"), "utf8"),
) as {
  rollout: ReleaseRollout;
  roleBootstrapRunner: RunnerIdentity;
  backup: { backupId: string; pitrIdentity: string; capturedAt: string };
  dumpSha256: string;
  quiescence: QuiescenceEvidence;
  equivalence: EquivalenceEvidence;
};
let rollout = createReleaseRollout({
  rolloutId: copy.rollout.rolloutId,
  expectedCommitSha: copy.rollout.expectedCommitSha,
  source: copy.rollout.source,
  target: copy.rollout.target,
});
for (const receipt of copy.rollout.receipts)
  rollout = applyStepReceipt(rollout, receipt);
if (
  rollout.phase !== RolloutPhase.TargetRolesBootstrapped ||
  rollout.rolloutId !== required("REVIEW_ROUTER_ROLLOUT_ID") ||
  rollout.expectedCommitSha !== required("REVIEW_ROUTER_RELEASE_COMMIT_SHA")
)
  throw new Error("private_pg17_rollout_copy_evidence_mismatch");
const cutoverRunner = decode<RunnerIdentity>("REVIEW_ROUTER_RUNNER_IDENTITY");
const migrationEnvironment = {
  ...process.env,
  REVIEW_ROUTER_RELEASE_ACL_GATE_MODE: "closed",
};
const migration = executeCanonicalReleaseMigration(migrationEnvironment);
if (migration.aclGateState !== "closed")
  throw new Error("private_pg17_rollout_acl_gate_not_closed");
rollout = applyStepReceipt(
  rollout,
  syntheticReceipt(RolloutStep.RunReleaseMigration, {
    migration,
    cutoverRunner,
  }),
);
const serviceExpectations = JSON.parse(
  required("REVIEW_ROUTER_TARGET_SERVICE_EXPECTATIONS_JSON"),
) as { serviceId: string; deployId: string; imageDigest: string }[];
rollout = applyStepReceipt(
  rollout,
  await new RenderTargetServicesAdapter().stage({
    apiKey: required("RENDER_API_KEY"),
    targetDatabaseResourceId: rollout.target.renderResourceId,
    releaseCommitSha: rollout.expectedCommitSha,
    services: serviceExpectations,
  }),
);
const activation = executePrivateGenerationActivation(migrationEnvironment);
rollout = applyStepReceipt(rollout, activation);
const evidenceBody = {
  rolloutId: rollout.rolloutId,
  releaseCommitSha: rollout.expectedCommitSha,
  runners: [copy.roleBootstrapRunner, cutoverRunner],
  source: rollout.source,
  target: rollout.target,
  backup: copy.backup,
  quiescence: copy.quiescence,
  dumpSha256: copy.dumpSha256,
  equivalence: copy.equivalence,
  aclGateBeforeActivation: "closed",
  activation,
};
rollout = applyStepReceipt(
  rollout,
  syntheticReceipt(RolloutStep.VerifyTrustedRollout, evidenceBody),
);
process.stdout.write(
  `${JSON.stringify({ ...evidenceBody, receipts: rollout.receipts })}\n`,
);
