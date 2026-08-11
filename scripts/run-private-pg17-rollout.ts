#!/usr/bin/env node
import { readFileSync } from "node:fs";
import {
  applyStepReceipt,
  createReleaseRollout,
  PostgreSqlGenerationAdapter,
  RedactedProcessCommandAdapter,
  RenderTargetServicesAdapter,
  RolloutStep,
  sha256Canonical,
  type DatabaseGenerationIdentity,
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

const source: DatabaseGenerationIdentity = {
  renderResourceId: required("REVIEW_ROUTER_SOURCE_RENDER_DATABASE_ID"),
  systemIdentifier: required("REVIEW_ROUTER_SOURCE_DATABASE_SYSTEM_IDENTIFIER"),
  majorVersion: 16,
  recoveryWitnessSha256: required(
    "REVIEW_ROUTER_SOURCE_RECOVERY_WITNESS_SHA256",
  ),
};
const target: DatabaseGenerationIdentity = {
  renderResourceId: required("REVIEW_ROUTER_TARGET_RENDER_DATABASE_ID"),
  systemIdentifier: required("REVIEW_ROUTER_TARGET_DATABASE_SYSTEM_IDENTIFIER"),
  majorVersion: 17,
  recoveryWitnessSha256: required(
    "REVIEW_ROUTER_TARGET_RECOVERY_WITNESS_SHA256",
  ),
};
let rollout = createReleaseRollout({
  rolloutId: required("REVIEW_ROUTER_ROLLOUT_ID"),
  expectedCommitSha: required("REVIEW_ROUTER_RELEASE_COMMIT_SHA"),
  source,
  target,
});
rollout = applyStepReceipt(
  rollout,
  decode<StepReceipt>("REVIEW_ROUTER_FREEZE_RECEIPT"),
);
const runnerIdentity = decode<unknown>("REVIEW_ROUTER_RUNNER_IDENTITY");
rollout = applyStepReceipt(
  rollout,
  syntheticReceipt(RolloutStep.ProvisionPrivateRunner, runnerIdentity),
);

const database = new PostgreSqlGenerationAdapter(
  new RedactedProcessCommandAdapter(),
);
const sourceUrl = required("REVIEW_ROUTER_SOURCE_DATABASE_URL");
const targetCopyUrl = required("REVIEW_ROUTER_TARGET_COPY_DATABASE_URL");
database.observeIdentity(sourceUrl, source);
database.observeIdentity(targetCopyUrl, target);
const backup = database.captureBackup({
  sourceUrl,
  dumpPath: `/runner/_work/job/${required("REVIEW_ROUTER_ROLLOUT_ID")}.dump`,
  backup: {
    backupId: required("REVIEW_ROUTER_SOURCE_BACKUP_ID"),
    pitrIdentity: required("REVIEW_ROUTER_SOURCE_PITR_IDENTITY"),
    capturedAt: required("REVIEW_ROUTER_SOURCE_BACKUP_CAPTURED_AT"),
  },
});
rollout = applyStepReceipt(rollout, backup.receipt);
const quiescence = database.quiesceSource(sourceUrl);
rollout = applyStepReceipt(rollout, quiescence.receipt);
rollout = applyStepReceipt(
  rollout,
  database.restoreCopy({
    targetUrl: targetCopyUrl,
    dumpPath: `/runner/_work/job/${required("REVIEW_ROUTER_ROLLOUT_ID")}.dump`,
    dumpSha256: backup.dumpSha256,
  }),
);
const equivalence = database.verifyEquivalence(sourceUrl, targetCopyUrl);
rollout = applyStepReceipt(rollout, equivalence.receipt);

const roleBootstrap = JSON.parse(
  readFileSync(required("REVIEW_ROUTER_ROLE_BOOTSTRAP_RECEIPT_FILE"), "utf8"),
) as unknown;
rollout = applyStepReceipt(
  rollout,
  syntheticReceipt(RolloutStep.BootstrapTargetRoles, roleBootstrap),
);
const migrationEnvironment = {
  ...process.env,
  REVIEW_ROUTER_RELEASE_ACL_GATE_MODE: "closed",
};
const migration = executeCanonicalReleaseMigration(migrationEnvironment);
if (migration.aclGateState !== "closed")
  throw new Error("private_pg17_rollout_acl_gate_not_closed");
rollout = applyStepReceipt(
  rollout,
  syntheticReceipt(RolloutStep.RunReleaseMigration, migration),
);

const serviceExpectations = JSON.parse(
  required("REVIEW_ROUTER_TARGET_SERVICE_EXPECTATIONS_JSON"),
) as { serviceId: string; deployId: string; imageDigest: string }[];
const stageReceipt = await new RenderTargetServicesAdapter().stage({
  apiKey: required("RENDER_API_KEY"),
  targetDatabaseResourceId: target.renderResourceId,
  releaseCommitSha: rollout.expectedCommitSha,
  services: serviceExpectations,
});
rollout = applyStepReceipt(rollout, stageReceipt);

const activation = executePrivateGenerationActivation(migrationEnvironment);
rollout = applyStepReceipt(rollout, activation);
const evidenceBody = {
  schemaVersion: 1,
  rolloutId: rollout.rolloutId,
  releaseCommitSha: rollout.expectedCommitSha,
  runner: runnerIdentity,
  source,
  target,
  backup: backup.backup,
  quiescence: quiescence.evidence,
  dumpSha256: backup.dumpSha256,
  equivalence: equivalence.evidence,
  aclGateBeforeActivation: "closed",
  activation,
  receipts: rollout.receipts,
};
rollout = applyStepReceipt(
  rollout,
  syntheticReceipt(RolloutStep.VerifyTrustedRollout, evidenceBody),
);
process.stdout.write(
  `${JSON.stringify({ ...evidenceBody, receipts: rollout.receipts })}\n`,
);
