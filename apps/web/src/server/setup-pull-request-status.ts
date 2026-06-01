type GitHubRequester = {
  request: (
    route: string,
    parameters?: Record<string, unknown>,
  ) => Promise<{ data: unknown }>;
};

export type SetupPullRequestStatus =
  | "merged"
  | "open"
  | "closed"
  | "branch_deleted"
  | "wrong_base_branch";

export type SetupPullRequestInspection = {
  readonly status: SetupPullRequestStatus;
  readonly baseBranch: string | null;
};

export async function inspectSetupPullRequest(
  input: {
    readonly owner: string;
    readonly name: string;
    readonly pullRequestNumber: number;
    readonly setupBranch: string | null;
    readonly allowedBaseBranches?: readonly string[];
  },
  octokit: GitHubRequester,
): Promise<SetupPullRequestInspection> {
  const setupBranch = input.setupBranch;
  const pullRequest = await readPullRequest(input, octokit);
  if (!pullRequest) {
    if (setupBranch) {
      return {
        status: (await setupBranchExists({ ...input, setupBranch }, octokit))
          ? "closed"
          : "branch_deleted",
        baseBranch: null,
      };
    }
    return { status: "closed", baseBranch: null };
  }

  const setupBranchMatches =
    !setupBranch || pullRequest.headRef === setupBranch;
  if (
    setupBranchMatches &&
    input.allowedBaseBranches &&
    input.allowedBaseBranches.length > 0 &&
    pullRequest.baseRef &&
    !input.allowedBaseBranches.includes(pullRequest.baseRef)
  ) {
    return { status: "wrong_base_branch", baseBranch: pullRequest.baseRef };
  }

  if (pullRequest.merged && setupBranchMatches) {
    return { status: "merged", baseBranch: pullRequest.baseRef };
  }

  if (
    setupBranch &&
    !(await setupBranchExists({ ...input, setupBranch }, octokit))
  ) {
    return { status: "branch_deleted", baseBranch: pullRequest.baseRef };
  }

  if (pullRequest.state === "closed") {
    return { status: "closed", baseBranch: pullRequest.baseRef };
  }

  return { status: "open", baseBranch: pullRequest.baseRef };
}

export async function inspectSetupPullRequestStatus(
  input: {
    readonly owner: string;
    readonly name: string;
    readonly pullRequestNumber: number;
    readonly setupBranch: string | null;
    readonly allowedBaseBranches?: readonly string[];
  },
  octokit: GitHubRequester,
): Promise<SetupPullRequestStatus> {
  return (await inspectSetupPullRequest(input, octokit)).status;
}

async function readPullRequest(
  input: {
    readonly owner: string;
    readonly name: string;
    readonly pullRequestNumber: number;
  },
  octokit: GitHubRequester,
): Promise<{
  readonly merged: boolean;
  readonly state: string | null;
  readonly headRef: string | null;
  readonly baseRef: string | null;
} | null> {
  try {
    const response = await octokit.request(
      "GET /repos/{owner}/{repo}/pulls/{pull_number}",
      {
        owner: input.owner,
        repo: input.name,
        pull_number: input.pullRequestNumber,
      },
    );
    return parsePullRequest(response.data);
  } catch (error) {
    if (githubApiStatus(error) === 404) {
      return null;
    }
    throw error;
  }
}

async function setupBranchExists(
  input: {
    readonly owner: string;
    readonly name: string;
    readonly setupBranch: string;
  },
  octokit: GitHubRequester,
): Promise<boolean> {
  try {
    await octokit.request("GET /repos/{owner}/{repo}/git/ref/{ref}", {
      owner: input.owner,
      repo: input.name,
      ref: `heads/${input.setupBranch}`,
    });
    return true;
  } catch (error) {
    if (githubApiStatus(error) === 404) {
      return false;
    }
    throw error;
  }
}

function parsePullRequest(data: unknown): {
  readonly merged: boolean;
  readonly state: string | null;
  readonly headRef: string | null;
  readonly baseRef: string | null;
} {
  if (typeof data !== "object" || data === null) {
    return { merged: false, state: null, headRef: null, baseRef: null };
  }

  const pullRequest = data as {
    readonly merged?: unknown;
    readonly state?: unknown;
    readonly head?: { readonly ref?: unknown };
    readonly base?: { readonly ref?: unknown };
  };
  return {
    merged: pullRequest.merged === true,
    state: typeof pullRequest.state === "string" ? pullRequest.state : null,
    headRef:
      typeof pullRequest.head?.ref === "string" ? pullRequest.head.ref : null,
    baseRef:
      typeof pullRequest.base?.ref === "string" ? pullRequest.base.ref : null,
  };
}

function githubApiStatus(error: unknown): number | null {
  return typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof error.status === "number"
    ? error.status
    : null;
}
