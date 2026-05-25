import { App } from "@octokit/app";
import { request as githubRequest } from "@octokit/request";
import { createHash } from "node:crypto";
import { readCodexRotatingWorkflowSourceMetadata } from "@reviewrouter/features-codex-oauth-rotating";
import type {
  CodexRotatingGitHubSecretTokenIssuerPort,
  CodexRotatingGitHubSecretWriterPort,
  CodexRotatingGitHubCheckoutTokenIssuerPort,
  CodexRotatingWorkflowSourceVerifierPort,
  CodexRotatingSecretWriteTarget,
} from "@reviewrouter/features-action-control-plane";

type InstallationTokenResponse = {
  readonly type?: unknown;
  readonly tokenType?: unknown;
  readonly token?: unknown;
  readonly expiresAt?: unknown;
  readonly permissions?: {
    readonly contents?: unknown;
    readonly pull_requests?: unknown;
    readonly secrets?: unknown;
  };
};

type SecretPutResponse = {
  readonly status: number;
};

type SecretPermission = "read" | "write";
type InstallationPermission = {
  readonly secrets?: SecretPermission;
  readonly contents?: "read";
  readonly pull_requests?: "read";
};

type ContentsResponse = {
  readonly data?: unknown;
};

export class OctokitCodexRotatingGitHubSecretGateway
  implements
    CodexRotatingGitHubSecretTokenIssuerPort,
    CodexRotatingGitHubSecretWriterPort,
    CodexRotatingGitHubCheckoutTokenIssuerPort,
    CodexRotatingWorkflowSourceVerifierPort
{
  private readonly app: App;

  constructor(options: {
    readonly appId: string;
    readonly privateKey: string;
  }) {
    this.app = new App({
      appId: options.appId,
      privateKey: options.privateKey,
    });
  }

  async issueSecretsReadToken(input: {
    readonly githubInstallationId: string;
    readonly githubRepositoryId: string;
    readonly repositoryFullName: string;
  }): Promise<{
    readonly token: string;
    readonly expiresAt: Date;
    readonly permissions: { readonly secrets: "read" };
  }> {
    const token = await this.mintRepositorySecretsToken({
      githubInstallationId: input.githubInstallationId,
      githubRepositoryId: input.githubRepositoryId,
      permission: "read",
    });
    return {
      token: token.token,
      expiresAt: token.expiresAt,
      permissions: { secrets: "read" },
    };
  }

  async assertCanWriteRepositorySecret(
    input: CodexRotatingSecretWriteTarget,
  ): Promise<{ readonly status: "ready" }> {
    await this.mintRepositorySecretsToken({
      githubInstallationId: input.githubInstallationId,
      githubRepositoryId: input.githubRepositoryId,
      permission: "write",
    });
    return { status: "ready" };
  }

  async issueContentsReadToken(input: {
    readonly githubInstallationId: string;
    readonly githubRepositoryId: string;
    readonly repositoryFullName: string;
  }): Promise<{
    readonly token: string;
    readonly expiresAt: Date;
    readonly permissions: {
      readonly contents: "read";
      readonly pullRequests: "read";
    };
  }> {
    const token = await this.mintRepositoryToken({
      githubInstallationId: input.githubInstallationId,
      githubRepositoryId: input.githubRepositoryId,
      permissions: { contents: "read", pull_requests: "read" },
    });
    return {
      token: token.token,
      expiresAt: token.expiresAt,
      permissions: { contents: "read", pullRequests: "read" },
    };
  }

  async putEncryptedRepositorySecret(
    input: CodexRotatingSecretWriteTarget & {
      readonly encryptedValue: string;
      readonly keyId: string;
    },
  ): Promise<{
    readonly status: "accepted";
    readonly statusCode: 201 | 204;
  }> {
    const token = await this.mintRepositorySecretsToken({
      githubInstallationId: input.githubInstallationId,
      githubRepositoryId: input.githubRepositoryId,
      permission: "write",
    });
    const response = (await githubRequest(
      "PUT /repos/{owner}/{repo}/actions/secrets/{secret_name}",
      {
        owner: input.owner,
        repo: input.repo,
        secret_name: input.secretName,
        encrypted_value: input.encryptedValue,
        key_id: input.keyId,
        headers: {
          authorization: `Bearer ${token.token}`,
        },
      },
    )) as SecretPutResponse;

    if (response.status !== 201 && response.status !== 204) {
      throw new Error("codex_rotating_secret_put_unexpected_status");
    }
    return { status: "accepted", statusCode: response.status };
  }

  async verifyWorkflowSource(input: {
    readonly repository: {
      readonly githubInstallationId: string;
      readonly githubRepositoryId: string;
      readonly fullName: string;
      readonly owner: string;
    };
    readonly workflowSha: string;
    readonly workflowPath: string;
    readonly expectedActionOwnerRepo: string;
    readonly expectedActionRef: string;
    readonly expectedProviderInstanceId: string;
    readonly expectedWorkflowSchemaVersion: number;
  }) {
    const token = await this.mintRepositoryToken({
      githubInstallationId: input.repository.githubInstallationId,
      githubRepositoryId: input.repository.githubRepositoryId,
      permissions: { contents: "read" },
    });
    const response = (await githubRequest(
      "GET /repos/{owner}/{repo}/contents/{path}",
      {
        owner: input.repository.owner,
        repo: repoNameFromFullName(input.repository.fullName),
        path: input.workflowPath,
        ref: input.workflowSha,
        headers: {
          authorization: `Bearer ${token.token}`,
        },
      },
    )) as ContentsResponse;
    const workflow = decodeWorkflowContent(response.data);
    const metadata = readCodexRotatingWorkflowSourceMetadata(workflow);
    if (
      metadata.actionRef.split("@")[0]!.toLowerCase() !==
      input.expectedActionOwnerRepo.toLowerCase()
    ) {
      throw new Error("codex_rotating_workflow_action_ref_not_allowed");
    }
    if (
      metadata.actionRef.toLowerCase() !== input.expectedActionRef.toLowerCase()
    ) {
      throw new Error("codex_rotating_workflow_action_ref_mismatch");
    }
    if (metadata.providerInstanceId !== input.expectedProviderInstanceId) {
      throw new Error("codex_rotating_workflow_provider_instance_mismatch");
    }
    if (
      metadata.workflowSchemaVersion !== input.expectedWorkflowSchemaVersion
    ) {
      throw new Error("codex_rotating_workflow_schema_mismatch");
    }

    return {
      binding: {
        providerInstanceId: metadata.providerInstanceId,
        repositoryFullName: input.repository.fullName,
        githubRepositoryId: input.repository.githubRepositoryId,
        actionRef: metadata.actionRef,
        workflowPath: input.workflowPath,
        workflowSchemaVersion: metadata.workflowSchemaVersion,
      },
      workflowSourceSha256: createHash("sha256")
        .update(workflow, "utf8")
        .digest("hex"),
    };
  }

  private async mintRepositorySecretsToken(input: {
    readonly githubInstallationId: string;
    readonly githubRepositoryId: string;
    readonly permission: SecretPermission;
  }): Promise<{
    readonly token: string;
    readonly expiresAt: Date;
  }> {
    const data = (await this.app.octokit.auth({
      type: "installation",
      installationId: parsePositiveSafeInteger(
        input.githubInstallationId,
        "codex_rotating_secret_installation_id_invalid",
      ),
      repositoryIds: [
        parsePositiveSafeInteger(
          input.githubRepositoryId,
          "codex_rotating_secret_repository_id_invalid",
        ),
      ],
      permissions: {
        secrets: input.permission,
      },
    })) as InstallationTokenResponse;
    if (typeof data.token !== "string" || data.token.length === 0) {
      throw new Error("codex_rotating_secret_token_invalid_response");
    }
    if (typeof data.expiresAt !== "string") {
      throw new Error("codex_rotating_secret_token_invalid_response");
    }
    const expiresAt = new Date(data.expiresAt);
    if (!Number.isFinite(expiresAt.getTime())) {
      throw new Error("codex_rotating_secret_token_invalid_response");
    }
    if (data.permissions?.secrets !== input.permission) {
      throw new Error("codex_rotating_secret_token_permissions_mismatch");
    }

    return { token: data.token, expiresAt };
  }

  private async mintRepositoryToken(input: {
    readonly githubInstallationId: string;
    readonly githubRepositoryId: string;
    readonly permissions: InstallationPermission;
  }): Promise<{
    readonly token: string;
    readonly expiresAt: Date;
  }> {
    const data = (await this.app.octokit.auth({
      type: "installation",
      installationId: parsePositiveSafeInteger(
        input.githubInstallationId,
        "codex_rotating_installation_id_invalid",
      ),
      repositoryIds: [
        parsePositiveSafeInteger(
          input.githubRepositoryId,
          "codex_rotating_repository_id_invalid",
        ),
      ],
      permissions: input.permissions,
    })) as InstallationTokenResponse;
    if (typeof data.token !== "string" || data.token.length === 0) {
      throw new Error("codex_rotating_installation_token_invalid_response");
    }
    if (typeof data.expiresAt !== "string") {
      throw new Error("codex_rotating_installation_token_invalid_response");
    }
    const expiresAt = new Date(data.expiresAt);
    if (!Number.isFinite(expiresAt.getTime())) {
      throw new Error("codex_rotating_installation_token_invalid_response");
    }
    if (
      input.permissions.contents &&
      data.permissions?.contents !== input.permissions.contents
    ) {
      throw new Error("codex_rotating_installation_token_permissions_mismatch");
    }
    if (
      input.permissions.pull_requests &&
      data.permissions?.pull_requests !== input.permissions.pull_requests
    ) {
      throw new Error("codex_rotating_installation_token_permissions_mismatch");
    }
    return { token: data.token, expiresAt };
  }
}

function parsePositiveSafeInteger(value: string, errorCode: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(errorCode);
  }
  return parsed;
}

function repoNameFromFullName(fullName: string): string {
  const [, repo] = fullName.split("/");
  if (!repo) {
    throw new Error("codex_rotating_invalid_repository_full_name");
  }
  return repo;
}

function decodeWorkflowContent(data: unknown): string {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("codex_rotating_workflow_content_invalid_response");
  }
  const record = data as {
    readonly type?: unknown;
    readonly encoding?: unknown;
    readonly content?: unknown;
  };
  if (record.type !== "file" || record.encoding !== "base64") {
    throw new Error("codex_rotating_workflow_content_invalid_response");
  }
  if (typeof record.content !== "string") {
    throw new Error("codex_rotating_workflow_content_invalid_response");
  }
  const compacted = record.content.replace(/\s+/g, "");
  if (compacted.length === 0 || compacted.length > 128 * 1024) {
    throw new Error("codex_rotating_workflow_content_too_large");
  }
  return Buffer.from(compacted, "base64").toString("utf8");
}
