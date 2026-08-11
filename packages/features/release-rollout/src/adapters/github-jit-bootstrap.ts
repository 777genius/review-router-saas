import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";

export const bootstrapCredentialNames = Object.freeze([
  "REVIEW_ROUTER_RUNNER_GITHUB_APP_ID",
  "REVIEW_ROUTER_RUNNER_GITHUB_APP_INSTALLATION_ID",
  "REVIEW_ROUTER_RUNNER_GITHUB_APP_PRIVATE_KEY",
  "GITHUB_TOKEN",
  "GH_TOKEN",
]);

export function workflowEnvironment(
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const clean = { ...source };
  for (const name of bootstrapCredentialNames) delete clean[name];
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
  const spawnRunner = options.spawnImpl ?? spawn;
  const environment = workflowEnvironment(options.environment ?? process.env);
  const child = spawnRunner(
    options.runnerPath,
    ["--jitconfig", options.jitConfig],
    {
      ...(options.workingDirectory ? { cwd: options.workingDirectory } : {}),
      env: environment,
      stdio: "inherit",
    },
  );
  const exitCode = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("github_jit_no_job_timeout"));
    }, options.timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
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
  const failures: string[] = [];
  for (const path of paths) {
    if (
      !path.startsWith("/runner/_work/") &&
      !path.startsWith("/runner/tmp/")
    ) {
      failures.push("unsafe_path");
      continue;
    }
    try {
      await rm(path, { force: true, recursive: true });
    } catch {
      failures.push("remove_failed");
    }
  }
  if (failures.length)
    throw new Error(`github_jit_cleanup_failed:${failures.join(",")}`);
}

export interface JitApiContext {
  repository: string;
  runId: string;
  runAttempt: number;
  commitSha: string;
  actor: string;
  label: string;
  runnerName: string;
}

export async function requestJitConfiguration(
  context: JitApiContext,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(context.repository) ||
    !/^[1-9][0-9]*$/u.test(context.runId) ||
    !Number.isSafeInteger(context.runAttempt) ||
    context.runAttempt < 1 ||
    !/^[a-f0-9]{40}$/u.test(context.commitSha) ||
    !/^[A-Za-z0-9_.-]+$/u.test(context.actor) ||
    !/^rr-[A-Za-z0-9_-]+$/u.test(context.label) ||
    !/^rr-[A-Za-z0-9_-]+$/u.test(context.runnerName) ||
    !token
  )
    throw new Error("github_jit_context_invalid");
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const runResponse = await fetchImpl(
    `https://api.github.com/repos/${context.repository}/actions/runs/${context.runId}`,
    { headers },
  );
  if (!runResponse.ok)
    throw new Error(`github_jit_run_lookup_failed:${runResponse.status}`);
  const run = (await runResponse.json()) as Record<string, unknown>;
  if (
    run.id !== Number(context.runId) ||
    run.run_attempt !== context.runAttempt ||
    run.head_sha !== context.commitSha ||
    run.actor === null ||
    typeof run.actor !== "object" ||
    (run.actor as Record<string, unknown>).login !== context.actor ||
    run.path === undefined
  )
    throw new Error("github_jit_run_identity_mismatch");
  const response = await fetchImpl(
    `https://api.github.com/repos/${context.repository}/actions/runners/generate-jitconfig`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: context.runnerName,
        runner_group_id: 1,
        labels: ["self-hosted", context.label],
        work_folder: "_work",
      }),
    },
  );
  if (!response.ok)
    throw new Error(`github_jit_generation_failed:${response.status}`);
  const value = (await response.json()) as Record<string, unknown>;
  if (
    Object.keys(value).length !== 2 ||
    typeof value.encoded_jit_config !== "string" ||
    value.encoded_jit_config.length < 16 ||
    value.runner === null ||
    typeof value.runner !== "object" ||
    (value.runner as Record<string, unknown>).name !== context.runnerName ||
    (value.runner as Record<string, unknown>).status !== "offline" ||
    (value.runner as Record<string, unknown>).busy !== false
  )
    throw new Error("github_jit_response_invalid");
  return value.encoded_jit_config;
}
