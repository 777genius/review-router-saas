#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`private_pg17_context_missing:${name}`);
  return value;
};
const runId = required("REVIEW_ROUTER_TARGET_RUN_ID");
const response = await fetch(
  `https://api.github.com/repos/${required("GITHUB_REPOSITORY")}/actions/runs/${runId}`,
  {
    headers: {
      Authorization: `Bearer ${required("GITHUB_CONTROL_READ_TOKEN")}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  },
);
if (!response.ok)
  throw new Error(`private_pg17_context_lookup_failed:${response.status}`);
const run = (await response.json()) as {
  display_title?: string;
  event?: string;
  head_sha?: string;
  run_attempt?: number;
  path?: string;
  actor?: { login?: string };
};
const prefix = "private-pg17:";
if (
  !run.display_title?.startsWith(prefix) ||
  run.event !== "workflow_dispatch" ||
  !/^[a-f0-9]{40}$/u.test(run.head_sha ?? "") ||
  run.run_attempt !== 1 ||
  run.path !==
    `${required("REVIEW_ROUTER_RELEASE_CONTROL_WORKFLOW_PATH")}@refs/heads/main` ||
  !run.actor?.login
)
  throw new Error("private_pg17_context_identity_invalid");
const rolloutId = run.display_title.slice(prefix.length);
if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,255}$/u.test(rolloutId))
  throw new Error("private_pg17_context_rollout_id_invalid");
const output = required("GITHUB_OUTPUT");
for (const [key, value] of Object.entries({
  rollout_id: rolloutId,
  expected_sha: run.head_sha,
  run_attempt: String(run.run_attempt),
  actor: run.actor.login,
}))
  appendFileSync(output, `${key}=${value}\n`, { mode: 0o600 });
