export type RecoveryRun = Readonly<{
  run_id: string;
  run_attempt: string;
  head_sha: string;
}>;

type WorkflowRun = {
  id?: number;
  display_title?: string;
  event?: string;
  head_sha?: string;
  head_branch?: string;
  path?: string;
  run_attempt?: number;
};

export type RecoverySweepCheckpoint = Readonly<{
  version: 1;
  repository: string;
  workflow_path: string;
  created_through: string;
  total_count: number;
  next_page: number;
  last_run_id: string;
}>;

export type RecoveryDiscovery = Readonly<{
  runs: RecoveryRun[];
  complete: boolean;
  checkpoint?: RecoverySweepCheckpoint;
}>;

const rolloutPrefix = "private-pg17:";
const pageSize = 100;
const maximumMatrixSize = 250;
const checkpointKeys = [
  "created_through",
  "last_run_id",
  "next_page",
  "repository",
  "total_count",
  "version",
  "workflow_path",
] as const;

const validRepository = (value: string) =>
  /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value);
const validWorkflowPath = (value: string) =>
  /^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/u.test(value);
const validTimestamp = (value: string) =>
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(value) &&
  new Date(value).toISOString().replace(".000Z", "Z") === value;

export function parsePrivatePg17RecoveryCheckpoint(
  value: string,
): RecoverySweepCheckpoint {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("private_pg17_recovery_checkpoint_invalid");
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    Object.keys(parsed).sort().join("\n") !== checkpointKeys.join("\n")
  )
    throw new Error("private_pg17_recovery_checkpoint_invalid");
  const checkpoint = parsed as Record<string, unknown>;
  if (
    checkpoint.version !== 1 ||
    typeof checkpoint.repository !== "string" ||
    !validRepository(checkpoint.repository) ||
    typeof checkpoint.workflow_path !== "string" ||
    !validWorkflowPath(checkpoint.workflow_path) ||
    typeof checkpoint.created_through !== "string" ||
    !validTimestamp(checkpoint.created_through) ||
    !Number.isSafeInteger(checkpoint.total_count) ||
    Number(checkpoint.total_count) < 1 ||
    !Number.isSafeInteger(checkpoint.next_page) ||
    Number(checkpoint.next_page) < 2 ||
    Number(checkpoint.next_page) >
      Math.floor((Number(checkpoint.total_count) - 1) / pageSize) + 1 ||
    typeof checkpoint.last_run_id !== "string" ||
    !/^[1-9]\d*$/u.test(checkpoint.last_run_id)
  )
    throw new Error("private_pg17_recovery_checkpoint_invalid");
  return checkpoint as unknown as RecoverySweepCheckpoint;
}

export function selectPrivatePg17RecoveryRuns(input: {
  runs: readonly WorkflowRun[];
  workflowPath: string;
}): RecoveryRun[] {
  const selected = input.runs
    .filter(
      (run) =>
        Number.isSafeInteger(run.id) &&
        run.id! > 0 &&
        run.run_attempt === 1 &&
        run.event === "workflow_dispatch" &&
        run.head_branch === "main" &&
        run.path === `${input.workflowPath}@refs/heads/main` &&
        /^[a-f0-9]{40}$/u.test(run.head_sha ?? "") &&
        run.display_title?.startsWith(rolloutPrefix) &&
        /^[A-Za-z0-9][A-Za-z0-9._:-]{2,255}$/u.test(
          run.display_title.slice(rolloutPrefix.length),
        ),
    )
    .map((run) => ({
      run_id: String(run.id),
      run_attempt: "1",
      head_sha: run.head_sha!,
    }));
  const deduplicated = new Map(selected.map((run) => [run.run_id, run]));
  return [...deduplicated.values()].sort((left, right) => {
    const leftId = BigInt(left.run_id);
    const rightId = BigInt(right.run_id);
    return leftId === rightId ? 0 : leftId > rightId ? -1 : 1;
  });
}

export async function discoverPrivatePg17RecoveryRuns(input: {
  repository: string;
  workflowPath: string;
  token: string;
  targetRunId?: string;
  maximumPages: number;
  checkpoint?: string;
  scanStartedAt?: string;
  request?: typeof fetch;
}): Promise<RecoveryDiscovery> {
  if (
    !validRepository(input.repository) ||
    !validWorkflowPath(input.workflowPath) ||
    !input.token ||
    !Number.isSafeInteger(input.maximumPages) ||
    input.maximumPages < 1 ||
    input.maximumPages * pageSize > maximumMatrixSize ||
    (input.targetRunId !== undefined &&
      !/^[1-9]\d*$/u.test(input.targetRunId)) ||
    (input.targetRunId !== undefined && input.checkpoint !== undefined)
  )
    throw new Error("private_pg17_recovery_discovery_input_invalid");
  const request = input.request ?? fetch;
  const headers = {
    Authorization: `Bearer ${input.token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (input.targetRunId) {
    const response = await request(
      `https://api.github.com/repos/${input.repository}/actions/runs/${input.targetRunId}`,
      { headers },
    );
    if (!response.ok)
      throw new Error(`private_pg17_recovery_lookup_failed:${response.status}`);
    return {
      runs: selectPrivatePg17RecoveryRuns({
        runs: [(await response.json()) as WorkflowRun],
        workflowPath: input.workflowPath,
      }),
      complete: true,
    };
  }

  const checkpoint = input.checkpoint
    ? parsePrivatePg17RecoveryCheckpoint(input.checkpoint)
    : undefined;
  if (
    checkpoint &&
    (checkpoint.repository !== input.repository ||
      checkpoint.workflow_path !== input.workflowPath)
  )
    throw new Error("private_pg17_recovery_checkpoint_scope_mismatch");
  const createdThrough =
    checkpoint?.created_through ??
    input.scanStartedAt ??
    new Date(Math.floor(Date.now() / 1_000) * 1_000)
      .toISOString()
      .replace(".000Z", "Z");
  if (!validTimestamp(createdThrough))
    throw new Error("private_pg17_recovery_discovery_input_invalid");
  const firstPage = checkpoint?.next_page ?? 1;
  const expectedTotal = checkpoint?.total_count;
  let lastRunId = checkpoint ? BigInt(checkpoint.last_run_id) : undefined;
  let totalCount = expectedTotal;
  const runs: WorkflowRun[] = [];
  let page = firstPage;

  for (
    let consumed = 0;
    consumed < input.maximumPages;
    consumed += 1, page += 1
  ) {
    const workflowFile = input.workflowPath.slice(
      input.workflowPath.lastIndexOf("/") + 1,
    );
    const query = new URLSearchParams({
      event: "workflow_dispatch",
      created: `<=${createdThrough}`,
      per_page: String(pageSize),
      page: String(page),
    });
    const response = await request(
      `https://api.github.com/repos/${input.repository}/actions/workflows/${encodeURIComponent(workflowFile)}/runs?${query.toString()}`,
      { headers },
    );
    if (!response.ok)
      throw new Error(`private_pg17_recovery_list_failed:${response.status}`);
    const value = (await response.json()) as {
      total_count?: number;
      workflow_runs?: WorkflowRun[];
    };
    if (
      !Number.isSafeInteger(value.total_count) ||
      value.total_count! < 0 ||
      !Array.isArray(value.workflow_runs) ||
      value.workflow_runs.length > pageSize
    )
      throw new Error("private_pg17_recovery_list_invalid");
    const pageTotal = Number(value.total_count);
    totalCount ??= pageTotal;
    if (totalCount !== pageTotal)
      throw new Error("private_pg17_recovery_list_changed");
    const alreadyScanned = (page - 1) * pageSize;
    const expectedPageSize = Math.min(
      pageSize,
      Math.max(0, totalCount - alreadyScanned),
    );
    if (value.workflow_runs.length !== expectedPageSize)
      throw new Error("private_pg17_recovery_list_page_incomplete");
    for (const run of value.workflow_runs) {
      if (!Number.isSafeInteger(run.id) || run.id! < 1)
        throw new Error("private_pg17_recovery_list_run_identity_invalid");
      const runId = BigInt(run.id!);
      if (lastRunId !== undefined && runId >= lastRunId)
        throw new Error("private_pg17_recovery_list_order_changed");
      lastRunId = runId;
      runs.push(run);
    }
    if (alreadyScanned + value.workflow_runs.length === totalCount) {
      return {
        runs: selectPrivatePg17RecoveryRuns({
          runs,
          workflowPath: input.workflowPath,
        }),
        complete: true,
      };
    }
  }

  if (totalCount === undefined || lastRunId === undefined)
    throw new Error("private_pg17_recovery_list_invalid");
  const selected = selectPrivatePg17RecoveryRuns({
    runs,
    workflowPath: input.workflowPath,
  });
  if (selected.length > maximumMatrixSize)
    throw new Error("private_pg17_recovery_matrix_limit_exceeded");
  return {
    runs: selected,
    complete: false,
    checkpoint: {
      version: 1,
      repository: input.repository,
      workflow_path: input.workflowPath,
      created_through: createdThrough,
      total_count: totalCount,
      next_page: page,
      last_run_id: String(lastRunId),
    },
  };
}

export async function dispatchPrivatePg17RecoveryContinuation(input: {
  repository: string;
  workflowFile: string;
  token: string;
  checkpoint: RecoverySweepCheckpoint;
  attempts: number;
  initialDelayMs: number;
  maximumDelayMs: number;
  request?: typeof fetch;
  wait?: (delayMs: number) => Promise<void>;
}): Promise<void> {
  if (
    !validRepository(input.repository) ||
    !/^[A-Za-z0-9_.-]+\.ya?ml$/u.test(input.workflowFile) ||
    !input.token ||
    !Number.isSafeInteger(input.attempts) ||
    input.attempts < 1 ||
    input.attempts > 8 ||
    !Number.isSafeInteger(input.initialDelayMs) ||
    input.initialDelayMs < 0 ||
    !Number.isSafeInteger(input.maximumDelayMs) ||
    input.maximumDelayMs < input.initialDelayMs ||
    input.maximumDelayMs > 30_000 ||
    input.checkpoint.repository !== input.repository
  )
    throw new Error("private_pg17_recovery_continuation_input_invalid");
  const request = input.request ?? fetch;
  const wait =
    input.wait ??
    ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  for (let attempt = 1; attempt <= input.attempts; attempt += 1) {
    const response = await request(
      `https://api.github.com/repos/${input.repository}/actions/workflows/${encodeURIComponent(input.workflowFile)}/dispatches`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${input.token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify({
          ref: "main",
          inputs: { sweep_checkpoint: JSON.stringify(input.checkpoint) },
        }),
      },
    );
    if (response.status === 204) return;
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt === input.attempts)
      throw new Error(
        `private_pg17_recovery_continuation_failed:${response.status}`,
      );
    const delay = Math.min(
      input.maximumDelayMs,
      input.initialDelayMs * 2 ** (attempt - 1),
    );
    await wait(delay);
  }
}
