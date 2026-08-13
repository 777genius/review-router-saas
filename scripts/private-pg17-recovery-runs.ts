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

const rolloutPrefix = "private-pg17:";

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
  return [...deduplicated.values()].sort(
    (left, right) => Number(right.run_id) - Number(left.run_id),
  );
}

export async function discoverPrivatePg17RecoveryRuns(input: {
  repository: string;
  workflowPath: string;
  token: string;
  targetRunId?: string;
  maximumPages: number;
  request?: typeof fetch;
}): Promise<RecoveryRun[]> {
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(input.repository) ||
    !/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/u.test(
      input.workflowPath,
    ) ||
    !input.token ||
    !Number.isSafeInteger(input.maximumPages) ||
    input.maximumPages < 1 ||
    input.maximumPages > 10 ||
    (input.targetRunId !== undefined && !/^\d+$/u.test(input.targetRunId))
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
    return selectPrivatePg17RecoveryRuns({
      runs: [(await response.json()) as WorkflowRun],
      workflowPath: input.workflowPath,
    });
  }

  const runs: WorkflowRun[] = [];
  const workflowFile = input.workflowPath.slice(
    input.workflowPath.lastIndexOf("/") + 1,
  );
  let totalCount: number | undefined;
  for (let page = 1; page <= input.maximumPages; page += 1) {
    const response = await request(
      `https://api.github.com/repos/${input.repository}/actions/workflows/${encodeURIComponent(workflowFile)}/runs?event=workflow_dispatch&per_page=100&page=${page}`,
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
      !Array.isArray(value.workflow_runs)
    )
      throw new Error("private_pg17_recovery_list_invalid");
    const pageTotal = Number(value.total_count);
    totalCount ??= pageTotal;
    if (totalCount !== pageTotal)
      throw new Error("private_pg17_recovery_list_changed");
    runs.push(...value.workflow_runs);
    if (runs.length >= totalCount || value.workflow_runs.length === 0) break;
  }
  if (totalCount === undefined || runs.length < totalCount)
    throw new Error("private_pg17_recovery_list_bound_exhausted");
  const selected = selectPrivatePg17RecoveryRuns({
    runs,
    workflowPath: input.workflowPath,
  });
  if (selected.length > 250)
    throw new Error("private_pg17_recovery_matrix_limit_exceeded");
  return selected;
}
