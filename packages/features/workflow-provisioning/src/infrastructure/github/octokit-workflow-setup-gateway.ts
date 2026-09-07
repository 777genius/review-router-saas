import { preferredSetupBaseBranches } from "../../domain/workflow-provisioning";
import { Buffer } from "node:buffer";
import type {
  WorkflowSetupFile,
  WorkflowSetupGatewayInput,
  WorkflowSetupGatewayPort,
  WorkflowSetupPullRequest,
} from "../../application/ports/workflow-setup-gateway-port";

type GitHubRequester = {
  request: (
    route: string,
    parameters?: Record<string, unknown>,
  ) => Promise<{ data: unknown }>;
};

function getErrorStatus(error: unknown): number {
  return typeof error === "object" && error !== null && "status" in error
    ? Number(error.status)
    : 0;
}

export class OctokitWorkflowSetupGateway implements WorkflowSetupGatewayPort {
  constructor(private readonly octokit: GitHubRequester) {}

  async createOrUpdateSetupPullRequest(
    input: WorkflowSetupGatewayInput,
  ): Promise<WorkflowSetupPullRequest> {
    const baseBranch = await this.resolveSetupPullRequestBaseBranch(input);
    const { data: ref } = await this.octokit.request(
      "GET /repos/{owner}/{repo}/git/ref/{ref}",
      {
        owner: input.owner,
        repo: input.repo,
        ref: `heads/${baseBranch}`,
      },
    );
    const sha = parseGitRefSha(ref);
    let existingOpenPullRequest: GitHubPullRequest | null | undefined;

    try {
      await this.octokit.request("POST /repos/{owner}/{repo}/git/refs", {
        owner: input.owner,
        repo: input.repo,
        ref: `refs/heads/${input.setupBranch}`,
        sha,
      });
    } catch (error: unknown) {
      if (getErrorStatus(error) !== 422) throw error;
      existingOpenPullRequest = await this.findOpenSetupPullRequest({
        ...input,
        baseBranch,
      });
      if (!existingOpenPullRequest) {
        await this.resetSetupBranch(input, sha);
      }
    }

    for (const file of input.workflowFiles) {
      if (file.operation === "delete") {
        await this.deleteWorkflowFileIfTrusted(input, file);
      } else {
        await this.createOrUpdateWorkflowFile(input, file);
      }
    }

    // Bind the intended files to an immutable revision before recording the PR.
    const { data: writtenRef } = await this.octokit.request(
      "GET /repos/{owner}/{repo}/git/ref/{ref}",
      {
        owner: input.owner,
        repo: input.repo,
        ref: `heads/${input.setupBranch}`,
      },
    );
    const headSha = parseGitRefSha(writtenRef);
    if (!/^[a-f0-9]{40}$/.test(headSha))
      throw new Error("workflow_provisioning_artifact_invalid");
    for (const file of input.workflowFiles) {
      const installed = await this.readWorkflowFile(
        { ...input, setupBranch: headSha },
        file.path,
      );
      if (
        file.operation === "delete"
          ? installed.sha !== null
          : installed.content !== file.content
      )
        throw new Error("workflow_provisioning_artifact_mismatch");
    }

    const pullRequest = await this.getOrCreateSetupPullRequest(
      {
        ...input,
        baseBranch,
      },
      existingOpenPullRequest,
    );

    if (pullRequest.headSha !== headSha)
      throw new Error("workflow_provisioning_artifact_mismatch");
    return {
      headSha,
      url: pullRequest.html_url,
      number: pullRequest.number,
      branch: input.setupBranch,
      baseBranch,
    };
  }

  private async resolveSetupPullRequestBaseBranch(
    input: WorkflowSetupGatewayInput,
  ): Promise<string> {
    for (const branch of preferredSetupBaseBranches(input.baseBranch)) {
      if (await this.branchExists(input, branch)) {
        return branch;
      }
    }
    return input.baseBranch;
  }

  private async branchExists(
    input: WorkflowSetupGatewayInput,
    branch: string,
  ): Promise<boolean> {
    try {
      await this.octokit.request("GET /repos/{owner}/{repo}/git/ref/{ref}", {
        owner: input.owner,
        repo: input.repo,
        ref: `heads/${branch}`,
      });
      return true;
    } catch (error: unknown) {
      if (getErrorStatus(error) === 404) {
        return false;
      }
      throw error;
    }
  }

  private async createOrUpdateWorkflowFile(
    input: WorkflowSetupGatewayInput,
    file: Extract<WorkflowSetupFile, { readonly operation?: "upsert" }>,
  ): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const existing = await this.readWorkflowFile(input, file.path);
      if (existing.content === file.content) {
        return;
      }

      try {
        await this.octokit.request(
          "PUT /repos/{owner}/{repo}/contents/{path}",
          {
            owner: input.owner,
            repo: input.repo,
            path: file.path,
            branch: input.setupBranch,
            ...(existing.sha ? { sha: existing.sha } : {}),
            message: "chore: add ReviewRouter workflows",
            content: Buffer.from(file.content).toString("base64"),
          },
        );
        return;
      } catch (error: unknown) {
        if (attempt === 0 && isGitHubWriteConflict(error)) {
          continue;
        }
        throw error;
      }
    }
  }

  private async deleteWorkflowFileIfTrusted(
    input: WorkflowSetupGatewayInput,
    file: Extract<WorkflowSetupFile, { readonly operation: "delete" }>,
  ): Promise<void> {
    const existing = await this.readWorkflowFile(input, file.path);
    if (!existing.sha || existing.content === null) {
      return;
    }
    if (!matchesAnyMarkerGroup(existing.content, file.markerGroups)) {
      throw new Error(`workflow_delete_untrusted:${file.path}`);
    }

    await this.octokit.request("DELETE /repos/{owner}/{repo}/contents/{path}", {
      owner: input.owner,
      repo: input.repo,
      path: file.path,
      branch: input.setupBranch,
      sha: existing.sha,
      message: "chore: remove legacy ReviewRouter workflow",
    });
  }

  private async readWorkflowFile(
    input: WorkflowSetupGatewayInput,
    filePath: string,
  ): Promise<{
    readonly sha: string | null;
    readonly content: string | null;
  }> {
    try {
      const { data: existing } = await this.octokit.request(
        "GET /repos/{owner}/{repo}/contents/{path}",
        {
          owner: input.owner,
          repo: input.repo,
          path: filePath,
          ref: input.setupBranch,
        },
      );
      return parseWorkflowFile(existing);
    } catch (error: unknown) {
      if (getErrorStatus(error) === 404) {
        return { sha: null, content: null };
      }
      throw error;
    }
  }

  private async resetSetupBranch(
    input: WorkflowSetupGatewayInput,
    sha: string,
  ): Promise<void> {
    await this.octokit.request("PATCH /repos/{owner}/{repo}/git/refs/{ref}", {
      owner: input.owner,
      repo: input.repo,
      ref: `heads/${input.setupBranch}`,
      sha,
      force: true,
    });
  }

  private async getOrCreateSetupPullRequest(
    input: WorkflowSetupGatewayInput,
    preloadedOpenPullRequest?: GitHubPullRequest | null,
  ): Promise<GitHubPullRequest> {
    const existing =
      preloadedOpenPullRequest === undefined
        ? await this.findOpenSetupPullRequest(input)
        : preloadedOpenPullRequest;
    if (existing) {
      return this.updateSetupPullRequestMetadata(input, existing);
    }

    const closed = await this.findClosedSetupPullRequest(input);
    if (closed) {
      try {
        return await this.reopenSetupPullRequest(input, closed);
      } catch (error: unknown) {
        if (!isGitHubWriteConflict(error)) {
          throw error;
        }
      }
    }

    try {
      const { data } = await this.octokit.request(
        "POST /repos/{owner}/{repo}/pulls",
        {
          owner: input.owner,
          repo: input.repo,
          title: setupPullRequestTitle,
          head: input.setupBranch,
          base: input.baseBranch,
          body: resolveSetupPullRequestBody(input),
        },
      );
      return parsePullRequest(data);
    } catch (error: unknown) {
      if (!isGitHubWriteConflict(error)) {
        throw error;
      }
      const racedPullRequest = await this.findOpenSetupPullRequest(input);
      if (racedPullRequest) {
        return this.updateSetupPullRequestMetadata(input, racedPullRequest);
      }
      const closedPullRequest = await this.findClosedSetupPullRequest(input);
      if (closedPullRequest) {
        try {
          return await this.reopenSetupPullRequest(input, closedPullRequest);
        } catch (reopenError: unknown) {
          if (!isGitHubWriteConflict(reopenError)) {
            throw reopenError;
          }
        }
      }
      throw error;
    }
  }

  private async updateSetupPullRequestMetadata(
    input: WorkflowSetupGatewayInput,
    pullRequest: GitHubPullRequest,
  ): Promise<GitHubPullRequest> {
    const { data } = await this.octokit.request(
      "PATCH /repos/{owner}/{repo}/pulls/{pull_number}",
      {
        owner: input.owner,
        repo: input.repo,
        pull_number: pullRequest.number,
        title: setupPullRequestTitle,
        base: input.baseBranch,
        body: resolveSetupPullRequestBody(input),
      },
    );
    return parsePullRequest(data);
  }

  private async reopenSetupPullRequest(
    input: WorkflowSetupGatewayInput,
    pullRequest: GitHubPullRequest,
  ): Promise<GitHubPullRequest> {
    const { data } = await this.octokit.request(
      "PATCH /repos/{owner}/{repo}/pulls/{pull_number}",
      {
        owner: input.owner,
        repo: input.repo,
        pull_number: pullRequest.number,
        title: setupPullRequestTitle,
        body: resolveSetupPullRequestBody(input),
        base: input.baseBranch,
        state: "open",
      },
    );
    return parsePullRequest(data);
  }

  private async findOpenSetupPullRequest(
    input: WorkflowSetupGatewayInput,
  ): Promise<GitHubPullRequest | null> {
    const { data } = await this.octokit.request(
      "GET /repos/{owner}/{repo}/pulls",
      {
        owner: input.owner,
        repo: input.repo,
        head: `${input.owner}:${input.setupBranch}`,
        state: "open",
      },
    );
    return Array.isArray(data) && data[0] ? parsePullRequest(data[0]) : null;
  }

  private async findClosedSetupPullRequest(
    input: WorkflowSetupGatewayInput,
  ): Promise<GitHubPullRequest | null> {
    const { data } = await this.octokit.request(
      "GET /repos/{owner}/{repo}/pulls",
      {
        owner: input.owner,
        repo: input.repo,
        head: `${input.owner}:${input.setupBranch}`,
        state: "closed",
      },
    );
    if (!Array.isArray(data)) {
      return null;
    }

    for (const item of data) {
      const pullRequest = parsePullRequest(item);
      if (pullRequest.mergedAt === null) {
        return pullRequest;
      }
    }
    return null;
  }
}

type GitHubPullRequest = {
  readonly headSha: string;
  readonly html_url: string;
  readonly number: number;
  readonly mergedAt: string | null;
};

const setupPullRequestTitle = "chore: add ReviewRouter workflow";

const setupPullRequestBody = [
  "This PR installs the ReviewRouter GitHub Actions workflows.",
  "",
  "Security defaults:",
  "- installs trusted pull_request_target ingress on the GitHub default branch",
  "- never checks out untrusted pull request code in secret-backed jobs",
  "- checks out code with persist-credentials: false",
  "- skips secret-backed review for fork pull requests by default",
  "- uses GitHub OIDC for SaaS runtime config",
  "- keeps provider secrets in this repository or organization Actions secrets",
  "- compact mode keeps small caller workflows here and runs versioned ReviewRouter runtime from `777genius/review-router`",
  "- rotating Codex setup removes legacy ReviewRouter workflows only when they match trusted ReviewRouter markers",
  "",
  "Workflow files:",
  "- `.github/workflows/reviewrouter.yml` - pull request review gate",
  "- `.github/workflows/reviewrouter-interaction.yml` - `/rr` comment commands and discussion routing",
  "- `.github/workflows/reviewrouter-codex.yml` - production Codex OAuth rotating review workflow",
].join("\n");

const hostedPoolSetupPullRequestBody = [
  "This PR installs the hosted ReviewRouter GitHub Actions workflow.",
  "",
  "Security defaults:",
  "- runs only from same-repository `pull_request` events and skips bot pull requests",
  "- uses the App-first ReviewRouter publication path; `github.token` does not publish reviews",
  "- grants OIDC `id-token: write` to the immutable ReviewRouter reusable workflow",
  "- uses the repository-scoped hosted provider identity and admitted pull request revision",
  "- requires no Codex OAuth or provider credential secret in this repository",
  "- removes legacy ReviewRouter workflows only when they match trusted ReviewRouter markers",
  "",
  "Workflow files:",
  "- `.github/workflows/reviewrouter-codex.yml` - hosted pull request review workflow",
].join("\n");

function resolveSetupPullRequestBody(input: WorkflowSetupGatewayInput): string {
  return input.setupMode === "hosted_pool"
    ? hostedPoolSetupPullRequestBody
    : setupPullRequestBody;
}

function parseWorkflowFile(data: unknown): {
  readonly sha: string | null;
  readonly content: string | null;
} {
  if (Array.isArray(data) || typeof data !== "object" || data === null) {
    return { sha: null, content: null };
  }
  const file = data as {
    readonly type?: unknown;
    readonly sha?: unknown;
    readonly content?: unknown;
  };
  if (file.type !== "file" || typeof file.sha !== "string") {
    return { sha: null, content: null };
  }
  return {
    sha: file.sha,
    content: decodeBase64Content(file.content),
  };
}

function parseGitRefSha(data: unknown): string {
  if (typeof data !== "object" || data === null) {
    throw new Error("github_ref_response_invalid");
  }
  const ref = data as { readonly object?: unknown };
  const object = Array.isArray(ref.object) ? ref.object[0] : ref.object;
  if (typeof object !== "object" || object === null) {
    throw new Error("github_ref_response_invalid");
  }
  const gitObject = object as { readonly sha?: unknown };
  if (typeof gitObject.sha !== "string") {
    throw new Error("github_ref_response_invalid");
  }
  return gitObject.sha;
}

function parsePullRequest(data: unknown): GitHubPullRequest {
  if (typeof data !== "object" || data === null) {
    throw new Error("github_pull_request_response_invalid");
  }
  const pullRequest = data as {
    readonly html_url?: unknown;
    readonly number?: unknown;
    readonly merged_at?: unknown;
    readonly head?: { readonly sha?: unknown };
  };
  if (
    typeof pullRequest.html_url !== "string" ||
    typeof pullRequest.number !== "number"
  ) {
    throw new Error("github_pull_request_response_invalid");
  }
  return {
    headSha:
      typeof pullRequest.head?.sha === "string" ? pullRequest.head.sha : "",
    html_url: pullRequest.html_url,
    number: pullRequest.number,
    mergedAt:
      typeof pullRequest.merged_at === "string" ? pullRequest.merged_at : null,
  };
}

function isGitHubWriteConflict(error: unknown): boolean {
  return [409, 422].includes(getErrorStatus(error));
}

function decodeBase64Content(content: unknown): string | null {
  if (typeof content !== "string") {
    return null;
  }
  return Buffer.from(content.replaceAll("\n", ""), "base64").toString("utf8");
}

function matchesAnyMarkerGroup(
  content: string,
  markerGroups: readonly (readonly string[])[],
): boolean {
  return markerGroups.some((group) =>
    group.every((marker) => content.includes(marker)),
  );
}
