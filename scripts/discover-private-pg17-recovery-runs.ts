#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { discoverPrivatePg17RecoveryRuns } from "./private-pg17-recovery-runs";

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`private_pg17_recovery_missing:${name}`);
  return value;
};
const maximumPages = Number(
  process.env.REVIEW_ROUTER_RECOVERY_MAXIMUM_PAGES ?? "2",
);
const runs = await discoverPrivatePg17RecoveryRuns({
  repository: required("GITHUB_REPOSITORY"),
  workflowPath: required("REVIEW_ROUTER_RELEASE_CONTROL_WORKFLOW_PATH"),
  token: required("GITHUB_CONTROL_READ_TOKEN"),
  maximumPages,
  ...(process.env.REVIEW_ROUTER_TARGET_RUN_ID
    ? { targetRunId: process.env.REVIEW_ROUTER_TARGET_RUN_ID }
    : {}),
});
if (process.env.REVIEW_ROUTER_TARGET_RUN_ID && runs.length !== 1)
  throw new Error("private_pg17_recovery_target_not_eligible");
appendFileSync(required("GITHUB_OUTPUT"), `matrix=${JSON.stringify(runs)}\n`, {
  encoding: "utf8",
  mode: 0o600,
});
