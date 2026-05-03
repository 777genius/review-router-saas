import { Buffer } from "node:buffer";
import type {
  WorkflowSetupGatewayInput,
  WorkflowSetupGatewayPort,
  WorkflowSetupPullRequest,
} from "../../application/ports/workflow-setup-gateway-port";

type GitHubRequester = {
  request: (
    route: string,
    parameters?: Record<string, unknown>,
  ) => Promise<{ data: any }>;
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
    const sha = Array.isArray(ref.object) ? ref.object[0]?.sha : ref.object.sha;

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

    let existingSha: string | undefined;
    let existingContent: string | null = null;
    try {
      const { data: existing } = await this.octokit.request(
        "GET /repos/{owner}/{repo}/contents/{path}",
        {
          owner: input.owner,
          repo: input.repo,
          path: input.workflowPath,
          ref: input.setupBranch,
        },
      );
      if (!Array.isArray(existing) && existing.type === "file") {
        existingSha = existing.sha;
        existingContent = decodeBase64Content(existing.content);
      }
    } catch (error: unknown) {
      if (getErrorStatus(error) !== 404) throw error;
    }

    if (existingContent !== input.workflowYaml) {
      await this.octokit.request("PUT /repos/{owner}/{repo}/contents/{path}", {
        owner: input.owner,
        repo: input.repo,
        path: input.workflowPath,
        branch: input.setupBranch,
        sha: existingSha,
        message: "chore: add ReviewRouter workflow",
        content: Buffer.from(input.workflowYaml).toString("base64"),
      });
    }

    const existingPrs = await this.octokit.request(
      "GET /repos/{owner}/{repo}/pulls",
      {
        owner: input.owner,
        repo: input.repo,
        head: `${input.owner}:${input.setupBranch}`,
        state: "open",
      },
    );

    const pullRequest =
      existingPrs.data[0] ??
      (
        await this.octokit.request("POST /repos/{owner}/{repo}/pulls", {
          owner: input.owner,
          repo: input.repo,
          title: "chore: add ReviewRouter workflow",
          head: input.setupBranch,
          base: input.baseBranch,
          body: [
            "This PR installs the ReviewRouter GitHub Actions workflow.",
            "",
            "Security defaults:",
            "- uses pull_request, not pull_request_target",
            "- checks out code with persist-credentials: false",
            "- skips secret-backed review for fork pull requests by default",
            "- uses GitHub OIDC for SaaS runtime config",
          ].join("\n"),
        })
      ).data;

    return {
      url: pullRequest.html_url,
      number: pullRequest.number,
      branch: input.setupBranch,
    };
  }
}

function decodeBase64Content(content: unknown): string | null {
  if (typeof content !== "string") {
    return null;
  }
  return Buffer.from(content.replaceAll("\n", ""), "base64").toString("utf8");
}
