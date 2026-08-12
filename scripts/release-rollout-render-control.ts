#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import {
  AuthenticatedRunnerLedgerAdapter,
  AuthenticatedProviderWitnessAdapter,
  PrivateRunnerControlUseCases,
  RenderPrivateRunnerAdapter,
  RenderProviderFreezeAdapter,
  type RunnerIdentity,
} from "../packages/features/release-rollout/src/index";

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`release_rollout_control_missing:${name}`);
  return value;
};
const output = (values: Record<string, string>) => {
  const path = required("GITHUB_OUTPUT");
  for (const [key, value] of Object.entries(values))
    appendFileSync(path, `${key}=${value}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
};
const ledger = new AuthenticatedRunnerLedgerAdapter(
  required("REVIEW_ROUTER_RUNNER_LEDGER_URL"),
  required("REVIEW_ROUTER_RUNNER_LEDGER_TOKEN"),
);
const providerWitness = new AuthenticatedProviderWitnessAdapter(
  required("REVIEW_ROUTER_RUNNER_LEDGER_URL"),
  required("REVIEW_ROUTER_RUNNER_WITNESS_TOKEN"),
);
const runners = new RenderPrivateRunnerAdapter(
  ledger,
  ledger,
  fetch,
  () => new Date(),
  providerWitness,
);
const runnerUseCases = new PrivateRunnerControlUseCases(runners);
const mode = process.argv[2];
const contextValue = (name: string, fallback: string): string =>
  process.env[name] ?? required(fallback);
const resolveWorkflowJobId = async (name: string): Promise<string> => {
  const response = await fetch(
    `https://api.github.com/repos/${required("GITHUB_REPOSITORY")}/actions/runs/${required("GITHUB_RUN_ID")}/attempts/${required("GITHUB_RUN_ATTEMPT")}/jobs?filter=latest&per_page=100`,
    {
      headers: {
        Authorization: `Bearer ${required("GITHUB_CONTROL_READ_TOKEN")}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  if (!response.ok)
    throw new Error(`release_rollout_job_lookup_failed:${response.status}`);
  const value = (await response.json()) as {
    jobs?: {
      id?: number;
      name?: string;
      status?: string;
      run_id?: number;
      run_attempt?: number;
      head_sha?: string;
    }[];
  };
  const matches =
    value.jobs?.filter(
      (job) =>
        job.name === name &&
        job.status === "queued" &&
        job.run_id === Number(required("GITHUB_RUN_ID")) &&
        job.run_attempt === Number(required("GITHUB_RUN_ATTEMPT")) &&
        job.head_sha === required("REVIEW_ROUTER_EXPECTED_SHA"),
    ) ?? [];
  if (matches.length !== 1 || !Number.isSafeInteger(matches[0]?.id))
    throw new Error("release_rollout_target_job_identity_unavailable");
  return String(matches[0]!.id);
};

if (mode === "freeze") {
  const observation = await new RenderProviderFreezeAdapter().freezeAndObserve({
    apiKey: required("RENDER_SERVICE_SUSPENSION_API_KEY"),
    ownerId: required("RENDER_OWNER_ID"),
    sourceWriterServiceIds: required(
      "REVIEW_ROUTER_SOURCE_WRITER_SERVICE_IDS",
    ).split(","),
  });
  output({
    observation: Buffer.from(JSON.stringify(observation)).toString("base64url"),
  });
} else if (mode === "provision") {
  const purpose = required("REVIEW_ROUTER_RUNNER_PURPOSE");
  const workflowJobName = required("REVIEW_ROUTER_EXPECTED_WORKFLOW_JOB_NAME");
  const targetRunId = contextValue(
    "REVIEW_ROUTER_TARGET_RUN_ID",
    "GITHUB_RUN_ID",
  );
  const targetRunAttempt = contextValue(
    "REVIEW_ROUTER_TARGET_RUN_ATTEMPT",
    "GITHUB_RUN_ATTEMPT",
  );
  const targetJobId =
    process.env.REVIEW_ROUTER_TARGET_WORKFLOW_JOB_ID ??
    (await resolveWorkflowJobId(workflowJobName));
  const runResponse = await fetch(
    `https://api.github.com/repos/${required("GITHUB_REPOSITORY")}/actions/runs/${targetRunId}/attempts/${targetRunAttempt}`,
    {
      headers: {
        Authorization: `Bearer ${required("GITHUB_CONTROL_READ_TOKEN")}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  if (!runResponse.ok)
    throw new Error(
      `release_rollout_target_run_lookup_failed:${runResponse.status}`,
    );
  const targetRun = (await runResponse.json()) as {
    actor?: { login?: string };
    event?: string;
    head_sha?: string;
    path?: string;
    run_attempt?: number;
  };
  const expectedSha = contextValue(
    "REVIEW_ROUTER_TARGET_SHA",
    "REVIEW_ROUTER_EXPECTED_SHA",
  );
  if (
    targetRun.event !== "workflow_dispatch" ||
    targetRun.head_sha !== expectedSha ||
    targetRun.path !==
      `${required("REVIEW_ROUTER_RELEASE_CONTROL_WORKFLOW_PATH")}@refs/heads/main` ||
    targetRun.run_attempt !== Number(targetRunAttempt) ||
    !targetRun.actor?.login
  )
    throw new Error("release_rollout_target_run_identity_mismatch");
  const result = (await runnerUseCases.provision({
    rolloutId: required("REVIEW_ROUTER_ROLLOUT_ID"),
    lifecycle: purpose === "role-bootstrap" ? "role" : "cutover",
    apiKey: required("RENDER_RUNNER_CONTROL_API_KEY"),
    ownerId: required("RENDER_OWNER_ID"),
    organization: required("REVIEW_ROUTER_RELEASE_CONTROL_ORG"),
    repository: required("REVIEW_ROUTER_RELEASE_CONTROL_REPOSITORY"),
    workflowPath: required("REVIEW_ROUTER_RELEASE_CONTROL_WORKFLOW_PATH"),
    workflowRef: "refs/heads/main",
    event: targetRun.event as "workflow_dispatch",
    actor: targetRun.actor.login,
    runId: targetRunId,
    runAttempt: Number(targetRunAttempt),
    workflowJobId: targetJobId,
    workflowJobName,
    commitSha: expectedSha,
    runnerName: `rr-${targetRunId}-${purpose}`,
    runnerGroupId: Number(required("REVIEW_ROUTER_RUNNER_GROUP_ID")),
    runnerGroupName: required("REVIEW_ROUTER_RUNNER_GROUP_NAME"),
    baseServiceId: required("REVIEW_ROUTER_RUNNER_BASE_SERVICE_ID"),
    expectedProvenance: JSON.parse(
      required("REVIEW_ROUTER_RUNNER_PROVENANCE_JSON"),
    ) as RunnerIdentity["provenance"],
    imageAttestation: JSON.parse(
      required("REVIEW_ROUTER_RUNNER_IMAGE_ATTESTATION_JSON"),
    ) as NonNullable<RunnerIdentity["imageAttestation"]>,
    ...(process.env.REVIEW_ROUTER_RUNNER_COMPUTE_PLAN_ID
      ? { planId: process.env.REVIEW_ROUTER_RUNNER_COMPUTE_PLAN_ID }
      : {}),
  })) as Awaited<ReturnType<RenderPrivateRunnerAdapter["provision"]>>;
  output({
    job_id: result.jobId,
    cleanup_canary: result.identity.cleanupCanary,
    identity: Buffer.from(JSON.stringify(result.identity)).toString(
      "base64url",
    ),
    observation: Buffer.from(JSON.stringify(result.observation)).toString(
      "base64url",
    ),
  });
} else if (mode === "cleanup") {
  const observation = await runnerUseCases.cleanup({
    apiKey: required("RENDER_RUNNER_CONTROL_API_KEY"),
    baseServiceId: required("REVIEW_ROUTER_RUNNER_BASE_SERVICE_ID"),
    jobId: required("REVIEW_ROUTER_RUNNER_JOB_ID"),
    cleanupCanary: required("REVIEW_ROUTER_RUNNER_CLEANUP_CANARY"),
    lifecycle:
      required("REVIEW_ROUTER_RUNNER_PURPOSE") === "role-bootstrap"
        ? "role"
        : "cutover",
  });
  output({
    observation: Buffer.from(JSON.stringify(observation)).toString("base64url"),
  });
  const receiptFile = process.env.REVIEW_ROUTER_CLEANUP_RECEIPT_FILE;
  if (receiptFile)
    writeFileSync(receiptFile, `${JSON.stringify(observation)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
} else if (mode === "reconcile" || mode === "cleanup-runners") {
  const path = required("REVIEW_ROUTER_ORPHAN_RECONCILIATION_FILE");
  const observations = await runnerUseCases.reconcile(
    required("REVIEW_ROUTER_ROLLOUT_ID"),
    required("RENDER_RUNNER_CONTROL_API_KEY"),
  );
  const rollout =
    mode === "reconcile"
      ? await ledger.reconcileRollout(required("REVIEW_ROUTER_ROLLOUT_ID"))
      : null;
  writeFileSync(
    path,
    `${JSON.stringify({ rolloutId: required("REVIEW_ROUTER_ROLLOUT_ID"), observations, rollout })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
} else if (mode === "verify-cleanup-file") {
  JSON.parse(
    readFileSync(required("REVIEW_ROUTER_CLEANUP_RECEIPT_FILE"), "utf8"),
  );
} else throw new Error("release_rollout_control_mode_invalid");
