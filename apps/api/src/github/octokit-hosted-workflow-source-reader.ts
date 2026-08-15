import { App } from "@octokit/app";
import type { HostedWorkflowSourceReaderPort } from "../prisma-hosted-codex-grant-admission.js";

export class OctokitHostedWorkflowSourceReader implements HostedWorkflowSourceReaderPort {
  private readonly app: App;

  constructor(input: { readonly appId: string; readonly privateKey: string }) {
    this.app = new App({ appId: input.appId, privateKey: input.privateKey });
  }

  async readCurrentDefaultBranchWorkflow(
    input: Parameters<
      HostedWorkflowSourceReaderPort["readCurrentDefaultBranchWorkflow"]
    >[0],
  ) {
    const installationId = parsePositiveSafeInteger(
      input.githubInstallationId,
      "hosted_workflow_installation_id_invalid",
    );
    const octokit = await this.app.getInstallationOctokit(installationId);
    const commit = await octokit.request(
      "GET /repos/{owner}/{repo}/commits/{ref}",
      {
        owner: input.owner,
        repo: input.repository,
        ref: input.defaultBranch,
      },
    );
    const commitSha = commit.data.sha;
    if (!/^[a-f0-9]{40}$/iu.test(commitSha)) {
      throw new Error("hosted_workflow_commit_invalid");
    }
    const source = await octokit.request(
      "GET /repos/{owner}/{repo}/contents/{path}",
      {
        owner: input.owner,
        repo: input.repository,
        path: input.workflowPath,
        ref: commitSha,
      },
    );
    if (
      Array.isArray(source.data) ||
      source.data.type !== "file" ||
      typeof source.data.content !== "string" ||
      source.data.encoding !== "base64" ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/iu.test(source.data.sha)
    ) {
      throw new Error("hosted_workflow_source_invalid");
    }
    return {
      commitSha: commitSha.toLowerCase(),
      blobSha: source.data.sha.toLowerCase(),
      contents: Buffer.from(source.data.content, "base64").toString("utf8"),
    };
  }
}

function parsePositiveSafeInteger(value: string, code: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(code);
  return number;
}
