import { spawn } from "node:child_process";
import { lstat, readdir, rm } from "node:fs/promises";
import {
  BoundedProviderHttpClient,
  ProviderHttpError,
} from "./bounded-provider-io";
import { sanitizedDiagnosticError } from "../domain/sanitized-diagnostic.js";

export const credentialNames = Object.freeze([
  "REVIEW_ROUTER_RUNNER_GITHUB_APP_PRIVATE_KEY",
  "REVIEW_ROUTER_RUNNER_GITHUB_APP_PRIVATE_KEY_FILE",
  "GITHUB_TOKEN",
  "GH_TOKEN",
]);
const inheritedNames = Object.freeze([
  "PATH",
  "LANG",
  "LC_ALL",
  "TZ",
  "HOME",
  "RUNNER_ALLOW_RUNASROOT",
  "REVIEW_ROUTER_RUNNER_CLEANUP_CANARY_FILE",
]);

export function workflowEnvironment(
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const name of inheritedNames)
    if (source[name] !== undefined) clean[name] = source[name];
  for (const name of credentialNames)
    if (clean[name] !== undefined)
      throw new Error("github_jit_credential_inheritance_forbidden");
  return clean;
}

export async function runOneJobRunner(options: {
  runnerPath: string;
  jitConfig: string;
  timeoutMs: number;
  environment?: NodeJS.ProcessEnv;
  spawnImpl?: typeof spawn;
  workingDirectory?: string;
}): Promise<void> {
  if (!options.jitConfig || options.jitConfig.length > 65_536)
    throw sanitizedDiagnosticError({
      code: "release_rollout_process_boundary_rejected",
      phase: "process_boundary",
    });
  if (
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs < 1_000 ||
    options.timeoutMs > 3_600_000
  )
    throw sanitizedDiagnosticError({
      code: "release_rollout_process_boundary_rejected",
      phase: "process_boundary",
    });
  const child = (options.spawnImpl ?? spawn)(
    options.runnerPath,
    ["run", "--jitconfig", options.jitConfig],
    {
      ...(options.workingDirectory ? { cwd: options.workingDirectory } : {}),
      env: workflowEnvironment(options.environment ?? process.env),
      detached: true,
      stdio: ["inherit", "pipe", "pipe"],
    },
  );
  const exitCode = await new Promise<number>((resolve, reject) => {
    let assigned = false;
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    const stop = (signal: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        child.kill(signal);
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop("SIGTERM");
      killTimer = setTimeout(() => stop("SIGKILL"), 5_000);
    }, options.timeoutMs);
    const observe = (chunk: unknown) => {
      const value = String(chunk);
      if (!assigned && /(?:^|\n).*Running job:/u.test(value)) {
        assigned = true;
        clearTimeout(timer);
      }
    };
    child.stdout?.on("data", observe);
    child.stderr?.on("data", observe);
    child.once("error", () => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      reject(
        sanitizedDiagnosticError({
          code: "release_rollout_process_failed",
          phase: "process_execute",
        }),
      );
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (timedOut)
        reject(
          sanitizedDiagnosticError({
            code: "release_rollout_process_failed",
            phase: "process_execute",
            timedOut: true,
          }),
        );
      else resolve(code ?? 1);
    });
  });
  if (exitCode !== 0)
    throw sanitizedDiagnosticError({
      code: "release_rollout_process_failed",
      phase: "process_execute",
      exitCode,
    });
}

export async function cleanupRunnerWorkspace(
  paths: readonly string[],
): Promise<{
  readonly removedPaths: readonly string[];
  readonly remainingPaths: readonly string[];
}> {
  const removed: string[] = [];
  for (const path of paths) {
    if (
      !/^\/runner\/_work\/rr-[A-Za-z0-9_-]+$/u.test(path) &&
      !/^\/runner\/tmp\/rr-[A-Za-z0-9_-]+$/u.test(path)
    )
      throw new Error("github_jit_cleanup_path_unsafe");
    try {
      await rm(path, { force: true, recursive: true });
      try {
        await lstat(path);
        throw new Error("github_jit_cleanup_path_remains");
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === "github_jit_cleanup_path_remains"
        )
          throw error;
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          throw new Error("github_jit_cleanup_verification_failed", {
            cause: error,
          });
      }
      removed.push(path);
    } catch (error) {
      throw new Error("github_jit_cleanup_remove_failed", { cause: error });
    }
  }
  const remaining = (await readdir("/runner/_work"))
    .filter((name) => paths.includes(`/runner/_work/${name}`))
    .map((name) => `/runner/_work/${name}`);
  if (remaining.length)
    throw new Error("github_jit_cleanup_enumeration_failed");
  return Object.freeze({
    removedPaths: Object.freeze(removed),
    remainingPaths: Object.freeze(remaining),
  });
}

export interface JitApiContext {
  readonly organization: string;
  readonly repository: string;
  readonly workflowPath: string;
  readonly workflowRef: "refs/heads/main";
  readonly event: "workflow_dispatch";
  readonly runId: string;
  readonly runAttempt: 1;
  readonly commitSha: string;
  readonly actor: string;
  readonly workflowJobId: string;
  readonly workflowJobName: string;
  readonly runnerGroupId: number;
  readonly runnerGroupName: string;
  readonly runnerName: string;
  readonly uniqueRunnerLabel: string;
  readonly workFolder: string;
}

export interface JitRegistration {
  readonly encodedJitConfig: string;
  readonly runnerId: number;
  readonly runnerGroupId: number;
  readonly labels: readonly string[];
  readonly uniqueLabel: string;
  readonly workFolder: string;
}

type Fetch = typeof fetch;
async function json(
  response: Response,
  operation: string,
): Promise<Record<string, unknown>> {
  if (!response.ok)
    throw new ProviderHttpError(
      `github_jit_${operation}`,
      "response_status",
      response.status,
      true,
    );
  try {
    const value = await response.json();
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new ProviderHttpError(
      `github_jit_${operation}`,
      "response_invalid",
      response.status,
      true,
    );
  }
}
function header(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

export async function requestJitConfiguration(
  context: JitApiContext,
  token: string,
  fetchImpl: Fetch = fetch,
): Promise<JitRegistration> {
  if (
    !/^[A-Za-z0-9_.-]+$/u.test(context.organization) ||
    context.repository.split("/")[0] !== context.organization ||
    !/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/u.test(
      context.workflowPath,
    ) ||
    context.workflowRef !== "refs/heads/main" ||
    context.event !== "workflow_dispatch" ||
    !/^[1-9][0-9]*$/u.test(context.runId) ||
    context.runAttempt !== 1 ||
    !/^[a-f0-9]{40}$/u.test(context.commitSha) ||
    !/^[A-Za-z0-9_.-]+$/u.test(context.actor) ||
    !/^[1-9][0-9]*$/u.test(context.workflowJobId) ||
    !Number.isSafeInteger(context.runnerGroupId) ||
    context.runnerGroupId < 1 ||
    !/^[A-Za-z0-9_.-]+$/u.test(context.runnerGroupName) ||
    !/^rr-[A-Za-z0-9_-]+$/u.test(context.runnerName) ||
    context.uniqueRunnerLabel !== context.runnerName ||
    context.workFolder !== `_work/${context.runnerName}` ||
    !token
  )
    throw new Error("github_jit_context_invalid");
  const http = new BoundedProviderHttpClient(fetchImpl);
  const request = (url: string, init?: RequestInit) =>
    http.request("github_jit", url, init);
  const headers = header(token);
  const org = await json(
    await request(`https://api.github.com/orgs/${context.organization}`, {
      headers,
    }),
    "organization_lookup",
  );
  if (org.login !== context.organization || org.type !== "Organization")
    throw new Error("github_jit_personal_owner_forbidden");
  const repository = await json(
    await request(`https://api.github.com/repos/${context.repository}`, {
      headers,
    }),
    "repository_lookup",
  );
  if (
    repository.full_name !== context.repository ||
    repository.private !== true ||
    !repository.owner ||
    typeof repository.owner !== "object" ||
    (repository.owner as Record<string, unknown>).type !== "Organization" ||
    (repository.owner as Record<string, unknown>).login !== context.organization
  )
    throw new Error("github_jit_control_repository_mismatch");
  const group = await json(
    await request(
      `https://api.github.com/orgs/${context.organization}/actions/runner-groups/${context.runnerGroupId}`,
      { headers },
    ),
    "runner_group_lookup",
  );
  const selectedWorkflow = `${context.repository}/${context.workflowPath}@${context.workflowRef}`;
  if (
    group.id !== context.runnerGroupId ||
    group.name !== context.runnerGroupName ||
    group.visibility !== "selected" ||
    group.allows_public_repositories !== false ||
    group.restricted_to_workflows !== true ||
    !Array.isArray(group.selected_workflows) ||
    group.selected_workflows.length !== 1 ||
    group.selected_workflows[0] !== selectedWorkflow
  )
    throw new Error("github_jit_runner_group_policy_mismatch");
  const selected = await json(
    await request(
      `https://api.github.com/orgs/${context.organization}/actions/runner-groups/${context.runnerGroupId}/repositories?per_page=100`,
      { headers },
    ),
    "runner_group_repositories",
  );
  if (
    selected.total_count !== 1 ||
    !Array.isArray(selected.repositories) ||
    selected.repositories.length !== 1 ||
    (selected.repositories[0] as Record<string, unknown>).full_name !==
      context.repository
  )
    throw new Error("github_jit_runner_group_repository_mismatch");
  const run = await json(
    await request(
      `https://api.github.com/repos/${context.repository}/actions/runs/${context.runId}`,
      { headers },
    ),
    "run_lookup",
  );
  if (
    run.id !== Number(context.runId) ||
    run.run_attempt !== context.runAttempt ||
    run.head_sha !== context.commitSha ||
    run.head_branch !== "main" ||
    run.event !== context.event ||
    run.path !== `${context.workflowPath}@${context.workflowRef}` ||
    !run.actor ||
    typeof run.actor !== "object" ||
    (run.actor as Record<string, unknown>).login !== context.actor
  )
    throw new Error("github_jit_run_identity_mismatch");
  const jobs = await json(
    await request(
      `https://api.github.com/repos/${context.repository}/actions/runs/${context.runId}/attempts/${context.runAttempt}/jobs?filter=latest&per_page=100`,
      { headers },
    ),
    "jobs_lookup",
  );
  if (!Array.isArray(jobs.jobs))
    throw new ProviderHttpError(
      "github_jit_jobs_lookup",
      "response_invalid",
      undefined,
    );
  const job = jobs.jobs.find(
    (item) =>
      !!item &&
      typeof item === "object" &&
      (item as Record<string, unknown>).id === Number(context.workflowJobId),
  ) as Record<string, unknown> | undefined;
  if (
    !job ||
    job.name !== context.workflowJobName ||
    job.run_id !== Number(context.runId) ||
    job.run_attempt !== context.runAttempt ||
    job.head_sha !== context.commitSha ||
    job.status !== "queued" ||
    job.runner_id !== null ||
    job.runner_name !== null ||
    job.runner_group_id !== context.runnerGroupId ||
    job.runner_group_name !== context.runnerGroupName ||
    !Array.isArray(job.labels) ||
    JSON.stringify(job.labels) !==
      JSON.stringify(["self-hosted", context.uniqueRunnerLabel])
  )
    throw new Error("github_jit_target_job_identity_mismatch");
  const generated = await json(
    await request(
      `https://api.github.com/orgs/${context.organization}/actions/runners/generate-jitconfig`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          name: context.runnerName,
          runner_group_id: context.runnerGroupId,
          labels: [context.uniqueRunnerLabel],
          work_folder: context.workFolder,
        }),
      },
    ),
    "generation",
  );
  const returnedRunner = generated.runner as
    | Record<string, unknown>
    | undefined;
  const returnedLabels = Array.isArray(returnedRunner?.labels)
    ? returnedRunner.labels.map((label) =>
        typeof label === "string"
          ? label
          : label && typeof label === "object"
            ? String((label as Record<string, unknown>).name ?? "")
            : "",
      )
    : [];
  if (
    typeof generated.encoded_jit_config !== "string" ||
    generated.encoded_jit_config.length < 16 ||
    !returnedRunner ||
    returnedRunner.name !== context.runnerName ||
    returnedRunner.status !== "offline" ||
    returnedRunner.busy !== false ||
    !Number.isSafeInteger(returnedRunner.id) ||
    Number(returnedRunner.id) < 1 ||
    returnedRunner.runner_group_id !== context.runnerGroupId ||
    returnedLabels.length < 1 ||
    !returnedLabels.includes(context.uniqueRunnerLabel) ||
    new Set(returnedLabels).size !== returnedLabels.length
  )
    throw new ProviderHttpError(
      "github_jit_generation",
      "response_invalid",
      undefined,
      true,
    );
  const runnerId = Number(returnedRunner.id);
  const [runnerAfterRegistration, groupAfterRegistration] = await Promise.all([
    json(
      await request(
        `https://api.github.com/orgs/${context.organization}/actions/runners/${runnerId}`,
        { headers },
      ),
      "runner_reread",
    ),
    json(
      await request(
        `https://api.github.com/orgs/${context.organization}/actions/runner-groups/${context.runnerGroupId}`,
        { headers },
      ),
      "runner_group_reread",
    ),
  ]);
  const rereadLabels = Array.isArray(runnerAfterRegistration.labels)
    ? runnerAfterRegistration.labels.map((label) =>
        typeof label === "string"
          ? label
          : label && typeof label === "object"
            ? String((label as Record<string, unknown>).name ?? "")
            : "",
      )
    : [];
  if (
    runnerAfterRegistration.id !== runnerId ||
    runnerAfterRegistration.name !== context.runnerName ||
    runnerAfterRegistration.status !== "offline" ||
    runnerAfterRegistration.busy !== false ||
    JSON.stringify(rereadLabels) !== JSON.stringify(returnedLabels) ||
    groupAfterRegistration.id !== context.runnerGroupId ||
    groupAfterRegistration.name !== context.runnerGroupName
  )
    throw new Error("github_jit_registration_reread_mismatch");
  return Object.freeze({
    encodedJitConfig: generated.encoded_jit_config,
    runnerId,
    runnerGroupId: context.runnerGroupId,
    labels: Object.freeze(returnedLabels),
    uniqueLabel: context.uniqueRunnerLabel,
    workFolder: context.workFolder,
  });
}
