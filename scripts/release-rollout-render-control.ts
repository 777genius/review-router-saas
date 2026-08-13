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
import { parseFreezeSourceWriterServiceIds } from "./release-rollout-render-control-config";

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
const runnerControl = () => {
  const ledger = new AuthenticatedRunnerLedgerAdapter(
    required("REVIEW_ROUTER_RUNNER_LEDGER_URL"),
    required("REVIEW_ROUTER_RUNNER_LEDGER_TOKEN"),
  );
  const providerWitness = new AuthenticatedProviderWitnessAdapter(
    required("REVIEW_ROUTER_RUNNER_WITNESS_URL"),
    required("REVIEW_ROUTER_RUNNER_WITNESS_TOKEN"),
  );
  const runners = new RenderPrivateRunnerAdapter(
    ledger,
    ledger,
    providerWitness,
    fetch,
    () => new Date(),
  );
  return { ledger, useCases: new PrivateRunnerControlUseCases(runners) };
};
const mode = process.argv[2];
const contextValue = (name: string, fallback: string): string =>
  process.env[name] ?? required(fallback);
type WorkflowJob = {
  id?: number;
  name?: string;
  status?: string;
  run_id?: number;
  run_attempt?: number;
  head_sha?: string;
};
const positiveInteger = (name: string, fallback: number): number => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`release_rollout_control_invalid:${name}`);
  return value;
};
export const resolveWorkflowJobId = async (
  name: string,
  options: {
    runId: string;
    runAttempt: string;
    expectedSha: string;
    attempts: number;
    intervalMs: number;
    request?: typeof fetch;
    sleep?: (milliseconds: number) => Promise<void>;
  },
): Promise<string> => {
  const request = options.request ?? fetch;
  const sleep =
    options.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    const response = await request(
      `https://api.github.com/repos/${required("GITHUB_REPOSITORY")}/actions/runs/${options.runId}/attempts/${options.runAttempt}/jobs?filter=all&per_page=100`,
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
      total_count?: number;
      jobs?: WorkflowJob[];
    };
    if (
      !Array.isArray(value.jobs) ||
      !Number.isSafeInteger(value.total_count) ||
      value.total_count! > value.jobs.length
    )
      throw new Error("release_rollout_target_job_list_ambiguous");
    const named = value.jobs.filter((job) => job.name === name);
    const matches = named.filter(
      (job) =>
        job.run_id === Number(options.runId) &&
        job.run_attempt === Number(options.runAttempt) &&
        job.head_sha === options.expectedSha,
    );
    if (named.length !== matches.length || matches.length > 1)
      throw new Error("release_rollout_target_job_identity_ambiguous");
    if (matches.length === 1) {
      const match = matches[0]!;
      if (match.status === "queued" && Number.isSafeInteger(match.id))
        return String(match.id);
      if (match.status === "in_progress" || match.status === "completed")
        throw new Error("release_rollout_target_job_identity_stale");
    }
    if (attempt < options.attempts) await sleep(options.intervalMs);
  }
  throw new Error("release_rollout_target_job_identity_unavailable");
};

if (mode === "freeze") {
  const observation = await new RenderProviderFreezeAdapter().freezeAndObserve({
    apiKey: required("RENDER_SERVICE_SUSPENSION_API_KEY"),
    ownerId: required("RENDER_OWNER_ID"),
    sourceWriterServiceIds: parseFreezeSourceWriterServiceIds(
      required("REVIEW_ROUTER_SOURCE_WRITER_SERVICE_IDS"),
    ),
  });
  output({
    observation: Buffer.from(JSON.stringify(observation)).toString("base64url"),
  });
} else if (mode === "provision") {
  const { useCases: runnerUseCases } = runnerControl();
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
  const expectedSha = contextValue(
    "REVIEW_ROUTER_TARGET_SHA",
    "REVIEW_ROUTER_EXPECTED_SHA",
  );
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
  if (
    targetRun.event !== "workflow_dispatch" ||
    targetRun.head_sha !== expectedSha ||
    targetRun.path !==
      `${required("REVIEW_ROUTER_RELEASE_CONTROL_WORKFLOW_PATH")}@refs/heads/main` ||
    targetRun.run_attempt !== Number(targetRunAttempt) ||
    !targetRun.actor?.login
  )
    throw new Error("release_rollout_target_run_identity_mismatch");
  const targetJobId = await resolveWorkflowJobId(workflowJobName, {
    runId: targetRunId,
    runAttempt: targetRunAttempt,
    expectedSha,
    attempts: positiveInteger("REVIEW_ROUTER_TARGET_JOB_POLL_ATTEMPTS", 20),
    intervalMs: positiveInteger(
      "REVIEW_ROUTER_TARGET_JOB_POLL_INTERVAL_MS",
      3000,
    ),
  });
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
  const { useCases: runnerUseCases } = runnerControl();
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
  const { ledger, useCases: runnerUseCases } = runnerControl();
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
} else if (mode !== undefined)
  throw new Error("release_rollout_control_mode_invalid");
