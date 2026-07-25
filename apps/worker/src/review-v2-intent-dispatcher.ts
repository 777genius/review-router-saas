import { App } from "@octokit/app";
import { managedCodexWorkflowPath } from "@reviewrouter/features-action-control-plane";
import type {
  ReviewRequestedDispatchGatewayPort,
  ReviewRequestedIntent,
  ReviewRequestedPreparedDispatchPort,
} from "@reviewrouter/features-review-executions";
import {
  ReviewRequestedDispatchLookupStatus,
  ReviewRequestedDispatchRunStatus,
  ReviewRequestedDispatchSubmissionStatus,
} from "@reviewrouter/features-review-executions";
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
    private readonly workflowPath = managedCodexWorkflowPath,
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

  async prepare(input: {
    readonly intent: ReviewRequestedIntent;
  }): Promise<ReviewRequestedPreparedDispatchPort> {
    const target = await this.resolveTarget(input.intent);
    const octokit = await this.installations.forInstallation(
      installationId(target.githubInstallationId),
    );
    const dispatchRef = await resolveDispatchRef(octokit, target, input.intent);
    return Object.freeze({
      submit: async () => {
        try {
          const response = await octokit.request(
            "POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches",
            {
              owner: target.owner,
              repo: target.repo,
              workflow_id: this.workflowPath,
              ref: dispatchRef,
              inputs: {
                review_request_id: input.intent.requestId,
                pr_number: String(input.intent.pullRequestNumber),
                review_head_sha: input.intent.revision.headSha,
              },
              headers: { "X-GitHub-Api-Version": "2026-03-10" },
            },
          );
          return {
            status: ReviewRequestedDispatchSubmissionStatus.Accepted as const,
            ...parseDispatchResponse(response.data),
          };
        } catch (error) {
          if (requestStatus(error) === 422) {
            return {
              status:
                ReviewRequestedDispatchSubmissionStatus.DefinitelyNoEffect as const,
            };
          }
          throw error;
        }
      },
    });
  }

  async findByRequestIdentity(input: {
    readonly intent: ReviewRequestedIntent;
  }): ReturnType<ReviewRequestedDispatchGatewayPort["findByRequestIdentity"]> {
    const target = await this.resolveTarget(input.intent);
    const octokit = await this.installations.forInstallation(
      installationId(target.githubInstallationId),
    );
    return this.findExistingRun(octokit, target, input.intent);
  }

  async inspectKnownRun(input: { readonly intent: ReviewRequestedIntent }) {
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

  async cancelKnownRun(input: {
    readonly intent: ReviewRequestedIntent;
  }): Promise<void> {
    const target = await this.resolveTarget(input.intent);
    const octokit = await this.installations.forInstallation(
      installationId(target.githubInstallationId),
    );
    await octokit.request(
      "POST /repos/{owner}/{repo}/actions/runs/{run_id}/cancel",
      {
        owner: target.owner,
        repo: target.repo,
        run_id: requiredRunIdentity(
          input.intent.sourceRunId,
          "review_requested_cancellation_run_missing",
        ),
        headers: { "X-GitHub-Api-Version": "2026-03-10" },
      },
    );
  }

  private async findExistingRun(
    octokit: OctokitRequester,
    target: DispatchTarget,
    intent: ReviewRequestedIntent,
  ): ReturnType<ReviewRequestedDispatchGatewayPort["findByRequestIdentity"]> {
    const submissionStartedAt = intent.submissionStartedAt;
    if (submissionStartedAt === null) {
      throw new Error("review_requested_submission_time_missing");
    }
    // GitHub run timestamps have whole-second precision. Widen only to the
    // start of that second; the request-specific display title remains the
    // correlation identity.
    const searchLowerBound = new Date(
      Math.floor(submissionStartedAt.getTime() / 1_000) * 1_000,
    );
    const matches = new Map<
      string,
      { readonly sourceRunId: string; readonly sourceRunAttempt: string }
    >();
    for (let page = 1; page <= 5; page += 1) {
      const response = await octokit.request(
        "GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs",
        {
          owner: target.owner,
          repo: target.repo,
          workflow_id: this.workflowPath,
          event: "workflow_dispatch",
          created: `>=${searchLowerBound.toISOString()}`,
          per_page: 100,
          page,
          headers: { "X-GitHub-Api-Version": "2026-03-10" },
        },
      );
      const parsed = parseWorkflowRunsPage(
        response.data,
        intent.requestId,
        searchLowerBound,
      );
      for (const match of parsed.matches) {
        matches.set(`${match.sourceRunId}:${match.sourceRunAttempt}`, match);
      }
      if (!parsed.hasNextPage) {
        if (matches.size === 0) {
          return { status: ReviewRequestedDispatchLookupStatus.Absent };
        }
        if (matches.size === 1) {
          const [match] = matches.values();
          return {
            status: ReviewRequestedDispatchLookupStatus.Found,
            ...match!,
          };
        }
        return { status: ReviewRequestedDispatchLookupStatus.Inconclusive };
      }
    }
    return { status: ReviewRequestedDispatchLookupStatus.Inconclusive };
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
      githubInstallationId:
        repository.installation.githubInstallationId.toString(),
    };
  }
}

type DispatchTarget = Readonly<{
  owner: string;
  repo: string;
  githubInstallationId: string;
}>;

type InstallationClientPort = {
  forInstallation(installationId: number): Promise<OctokitRequester>;
};

async function resolveDispatchRef(
  octokit: OctokitRequester,
  target: DispatchTarget,
  intent: ReviewRequestedIntent,
): Promise<string> {
  const response = await octokit.request(
    "GET /repos/{owner}/{repo}/pulls/{pull_number}",
    {
      owner: target.owner,
      repo: target.repo,
      pull_number: intent.pullRequestNumber,
      headers: { "X-GitHub-Api-Version": "2026-03-10" },
    },
  );
  if (!isRecord(response.data)) {
    throw new Error("review_requested_dispatch_pull_request_invalid");
  }
  const pullRequest = response.data;
  const head = pullRequest.head;
  const base = pullRequest.base;
  const expectedRepository = `${target.owner}/${target.repo}`.toLowerCase();
  if (
    pullRequest.state !== "open" ||
    !isRecord(head) ||
    !isRecord(base) ||
    head.sha !== intent.revision.headSha ||
    base.sha !== intent.revision.baseSha ||
    repositoryFullName(head.repo) !== expectedRepository ||
    repositoryFullName(base.repo) !== expectedRepository
  ) {
    throw new Error("review_requested_dispatch_revision_changed");
  }
  const baseRef = base.ref;
  if (
    typeof baseRef !== "string" ||
    baseRef.length === 0 ||
    baseRef.trim() !== baseRef
  ) {
    throw new Error("review_requested_dispatch_base_ref_invalid");
  }
  return baseRef;
}

function repositoryFullName(value: unknown): string | null {
  if (
    !isRecord(value) ||
    typeof value.full_name !== "string" ||
    value.full_name.length === 0
  ) {
    return null;
  }
  return value.full_name.toLowerCase();
}

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
  submissionStartedAt: Date,
): Readonly<{
  matches: readonly {
    readonly sourceRunId: string;
    readonly sourceRunAttempt: string;
  }[];
  hasNextPage: boolean;
}> {
  if (!isRecord(data) || !Array.isArray(data.workflow_runs)) {
    throw new Error("review_requested_workflow_runs_invalid");
  }
  const expectedTitle = `ReviewRouter review ${requestId}`;
  const matches: Array<{
    readonly sourceRunId: string;
    readonly sourceRunAttempt: string;
  }> = [];
  for (const value of data.workflow_runs) {
    if (!isRecord(value) || value.display_title !== expectedTitle) continue;
    const id = value.id;
    const attempt = value.run_attempt;
    const createdAt = value.created_at;
    if (
      (typeof id !== "number" && typeof id !== "string") ||
      !/^[1-9][0-9]*$/.test(String(id)) ||
      typeof attempt !== "number" ||
      !Number.isSafeInteger(attempt) ||
      attempt <= 0 ||
      typeof createdAt !== "string" ||
      !Number.isFinite(Date.parse(createdAt))
    ) {
      throw new Error("review_requested_workflow_run_identity_invalid");
    }
    if (Date.parse(createdAt) < submissionStartedAt.getTime()) continue;
    matches.push({
      sourceRunId: String(id),
      sourceRunAttempt: String(attempt),
    });
  }
  return { matches, hasNextPage: data.workflow_runs.length === 100 };
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

function requestStatus(error: unknown): number | null {
  if (!isRecord(error) || typeof error.status !== "number") return null;
  return error.status;
}
