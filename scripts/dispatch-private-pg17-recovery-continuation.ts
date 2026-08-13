#!/usr/bin/env node
import {
  dispatchPrivatePg17RecoveryContinuation,
  parsePrivatePg17RecoveryCheckpoint,
} from "./private-pg17-recovery-runs";

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`private_pg17_recovery_missing:${name}`);
  return value;
};

await dispatchPrivatePg17RecoveryContinuation({
  repository: required("GITHUB_REPOSITORY"),
  workflowFile: "private-pg17-runner-controller.yml",
  token: required("GITHUB_CONTROL_WRITE_TOKEN"),
  checkpoint: parsePrivatePg17RecoveryCheckpoint(
    required("REVIEW_ROUTER_RECOVERY_SWEEP_CHECKPOINT"),
  ),
  attempts: 4,
  initialDelayMs: 1_000,
  maximumDelayMs: 8_000,
});
