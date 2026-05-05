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
    const { data: ref } = await this.octokit.request(
      "GET /repos/{owner}/{repo}/git/ref/{ref}",
      {
        owner: input.owner,
        repo: input.repo,
        ref: `heads/${input.baseBranch}`,
      },
    );
    const sha = parseGitRefSha(ref);

    try {
      await this.octokit.request("POST /repos/{owner}/{repo}/git/refs", {
        owner: input.owner,
        repo: input.repo,
        ref: `refs/heads/${input.setupBranch}`,
        sha,
      });
    } catch (error: unknown) {
      if (getErrorStatus(error) !== 422) throw error;
    }

    for (const file of input.workflowFiles) {
      await this.createOrUpdateWorkflowFile(input, file);
    }

    const pullRequest = await this.getOrCreateSetupPullRequest(input);

    return {
      url: pullRequest.html_url,
      number: pullRequest.number,
      branch: input.setupBranch,
    };
  }

  private async createOrUpdateWorkflowFile(
    input: WorkflowSetupGatewayInput,
    file: WorkflowSetupFile,
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

  private async getOrCreateSetupPullRequest(
    input: WorkflowSetupGatewayInput,
  ): Promise<GitHubPullRequest> {
    const existing = await this.findOpenSetupPullRequest(input);
    if (existing) {
      return existing;
    }

    try {
      const { data } = await this.octokit.request(
        "POST /repos/{owner}/{repo}/pulls",
        {
          owner: input.owner,
          repo: input.repo,
          title: "chore: add ReviewRouter workflow",
          head: input.setupBranch,
          base: input.baseBranch,
          body: [
            "This PR installs the ReviewRouter GitHub Actions workflows.",
            "",
            "Security defaults:",
            "- uses pull_request, not pull_request_target",
            "- checks out code with persist-credentials: false",
            "- skips secret-backed review for fork pull requests by default",
            "- uses GitHub OIDC for SaaS runtime config",
            "",
            "Workflow files:",
            "- `.github/workflows/reviewrouter.yml` - pull request review gate",
            "- `.github/workflows/reviewrouter-interaction.yml` - `/rr` comment commands",
          ].join("\n"),
        },
      );
      return parsePullRequest(data);
    } catch (error: unknown) {
      if (!isGitHubWriteConflict(error)) {
        throw error;
      }
      const racedPullRequest = await this.findOpenSetupPullRequest(input);
      if (racedPullRequest) {
        return racedPullRequest;
      }
      throw error;
    }
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
}

type GitHubPullRequest = {
  readonly html_url: string;
  readonly number: number;
};

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
  };
  if (
    typeof pullRequest.html_url !== "string" ||
    typeof pullRequest.number !== "number"
  ) {
    throw new Error("github_pull_request_response_invalid");
  }
  return {
    html_url: pullRequest.html_url,
    number: pullRequest.number,
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
