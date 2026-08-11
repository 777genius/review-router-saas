#!/usr/bin/env node
import {
  applyStepReceipt,
  createReleaseRollout,
  PostgreSqlGenerationAdapter,
  RedactedProcessCommandAdapter,
  RenderBackupIdentityAdapter,
  RolloutStep,
  sha256Canonical,
  type DatabaseGenerationIdentity,
  type StepReceipt,
} from "../packages/features/release-rollout/src/index";
import { executeCanonicalRoleBootstrap } from "./run-codex-rotating-release-migration.mjs";

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`private_pg17_copy_required:${name}`);
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
const runner = decode<unknown>("REVIEW_ROUTER_RUNNER_IDENTITY");
rollout = applyStepReceipt(
  rollout,
  syntheticReceipt(RolloutStep.ProvisionPrivateRunner, runner),
);
const database = new PostgreSqlGenerationAdapter(
  new RedactedProcessCommandAdapter(),
);
const sourceUrl = required("REVIEW_ROUTER_SOURCE_DATABASE_URL");
const targetBootstrapUrl = required(
  "REVIEW_ROUTER_ROLE_BOOTSTRAP_DATABASE_URL",
);
database.observeIdentity(sourceUrl, source);
database.observeIdentity(targetBootstrapUrl, target);
const dumpPath = `/runner/_work/job/${rollout.rolloutId}.dump`;
const backupIdentity = await new RenderBackupIdentityAdapter().capture({
  apiKey: required("RENDER_API_KEY"),
  sourceDatabaseId: source.renderResourceId,
  expectedBackupId: required("REVIEW_ROUTER_SOURCE_BACKUP_ID"),
  expectedPitrIdentity: required("REVIEW_ROUTER_SOURCE_PITR_IDENTITY"),
});
const backup = database.captureBackup({
  sourceUrl,
  dumpPath,
  backup: backupIdentity,
});
rollout = applyStepReceipt(rollout, backup.receipt);
const quiescence = database.quiesceSource(sourceUrl);
rollout = applyStepReceipt(rollout, quiescence.receipt);
rollout = applyStepReceipt(
  rollout,
  database.restoreCopy({
    targetUrl: targetBootstrapUrl,
    dumpPath,
    dumpSha256: backup.dumpSha256,
  }),
);
const equivalence = database.verifyEquivalence(sourceUrl, targetBootstrapUrl);
rollout = applyStepReceipt(rollout, equivalence.receipt);
const roleBootstrap = executeCanonicalRoleBootstrap();
rollout = applyStepReceipt(
  rollout,
  syntheticReceipt(RolloutStep.BootstrapTargetRoles, roleBootstrap),
);
process.stdout.write(
  `${JSON.stringify({ rollout, roleBootstrapRunner: runner, backup: backup.backup, dumpSha256: backup.dumpSha256, quiescence: quiescence.evidence, equivalence: equivalence.evidence })}\n`,
);
