import { App } from "@octokit/app";
import { request as githubRequest } from "@octokit/request";
import { createHash } from "node:crypto";
import {
  readCodexRotatingWorkflowSourceMetadata,
  scanCodexRotatingAdvisoryWorkflow,
} from "@reviewrouter/features-codex-oauth-rotating";
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
    readonly actions?: unknown;
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
  readonly actions?: "read";
  readonly secrets?: SecretPermission;
  readonly contents?: "read";
  readonly pull_requests?: "read";
};

type ContentsResponse = {
  readonly data?: unknown;
};

type WorkflowRunResponse = {
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

  async inspectReviewV2ManagedWorkflowInventory(input: {
    readonly githubInstallationId: string;
    readonly githubRepositoryId: string;
    readonly repositoryFullName: string;
    readonly owner: string;
  }): Promise<{
    readonly compatible: boolean;
    readonly inventoryHash: string;
    readonly actionCommitSha: string | null;
  }> {
    const token = await this.mintRepositoryToken({
      githubInstallationId: input.githubInstallationId,
      githubRepositoryId: input.githubRepositoryId,
      permissions: { contents: "read" },
    });
    const repo = repoNameFromFullName(input.repositoryFullName);
    const reviewPath = ".github/workflows/reviewrouter-codex.yml";
    const reviewWorkflow = await this.readDefaultBranchWorkflow({
      token: token.token,
      owner: input.owner,
      repo,
      path: reviewPath,
    });
    const legacyPaths = [".github/workflows/reviewrouter.yml"];
    const legacyPresence = await Promise.all(
      legacyPaths.map(async (path) => ({
        path,
        present:
          (await this.readDefaultBranchWorkflow({
            token: token.token,
            owner: input.owner,
            repo,
            path,
            missingAllowed: true,
          })) !== null,
      })),
    );
    const interactionPath = ".github/workflows/reviewrouter-interaction.yml";
    const interactionWorkflow = await this.readDefaultBranchWorkflow({
      token: token.token,
      owner: input.owner,
      repo,
      path: interactionPath,
      missingAllowed: true,
    });
    const scan = reviewWorkflow
      ? scanCodexRotatingAdvisoryWorkflow(reviewWorkflow)
      : { valid: false, errors: ["review_workflow_missing"] };
    const metadata =
      scan.valid && reviewWorkflow
        ? readCodexRotatingWorkflowSourceMetadata(reviewWorkflow)
        : null;
    const immutableT0 = Boolean(
      metadata &&
      /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[a-f0-9]{40}$/.test(
        metadata.actionRef,
      ) &&
      reviewWorkflow?.includes("review_action_v2_mode: t0"),
    );
    const reviewActionCommitSha =
      metadata?.actionRef.match(/@([a-f0-9]{40})$/)?.[1] ?? null;
    const interaction = inspectReviewV2InteractionWorkflow(
      interactionWorkflow,
      reviewActionCommitSha,
    );
    const inventory = {
      reviewPath,
      reviewWorkflowSha256: reviewWorkflow
        ? createHash("sha256").update(reviewWorkflow, "utf8").digest("hex")
        : null,
      actionRef: metadata?.actionRef ?? null,
      providerInstanceId: metadata?.providerInstanceId ?? null,
      workflowSchemaVersion: metadata?.workflowSchemaVersion ?? null,
      scanErrors: [...scan.errors].sort(),
      legacyPresence,
      interaction,
    };
    return {
      compatible:
        scan.valid &&
        immutableT0 &&
        legacyPresence.every((entry) => !entry.present) &&
        interaction.compatible,
      inventoryHash: createHash("sha256")
        .update(JSON.stringify(inventory), "utf8")
        .digest("hex"),
      actionCommitSha: reviewActionCommitSha,
    };
  }

  async resolveWorkflowRunPullRequest(input: {
    readonly repository: {
      readonly githubInstallationId: string;
      readonly githubRepositoryId: string;
      readonly fullName: string;
      readonly owner: string;
    };
    readonly githubRunId: string;
    readonly githubRunAttempt: string;
    readonly eventName: "pull_request_target";
  }): Promise<number> {
    const token = await this.mintRepositoryToken({
      githubInstallationId: input.repository.githubInstallationId,
      githubRepositoryId: input.repository.githubRepositoryId,
      permissions: { actions: "read" },
    });
    const response = (await githubRequest(
      "GET /repos/{owner}/{repo}/actions/runs/{run_id}",
      {
        owner: input.repository.owner,
        repo: repoNameFromFullName(input.repository.fullName),
        run_id: parsePositiveSafeInteger(
          input.githubRunId,
          "codex_rotating_workflow_run_id_invalid",
        ),
        headers: { authorization: `Bearer ${token.token}` },
      },
    )) as WorkflowRunResponse;
    return decodeWorkflowRunPullRequest(response.data, {
      eventName: input.eventName,
      githubRepositoryId: input.repository.githubRepositoryId,
      githubRunAttempt: input.githubRunAttempt,
    });
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
      input.permissions.actions &&
      data.permissions?.actions !== input.permissions.actions
    ) {
      throw new Error("codex_rotating_installation_token_permissions_mismatch");
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

  private async readDefaultBranchWorkflow(input: {
    readonly token: string;
    readonly owner: string;
    readonly repo: string;
    readonly path: string;
    readonly missingAllowed?: boolean;
  }): Promise<string | null> {
    try {
      const response = (await githubRequest(
        "GET /repos/{owner}/{repo}/contents/{path}",
        {
          owner: input.owner,
          repo: input.repo,
          path: input.path,
          headers: { authorization: `Bearer ${input.token}` },
        },
      )) as ContentsResponse;
      return decodeWorkflowContent(response.data);
    } catch (error) {
      if (
        input.missingAllowed === true &&
        typeof error === "object" &&
        error !== null &&
        "status" in error &&
        error.status === 404
      ) {
        return null;
      }
      throw error;
    }
  }
}

function inspectReviewV2InteractionWorkflow(
  workflow: string | null,
  expectedActionCommitSha: string | null,
) {
  if (workflow === null) {
    return {
      path: ".github/workflows/reviewrouter-interaction.yml",
      present: false,
      compatible: true,
      actionCommitSha: null,
      errors: [] as string[],
    };
  }

  const errors: string[] = [];
  const runtimeRefs = [
    ...workflow.matchAll(
      /^\s*(RR_RUNTIME_REF|REVIEWROUTER_ACTION_VERSION):\s*["']?([a-f0-9]{40})["']?\s*$/gim,
    ),
  ];
  const runtimeCommitShas = [
    ...new Set(runtimeRefs.map((match) => match[2]!.toLowerCase())),
  ];
  const runtimeEnvNames = new Set(runtimeRefs.map((match) => match[1]!));
  const checkoutRefs = [
    ...workflow.matchAll(
      /^\s*ref:\s*\$\{\{\s*env\.(RR_RUNTIME_REF|REVIEWROUTER_ACTION_VERSION)\s*\}\}\s*$/gm,
    ),
  ];
  const actionCommitSha =
    runtimeCommitShas.length === 1 ? runtimeCommitShas[0]! : null;
  if (actionCommitSha === null) {
    errors.push("interaction_runtime_ref_invalid");
  } else if (actionCommitSha !== expectedActionCommitSha) {
    errors.push("interaction_runtime_ref_mismatch");
  }
  if (
    checkoutRefs.length !== 1 ||
    !runtimeEnvNames.has(checkoutRefs[0]![1]!) ||
    !/^\s*repository:\s*["']?777genius\/review-router["']?\s*$/m.test(workflow)
  ) {
    errors.push("interaction_runtime_checkout_invalid");
  }
  if (
    !/^\s*REVIEWROUTER_RUNTIME_CONFIG_MODE:\s*["']oidc["']\s*$/m.test(workflow)
  ) {
    errors.push("interaction_runtime_config_not_oidc");
  }
  if (
    !/^\s*REVIEW_ROUTER_REVIEW_WORKFLOW_FILE:\s*["']reviewrouter-codex\.yml["']\s*$/m.test(
      workflow,
    )
  ) {
    errors.push("interaction_review_workflow_binding_invalid");
  }
  if (!/^\s*id-token:\s*write\s*$/m.test(workflow)) {
    errors.push("interaction_oidc_permission_missing");
  }
  return {
    path: ".github/workflows/reviewrouter-interaction.yml",
    present: true,
    compatible: errors.length === 0,
    actionCommitSha,
    errors: errors.sort(),
  };
}

function decodeWorkflowRunPullRequest(
  data: unknown,
  expected: {
    readonly eventName: "pull_request_target";
    readonly githubRepositoryId: string;
    readonly githubRunAttempt: string;
  },
): number {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("codex_rotating_workflow_run_invalid_response");
  }
  const run = data as {
    readonly event?: unknown;
    readonly run_attempt?: unknown;
    readonly repository?: { readonly id?: unknown };
    readonly pull_requests?: readonly { readonly number?: unknown }[];
  };
  const expectedAttempt = parsePositiveSafeInteger(
    expected.githubRunAttempt,
    "codex_rotating_workflow_run_attempt_invalid",
  );
  if (
    run.event !== expected.eventName ||
    run.run_attempt !== expectedAttempt ||
    String(run.repository?.id ?? "") !== expected.githubRepositoryId ||
    !Array.isArray(run.pull_requests) ||
    run.pull_requests.length !== 1
  ) {
    throw new Error("codex_rotating_workflow_run_identity_mismatch");
  }
  const pullRequestNumber = run.pull_requests[0]?.number;
  if (
    !Number.isSafeInteger(pullRequestNumber) ||
    (pullRequestNumber as number) <= 0
  ) {
    throw new Error("codex_rotating_workflow_run_pull_request_invalid");
  }
  return pullRequestNumber as number;
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
