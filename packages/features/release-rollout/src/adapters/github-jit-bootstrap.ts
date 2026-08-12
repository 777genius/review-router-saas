import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";

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
    throw new Error("github_jit_configuration_invalid");
  if (
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs < 1_000 ||
    options.timeoutMs > 3_600_000
  )
    throw new Error("github_jit_timeout_invalid");
  const child = (options.spawnImpl ?? spawn)(
    options.runnerPath,
    ["run", "--jitconfig", options.jitConfig],
    {
      ...(options.workingDirectory ? { cwd: options.workingDirectory } : {}),
      env: workflowEnvironment(options.environment ?? process.env),
      stdio: "inherit",
    },
  );
  const exitCode = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("github_jit_no_job_timeout"));
    }, options.timeoutMs);
    child.once("error", () => {
      clearTimeout(timer);
      reject(new Error("github_jit_runner_spawn_failed"));
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
  });
  if (exitCode !== 0) throw new Error(`github_jit_runner_failed:${exitCode}`);
}

export async function cleanupRunnerWorkspace(
  paths: readonly string[],
): Promise<void> {
  for (const path of paths) {
    if (!path.startsWith("/runner/_work/") && !path.startsWith("/runner/tmp/"))
      throw new Error("github_jit_cleanup_path_unsafe");
    try {
      await rm(path, { force: true, recursive: true });
    } catch {
      throw new Error("github_jit_cleanup_remove_failed");
    }
  }
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
  readonly runnerName: string;
}

type Fetch = typeof fetch;
async function json(
  response: Response,
  operation: string,
): Promise<Record<string, unknown>> {
  if (!response.ok)
    throw new Error(`github_jit_${operation}_failed:${response.status}`);
  try {
    const value = await response.json();
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new Error(`github_jit_${operation}_response_invalid`);
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
): Promise<string> {
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
    !/^rr-[A-Za-z0-9_-]+$/u.test(context.runnerName) ||
    !token
  )
    throw new Error("github_jit_context_invalid");
  const headers = header(token);
  const org = await json(
    await fetchImpl(`https://api.github.com/orgs/${context.organization}`, {
      headers,
    }),
    "organization_lookup",
  );
  if (org.login !== context.organization || org.type !== "Organization")
    throw new Error("github_jit_personal_owner_forbidden");
  const repository = await json(
    await fetchImpl(`https://api.github.com/repos/${context.repository}`, {
      headers,
    }),
    "repository_lookup",
  );
  if (
    repository.full_name !== context.repository ||
    !repository.owner ||
    typeof repository.owner !== "object" ||
    (repository.owner as Record<string, unknown>).type !== "Organization" ||
    (repository.owner as Record<string, unknown>).login !== context.organization
  )
    throw new Error("github_jit_control_repository_mismatch");
  const group = await json(
    await fetchImpl(
      `https://api.github.com/orgs/${context.organization}/actions/runner-groups/${context.runnerGroupId}`,
      { headers },
    ),
    "runner_group_lookup",
  );
  const selectedWorkflow = `${context.repository}/${context.workflowPath}@${context.workflowRef}`;
  if (
    group.id !== context.runnerGroupId ||
    group.visibility !== "selected" ||
    group.allows_public_repositories !== false ||
    group.restricted_to_workflows !== true ||
    !Array.isArray(group.selected_workflows) ||
    group.selected_workflows.length !== 1 ||
    group.selected_workflows[0] !== selectedWorkflow
  )
    throw new Error("github_jit_runner_group_policy_mismatch");
  const selected = await json(
    await fetchImpl(
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
    await fetchImpl(
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
    await fetchImpl(
      `https://api.github.com/repos/${context.repository}/actions/runs/${context.runId}/attempts/${context.runAttempt}/jobs?filter=latest&per_page=100`,
      { headers },
    ),
    "jobs_lookup",
  );
  if (!Array.isArray(jobs.jobs))
    throw new Error("github_jit_jobs_response_invalid");
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
    job.runner_name !== null
  )
    throw new Error("github_jit_target_job_identity_mismatch");
  const generated = await json(
    await fetchImpl(
      `https://api.github.com/orgs/${context.organization}/actions/runners/generate-jitconfig`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          name: context.runnerName,
          runner_group_id: context.runnerGroupId,
          labels: [],
          work_folder: "_work",
        }),
      },
    ),
    "generation",
  );
  if (
    typeof generated.encoded_jit_config !== "string" ||
    generated.encoded_jit_config.length < 16 ||
    !generated.runner ||
    typeof generated.runner !== "object" ||
    (generated.runner as Record<string, unknown>).name !== context.runnerName ||
    (generated.runner as Record<string, unknown>).status !== "offline" ||
    (generated.runner as Record<string, unknown>).busy !== false
  )
    throw new Error("github_jit_response_invalid");
  return generated.encoded_jit_config;
}
