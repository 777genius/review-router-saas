#!/usr/bin/env node
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`private_pg17_preflight_missing:${name}`);
  return value;
};
const repository = required("GITHUB_REPOSITORY");
const organization = required("REVIEW_ROUTER_RELEASE_CONTROL_ORG");
if (
  repository !== required("REVIEW_ROUTER_RELEASE_CONTROL_REPOSITORY") ||
  repository.split("/")[0] !== organization ||
  required("GITHUB_EVENT_NAME") !== "workflow_dispatch" ||
  required("GITHUB_REF") !== "refs/heads/main" ||
  required("GITHUB_SHA") !== required("REVIEW_ROUTER_EXPECTED_SHA") ||
  required("GITHUB_RUN_ATTEMPT") !== "1"
)
  throw new Error("private_pg17_preflight_execution_identity_mismatch");
const headers = {
  Authorization: `Bearer ${required("GITHUB_CONTROL_READ_TOKEN")}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
};
const get = async (path: string): Promise<Record<string, unknown>> => {
  const response = await fetch(`https://api.github.com${path}`, { headers });
  if (!response.ok)
    throw new Error(`private_pg17_preflight_lookup_failed:${response.status}`);
  return (await response.json()) as Record<string, unknown>;
};
const repo = await get(`/repos/${repository}`);
if (
  repo.private !== true ||
  !repo.owner ||
  typeof repo.owner !== "object" ||
  (repo.owner as Record<string, unknown>).type !== "Organization" ||
  (repo.owner as Record<string, unknown>).login !== organization
)
  throw new Error("private_pg17_preflight_personal_repository_forbidden");
const environmentNames = JSON.parse(
  required("REVIEW_ROUTER_PRIVILEGED_ENVIRONMENTS_JSON"),
) as unknown;
if (
  !Array.isArray(environmentNames) ||
  environmentNames.length < 1 ||
  environmentNames.some((name) => typeof name !== "string" || !name) ||
  new Set(environmentNames).size !== environmentNames.length
)
  throw new Error("private_pg17_preflight_environment_inventory_invalid");
const environments = [];
for (const environmentName of environmentNames as string[]) {
  const environment = await get(
    `/repos/${repository}/environments/${encodeURIComponent(environmentName)}`,
  );
  const rules = environment.protection_rules;
  if (!Array.isArray(rules))
    throw new Error("private_pg17_preflight_environment_policy_missing");
  const reviewerRule = rules.find(
    (rule) =>
      !!rule &&
      typeof rule === "object" &&
      (rule as Record<string, unknown>).type === "required_reviewers",
  ) as Record<string, unknown> | undefined;
  const branchRule = rules.find(
    (rule) =>
      !!rule &&
      typeof rule === "object" &&
      (rule as Record<string, unknown>).type === "branch_policy",
  );
  if (
    !reviewerRule ||
    !Array.isArray(reviewerRule.reviewers) ||
    reviewerRule.reviewers.length < 1 ||
    !branchRule ||
    !environment.deployment_branch_policy ||
    typeof environment.deployment_branch_policy !== "object" ||
    (environment.deployment_branch_policy as Record<string, unknown>)
      .protected_branches !== true
  )
    throw new Error("private_pg17_preflight_environment_policy_unsafe");
  environments.push({
    name: environmentName,
    requiredReviewerCount: reviewerRule.reviewers.length,
    preventSelfReview: reviewerRule.prevent_self_review === true,
    protectedBranchesOnly: true,
  });
}
const facts = {
  organization,
  repository,
  workflowPath: required("REVIEW_ROUTER_RELEASE_CONTROL_WORKFLOW_PATH"),
  workflowRef: required("GITHUB_REF"),
  sha: required("GITHUB_SHA"),
  event: required("GITHUB_EVENT_NAME"),
  actor: required("GITHUB_ACTOR"),
  runId: required("GITHUB_RUN_ID"),
  runAttempt: 1,
  environments,
  runnerGroupId: Number(required("REVIEW_ROUTER_RUNNER_GROUP_ID")),
  observedAt: new Date().toISOString(),
};
if (!Number.isSafeInteger(facts.runnerGroupId) || facts.runnerGroupId < 1)
  throw new Error("private_pg17_preflight_runner_group_invalid");
writeFileSync(
  required("REVIEW_ROUTER_PROTECTED_ENVIRONMENT_PREFLIGHT_FILE"),
  `${JSON.stringify({ ...facts, observationSha256: `sha256:${createHash("sha256").update(JSON.stringify(facts)).digest("hex")}` })}\n`,
  { encoding: "utf8", mode: 0o600 },
);
