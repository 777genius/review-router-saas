import type {
  HostedPoolGitHubRequestPort,
  HostedPoolPublicationEvidence,
} from "./hosted-pool-production-ports";

export type CanonicalSourceRun = Readonly<{
  headSha: string;
  pullRequestNumber: number;
}>;

/** Proves rerun eligibility without accepting workflow_dispatch or prior reruns. */
export function assertCanonicalAttemptOnePullRequestRun(
  value: unknown,
  input: {
    runId: number;
    repositoryId: number;
    workflowPath: string;
  },
): CanonicalSourceRun {
  const run = value as any;
  if (
    run?.id !== input.runId ||
    run?.repository?.id !== input.repositoryId ||
    run?.run_attempt !== 1 ||
    run?.status !== "completed" ||
    run?.conclusion !== "success" ||
    run?.event !== "pull_request" ||
    !Array.isArray(run?.pull_requests) ||
    run.pull_requests.length !== 1 ||
    run.pull_requests[0]?.base?.repo?.id !== input.repositoryId ||
    !Number.isSafeInteger(run.pull_requests[0]?.number) ||
    !/^[a-f0-9]{40}$/iu.test(String(run?.head_sha ?? "")) ||
    (run?.path !== input.workflowPath &&
      !String(run?.path ?? "").startsWith(`${input.workflowPath}@`))
  )
    throw new Error(
      `hosted_pool_canary_source_run_not_one_shot:${input.runId}`,
    );
  return {
    headSha: String(run.head_sha).toLowerCase(),
    pullRequestNumber: run.pull_requests[0].number,
  };
}

/** Counts only ReviewRouter-marked publication objects and proves App authorship. */
export async function collectAppBotPublicationEvidence(
  github: HostedPoolGitHubRequestPort,
  input: {
    repository: string;
    pullRequestNumber: number;
    expectedAppBot: string;
    startedAt: Date;
    finishedAt: Date;
  },
): Promise<HostedPoolPublicationEvidence> {
  const objects = (
    await Promise.all(
      [
        `/repos/${input.repository}/issues/${input.pullRequestNumber}/comments?per_page=100`,
        `/repos/${input.repository}/pulls/${input.pullRequestNumber}/comments?per_page=100`,
        `/repos/${input.repository}/pulls/${input.pullRequestNumber}/reviews?per_page=100`,
      ].map((path) => github.request("GET", path)),
    )
  ).flatMap((items) => {
    if (!Array.isArray(items) || items.length >= 100)
      throw new Error("hosted_pool_canary_publication_pagination_unsupported");
    return items;
  });
  const publications = objects.filter((item: any) => {
    const publicationAt = latestPublicationTimestamp(item);
    return (
      publicationAt !== null &&
      publicationAt >= input.startedAt &&
      publicationAt <= input.finishedAt &&
      /(?:reviewrouter(?::|-)|review-router-finding:)/iu.test(
        String(item?.body ?? ""),
      )
    );
  });
  const appBotPublicationCount = publications.filter(
    (item: any) =>
      String(item?.user?.login ?? "").toLowerCase() ===
      input.expectedAppBot.toLowerCase(),
  ).length;
  return {
    appBotPublicationCount,
    nonAppBotPublicationCount: publications.length - appBotPublicationCount,
  };
}

function latestPublicationTimestamp(item: any): Date | null {
  const timestamps = [item?.created_at, item?.submitted_at, item?.updated_at]
    .map((value) => new Date(String(value ?? "")))
    .filter((value) => Number.isFinite(value.getTime()));
  if (timestamps.length === 0) return null;
  return new Date(Math.max(...timestamps.map((value) => value.getTime())));
}
