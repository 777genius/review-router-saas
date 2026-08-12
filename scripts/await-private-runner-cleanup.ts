#!/usr/bin/env node
import { AuthenticatedRunnerLedgerAdapter } from "../packages/features/release-rollout/src/index";
const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`private_runner_wait_missing:${name}`);
  return value;
};
const ledger = new AuthenticatedRunnerLedgerAdapter(
  required("REVIEW_ROUTER_RUNNER_LEDGER_URL"),
  required("REVIEW_ROUTER_RUNNER_LEDGER_TOKEN"),
);
for (let attempt = 0; attempt < 60; attempt += 1) {
  const open = await ledger.listOpenJobs(required("REVIEW_ROUTER_ROLLOUT_ID"));
  if (
    open.every(
      (job) => job.lifecycle !== required("REVIEW_ROUTER_RUNNER_LIFECYCLE"),
    )
  )
    process.exit(0);
  await new Promise((resolve) => setTimeout(resolve, 2000));
}
throw new Error("private_runner_cleanup_wait_timeout");
