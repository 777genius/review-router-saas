import { App } from "@octokit/app";
import type { HostedWorkflowSourceReaderPort } from "../prisma-hosted-codex-grant-admission.js";

export class OctokitHostedWorkflowSourceReader implements HostedWorkflowSourceReaderPort {
  private readonly app: App;

  constructor(
    input: { readonly appId: string; readonly privateKey: string },
    app?: App,
  ) {
    this.app =
      app ?? new App({ appId: input.appId, privateKey: input.privateKey });
  }

  async readWorkflowAtRevision(
    input: Parameters<
      HostedWorkflowSourceReaderPort["readWorkflowAtRevision"]
    >[0],
  ) {
    if (!/^[a-f0-9]{40}$/u.test(input.revisionSha)) {
      throw new Error("hosted_workflow_revision_invalid");
    }
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
        ref: input.revisionSha,
      },
    );
    const commitSha = commit.data.sha;
    if (commitSha !== input.revisionSha) {
      throw new Error("hosted_workflow_revision_mismatch");
    }
    const source = await octokit.request(
      "GET /repos/{owner}/{repo}/contents/{path}",
      {
        owner: input.owner,
        repo: input.repository,
        path: input.workflowPath,
        ref: input.revisionSha,
      },
    );
    if (
      Array.isArray(source.data) ||
      source.data.type !== "file" ||
      typeof source.data.content !== "string" ||
      source.data.encoding !== "base64" ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(source.data.sha)
    ) {
      throw new Error("hosted_workflow_source_invalid");
    }
    return {
      commitSha,
      blobSha: source.data.sha,
      contents: Buffer.from(source.data.content, "base64").toString("utf8"),
    };
  }
}

function parsePositiveSafeInteger(value: string, code: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(code);
  return number;
}
