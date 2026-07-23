import { App } from "@octokit/app";
import type {
  ReviewRequestedDispatchGatewayPort,
  ReviewRequestedIntent,
} from "@reviewrouter/features-review-executions";
import { ReviewRequestedDispatchRunStatus } from "@reviewrouter/features-review-executions";
import type { createPrismaClient } from "@reviewrouter/platform-db";

type PrismaClient = ReturnType<typeof createPrismaClient>;

type OctokitRequester = {
  request(
    route: string,
    parameters?: Readonly<Record<string, unknown>>,
  ): Promise<{ readonly data: unknown }>;
};

export class GitHubActionsReviewRequestedDispatchGateway implements ReviewRequestedDispatchGatewayPort {
  private readonly installations: InstallationClientPort;

  constructor(
    private readonly prisma: PrismaClient,
    credentials: { readonly appId: string; readonly privateKey: string },
    private readonly workflowPath = ".github/workflows/reviewrouter-codex.yml",
    installations?: InstallationClientPort,
  ) {
    const app = installations ? null : new App(credentials);
    this.installations =
      installations ??
      ({
        forInstallation: (installationId) =>
          app!.getInstallationOctokit(installationId),
      } satisfies InstallationClientPort);
  }

  async dispatch(input: { readonly intent: ReviewRequestedIntent }) {
    const target = await this.resolveTarget(input.intent);
    const octokit = await this.installations.forInstallation(
      installationId(target.githubInstallationId),
    );
    const existing = await this.findExistingRun(
      octokit,
      target,
      input.intent.requestId,
    );
    if (existing) return existing;

    const response = await octokit.request(
      "POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches",
      {
        owner: target.owner,
        repo: target.repo,
        workflow_id: this.workflowPath,
        ref: target.defaultBranch,
        inputs: {
          review_request_id: input.intent.requestId,
          pr_number: String(input.intent.pullRequestNumber),
          review_head_sha: input.intent.revision.headSha,
        },
        return_run_details: true,
        headers: { "X-GitHub-Api-Version": "2026-03-10" },
      },
    );
    return parseDispatchResponse(response.data);
  }

  async inspect(input: { readonly intent: ReviewRequestedIntent }) {
    const target = await this.resolveTarget(input.intent);
    const octokit = await this.installations.forInstallation(
      installationId(target.githubInstallationId),
    );
    const response = await octokit.request(
      "GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}",
      {
        owner: target.owner,
        repo: target.repo,
        run_id: requiredRunIdentity(
          input.intent.sourceRunId,
          "review_requested_inspection_run_missing",
        ),
        attempt_number: Number(
          requiredRunIdentity(
            input.intent.sourceRunAttempt,
            "review_requested_inspection_attempt_missing",
          ),
        ),
        headers: { "X-GitHub-Api-Version": "2026-03-10" },
      },
    );
    const run = parseInspectionResponse(response.data, input.intent);
    if (!run.completed) {
      return { status: ReviewRequestedDispatchRunStatus.Pending };
    }
    const pullRequest = await octokit.request(
      "GET /repos/{owner}/{repo}/pulls/{pull_number}",
      {
        owner: target.owner,
        repo: target.repo,
        pull_number: input.intent.pullRequestNumber,
        headers: { "X-GitHub-Api-Version": "2026-03-10" },
      },
    );
    return parseRevisionInspection(pullRequest.data, input.intent);
  }

  private async findExistingRun(
    octokit: OctokitRequester,
    target: DispatchTarget,
    requestId: string,
  ): Promise<{
    readonly sourceRunId: string;
    readonly sourceRunAttempt: string;
  } | null> {
    for (let page = 1; page <= 5; page += 1) {
      const response = await octokit.request(
        "GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs",
        {
          owner: target.owner,
          repo: target.repo,
          workflow_id: this.workflowPath,
          event: "workflow_dispatch",
          per_page: 100,
          page,
          headers: { "X-GitHub-Api-Version": "2026-03-10" },
        },
      );
      const parsed = parseWorkflowRunsPage(response.data, requestId);
      if (parsed.match || !parsed.hasNextPage) return parsed.match;
    }
    throw new Error("review_requested_dispatch_reconciliation_window_exceeded");
  }

  private async resolveTarget(
    intent: ReviewRequestedIntent,
  ): Promise<DispatchTarget> {
    const repository = await this.prisma.repositoryConnection.findUnique({
      where: { id: intent.repositoryConnectionId },
      select: {
        id: true,
        workspaceId: true,
        scmRepositoryIdentityId: true,
        owner: true,
        name: true,
        defaultBranch: true,
        provider: true,
        selected: true,
        archived: true,
        installation: {
          select: { status: true, githubInstallationId: true },
        },
      },
    });
    if (
      !repository ||
      repository.workspaceId !== intent.workspaceId ||
      repository.scmRepositoryIdentityId !== intent.scmRepositoryIdentityId ||
      repository.provider !== "github" ||
      !repository.selected ||
      repository.archived ||
      repository.installation?.status !== "active"
    ) {
      throw new Error("review_requested_dispatch_repository_unavailable");
    }
    return {
      owner: repository.owner,
      repo: repository.name,
      defaultBranch: repository.defaultBranch,
      githubInstallationId:
        repository.installation.githubInstallationId.toString(),
    };
  }
}

type DispatchTarget = Readonly<{
  owner: string;
  repo: string;
  defaultBranch: string;
  githubInstallationId: string;
}>;

type InstallationClientPort = {
  forInstallation(installationId: number): Promise<OctokitRequester>;
};

function parseDispatchResponse(data: unknown): {
  readonly sourceRunId: string;
  readonly sourceRunAttempt: string;
} {
  if (!isRecord(data)) {
    throw new Error("review_requested_dispatch_run_details_missing");
  }
  const runId = data.workflow_run_id;
  if (
    (typeof runId !== "number" && typeof runId !== "string") ||
    !/^[1-9][0-9]*$/.test(String(runId))
  ) {
    throw new Error("review_requested_dispatch_run_id_invalid");
  }
  return { sourceRunId: String(runId), sourceRunAttempt: "1" };
}

function parseWorkflowRunsPage(
  data: unknown,
  requestId: string,
): Readonly<{
  match: {
    readonly sourceRunId: string;
    readonly sourceRunAttempt: string;
  } | null;
  hasNextPage: boolean;
}> {
  if (!isRecord(data) || !Array.isArray(data.workflow_runs)) {
    throw new Error("review_requested_workflow_runs_invalid");
  }
  const expectedTitle = `ReviewRouter review ${requestId}`;
  for (const value of data.workflow_runs) {
    if (!isRecord(value) || value.display_title !== expectedTitle) continue;
    const id = value.id;
    const attempt = value.run_attempt;
    if (
      (typeof id !== "number" && typeof id !== "string") ||
      !/^[1-9][0-9]*$/.test(String(id)) ||
      typeof attempt !== "number" ||
      !Number.isSafeInteger(attempt) ||
      attempt <= 0
    ) {
      throw new Error("review_requested_workflow_run_identity_invalid");
    }
    return {
      match: {
        sourceRunId: String(id),
        sourceRunAttempt: String(attempt),
      },
      hasNextPage: false,
    };
  }
  return { match: null, hasNextPage: data.workflow_runs.length === 100 };
}

function parseInspectionResponse(
  data: unknown,
  intent: ReviewRequestedIntent,
): { readonly completed: boolean } {
  if (!isRecord(data)) {
    throw new Error("review_requested_inspection_response_invalid");
  }
  const expectedRunId = requiredRunIdentity(
    intent.sourceRunId,
    "review_requested_inspection_run_missing",
  );
  const expectedAttempt = requiredRunIdentity(
    intent.sourceRunAttempt,
    "review_requested_inspection_attempt_missing",
  );
  if (
    String(data.id) !== expectedRunId ||
    String(data.run_attempt) !== expectedAttempt ||
    data.event !== "workflow_dispatch" ||
    data.display_title !== `ReviewRouter review ${intent.requestId}` ||
    typeof data.status !== "string"
  ) {
    throw new Error("review_requested_inspection_identity_invalid");
  }
  return { completed: data.status === "completed" };
}

function parseRevisionInspection(
  data: unknown,
  intent: ReviewRequestedIntent,
): { readonly status: ReviewRequestedDispatchRunStatus } {
  if (
    !isRecord(data) ||
    !isRecord(data.head) ||
    !isRecord(data.base) ||
    typeof data.head.sha !== "string" ||
    typeof data.base.sha !== "string" ||
    !/^[a-f0-9]{40}$/i.test(data.head.sha) ||
    !/^[a-f0-9]{40}$/i.test(data.base.sha)
  ) {
    throw new Error("review_requested_revision_inspection_invalid");
  }
  return {
    status:
      data.head.sha.toLowerCase() === intent.revision.headSha.toLowerCase() &&
      data.base.sha.toLowerCase() === intent.revision.baseSha.toLowerCase()
        ? ReviewRequestedDispatchRunStatus.TerminalCurrentRevision
        : ReviewRequestedDispatchRunStatus.TerminalStaleRevision,
  };
}

function installationId(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("review_requested_installation_id_invalid");
  }
  return parsed;
}

function requiredRunIdentity(value: string | null, error: string): string {
  if (!value || !/^[1-9][0-9]*$/.test(value)) throw new Error(error);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
