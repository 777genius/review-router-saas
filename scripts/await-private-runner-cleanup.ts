#!/usr/bin/env node
const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`private_runner_wait_missing:${name}`);
  return value;
};
const origin = required("REVIEW_ROUTER_RUNNER_LEDGER_URL").replace(/\/$/u, "");
const token = required("REVIEW_ROUTER_RUNNER_LEDGER_TOKEN");
const rolloutId = required("REVIEW_ROUTER_ROLLOUT_ID");
const lifecycle = required("REVIEW_ROUTER_RUNNER_LIFECYCLE");
if (lifecycle !== "role" && lifecycle !== "cutover")
  throw new Error("private_runner_wait_lifecycle_invalid");
for (let attempt = 0; attempt < 60; attempt += 1) {
  const response = await fetch(
    `${origin}/v1/runner-jobs/terminal-cleanup-fact?rollout_id=${encodeURIComponent(rolloutId)}&lifecycle=${lifecycle}`,
    {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    },
  );
  if (response.ok) {
    const fact = (await response.json()) as Record<string, unknown>;
    const witness = fact.witness as Record<string, unknown> | undefined;
    if (
      fact.lifecycle === lifecycle &&
      typeof fact.jobId === "string" &&
      typeof fact.canary === "string" &&
      typeof fact.terminalAt === "string" &&
      witness?.canary === fact.canary &&
      witness.providerStatus === "succeeded" &&
      witness.listenerStopped === true &&
      witness.workspaceRemoved === true &&
      witness.credentialProcessGone === true
    )
      process.exit(0);
    throw new Error("private_runner_cleanup_terminal_fact_invalid");
  }
  if (
    response.status !== 404 &&
    response.status !== 409 &&
    response.status !== 500
  )
    throw new Error(`private_runner_cleanup_wait_failed:${response.status}`);
  await new Promise((resolve) => setTimeout(resolve, 2000));
}
throw new Error("private_runner_cleanup_wait_timeout");
