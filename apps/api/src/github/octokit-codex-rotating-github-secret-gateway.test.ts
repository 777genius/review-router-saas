import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderCodexRotatingAdvisoryWorkflow } from "@reviewrouter/features-codex-oauth-rotating";
import { OctokitCodexRotatingGitHubSecretGateway } from "./octokit-codex-rotating-github-secret-gateway.js";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  request: vi.fn(),
}));

vi.mock("@octokit/app", () => ({
  App: vi.fn().mockImplementation(function App() {
    return {
      octokit: {
        auth: mocks.auth,
      },
    };
  }),
}));

vi.mock("@octokit/request", () => ({
  request: mocks.request,
}));

describe("OctokitCodexRotatingGitHubSecretGateway", () => {
  beforeEach(() => {
    mocks.auth.mockReset();
    mocks.request.mockReset();
  });

  it("mints a repository-scoped Secrets: read token for runner public-key fetch", async () => {
    mocks.auth.mockResolvedValueOnce({
      token: "ghs_secret_read_token",
      expiresAt: "2026-05-25T12:15:00.000Z",
      permissions: { secrets: "read" },
    });

    const gateway = new OctokitCodexRotatingGitHubSecretGateway({
      appId: "123",
      privateKey: "private-key",
    });

    const result = await gateway.issueSecretsReadToken({
      githubInstallationId: "129500385",
      githubRepositoryId: "123456",
      repositoryFullName: "777genius/example",
    });

    expect(mocks.auth).toHaveBeenCalledWith({
      type: "installation",
      installationId: 129500385,
      repositoryIds: [123456],
      permissions: { secrets: "read" },
    });
    expect(result.permissions).toEqual({ secrets: "read" });
  });

  it("writes only encrypted GitHub secret payloads with a repository-scoped Secrets: write token", async () => {
    mocks.auth.mockResolvedValueOnce({
      token: "ghs_secret_write_token",
      expiresAt: "2026-05-25T12:15:00.000Z",
      permissions: { secrets: "write" },
    });
    mocks.request.mockResolvedValueOnce({ status: 204 });

    const gateway = new OctokitCodexRotatingGitHubSecretGateway({
      appId: "123",
      privateKey: "private-key",
    });

    await expect(
      gateway.putEncryptedRepositorySecret({
        githubInstallationId: "129500385",
        githubRepositoryId: "123456",
        repositoryFullName: "777genius/example",
        owner: "777genius",
        repo: "example",
        secretName: "REVIEWROUTER_CODEX_AUTH_JSON",
        encryptedValue: "YWJj",
        keyId: "github-key-id",
      }),
    ).resolves.toEqual({ status: "accepted", statusCode: 204 });

    expect(mocks.request).toHaveBeenLastCalledWith(
      "PUT /repos/{owner}/{repo}/actions/secrets/{secret_name}",
      {
        owner: "777genius",
        repo: "example",
        secret_name: "REVIEWROUTER_CODEX_AUTH_JSON",
        encrypted_value: "YWJj",
        key_id: "github-key-id",
        headers: {
          authorization: "Bearer ghs_secret_write_token",
        },
      },
    );
  });

  it("mints a repository-scoped read token for safe checkout and PR loading", async () => {
    mocks.auth.mockResolvedValueOnce({
      token: "ghs_contents_read_token",
      expiresAt: "2026-05-25T12:15:00.000Z",
      permissions: { contents: "read", pull_requests: "read" },
    });

    const gateway = new OctokitCodexRotatingGitHubSecretGateway({
      appId: "123",
      privateKey: "private-key",
    });

    await expect(
      gateway.issueContentsReadToken({
        githubInstallationId: "129500385",
        githubRepositoryId: "123456",
        repositoryFullName: "777genius/example",
      }),
    ).resolves.toEqual({
      token: "ghs_contents_read_token",
      expiresAt: new Date("2026-05-25T12:15:00.000Z"),
      permissions: { contents: "read", pullRequests: "read" },
    });

    expect(mocks.auth).toHaveBeenCalledWith({
      type: "installation",
      installationId: 129500385,
      repositoryIds: [123456],
      permissions: { contents: "read", pull_requests: "read" },
    });
  });

  it("rejects unexpected GitHub secret write statuses", async () => {
    mocks.auth.mockResolvedValueOnce({
      token: "ghs_secret_write_token",
      expiresAt: "2026-05-25T12:15:00.000Z",
      permissions: { secrets: "write" },
    });
    mocks.request.mockResolvedValueOnce({ status: 200 });

    const gateway = new OctokitCodexRotatingGitHubSecretGateway({
      appId: "123",
      privateKey: "private-key",
    });

    await expect(
      gateway.putEncryptedRepositorySecret({
        githubInstallationId: "129500385",
        githubRepositoryId: "123456",
        repositoryFullName: "777genius/example",
        owner: "777genius",
        repo: "example",
        secretName: "REVIEWROUTER_CODEX_AUTH_JSON",
        encryptedValue: "YWJj",
        keyId: "github-key-id",
      }),
    ).rejects.toThrow("codex_rotating_secret_put_unexpected_status");
  });

  it("verifies the exact workflow source at workflow_sha before prelease", async () => {
    const workflow = renderCodexRotatingAdvisoryWorkflow({
      actionRef:
        "777genius/review-router@0123456789abcdef0123456789abcdef01234567",
      apiUrl: "https://reviewrouter.site",
      providerInstanceId: "codex-rotating:123456",
    });
    mocks.auth.mockResolvedValueOnce({
      token: "ghs_contents_read_token",
      expiresAt: "2026-05-25T12:15:00.000Z",
      permissions: { contents: "read" },
    });
    mocks.request.mockResolvedValueOnce({
      data: {
        type: "file",
        encoding: "base64",
        content: Buffer.from(workflow, "utf8").toString("base64"),
      },
    });

    const gateway = new OctokitCodexRotatingGitHubSecretGateway({
      appId: "123",
      privateKey: "private-key",
    });

    await expect(
      gateway.verifyWorkflowSource({
        repository: {
          githubInstallationId: "129500385",
          githubRepositoryId: "123456",
          fullName: "777genius/example",
          owner: "777genius",
        },
        workflowSha: "abcdefabcdefabcdefabcdefabcdefabcdefabcd",
        workflowPath: ".github/workflows/reviewrouter-codex.yml",
        expectedActionOwnerRepo: "777genius/review-router",
        expectedProviderInstanceId: "codex-rotating:123456",
        expectedWorkflowSchemaVersion: 1,
      }),
    ).resolves.toMatchObject({
      binding: {
        providerInstanceId: "codex-rotating:123456",
        actionRef:
          "777genius/review-router@0123456789abcdef0123456789abcdef01234567",
      },
    });

    expect(mocks.request).toHaveBeenCalledWith(
      "GET /repos/{owner}/{repo}/contents/{path}",
      {
        owner: "777genius",
        repo: "example",
        path: ".github/workflows/reviewrouter-codex.yml",
        ref: "abcdefabcdefabcdefabcdefabcdefabcdefabcd",
        headers: {
          authorization: "Bearer ghs_contents_read_token",
        },
      },
    );
  });

  it("resolves a pull_request_target scope from the signed workflow run", async () => {
    mocks.auth.mockResolvedValueOnce({
      token: "ghs_actions_read_token",
      expiresAt: "2026-05-25T12:15:00.000Z",
      permissions: { actions: "read" },
    });
    mocks.request.mockResolvedValueOnce({
      data: {
        event: "pull_request_target",
        run_attempt: 2,
        repository: { id: 123456 },
        pull_requests: [{ number: 240 }],
      },
    });
    const gateway = new OctokitCodexRotatingGitHubSecretGateway({
      appId: "123",
      privateKey: "private-key",
    });

    await expect(
      gateway.resolveWorkflowRunPullRequest({
        repository: {
          githubInstallationId: "129500385",
          githubRepositoryId: "123456",
          fullName: "777genius/example",
          owner: "777genius",
        },
        githubRunId: "9001",
        githubRunAttempt: "2",
        eventName: "pull_request_target",
      }),
    ).resolves.toBe(240);

    expect(mocks.auth).toHaveBeenCalledWith({
      type: "installation",
      installationId: 129500385,
      repositoryIds: [123456],
      permissions: { actions: "read" },
    });
    expect(mocks.request).toHaveBeenCalledWith(
      "GET /repos/{owner}/{repo}/actions/runs/{run_id}",
      {
        owner: "777genius",
        repo: "example",
        run_id: 9001,
        headers: { authorization: "Bearer ghs_actions_read_token" },
      },
    );
  });

  it("rejects rotating workflow source from an unexpected action repository", async () => {
    const workflow = renderCodexRotatingAdvisoryWorkflow({
      actionRef: "evil/review-router@0123456789abcdef0123456789abcdef01234567",
      apiUrl: "https://reviewrouter.site",
      providerInstanceId: "codex-rotating:123456",
    });
    mocks.auth.mockResolvedValueOnce({
      token: "ghs_contents_read_token",
      expiresAt: "2026-05-25T12:15:00.000Z",
      permissions: { contents: "read" },
    });
    mocks.request.mockResolvedValueOnce({
      data: {
        type: "file",
        encoding: "base64",
        content: Buffer.from(workflow, "utf8").toString("base64"),
      },
    });

    const gateway = new OctokitCodexRotatingGitHubSecretGateway({
      appId: "123",
      privateKey: "private-key",
    });

    await expect(
      gateway.verifyWorkflowSource({
        repository: {
          githubInstallationId: "129500385",
          githubRepositoryId: "123456",
          fullName: "777genius/example",
          owner: "777genius",
        },
        workflowSha: "abcdefabcdefabcdefabcdefabcdefabcdefabcd",
        workflowPath: ".github/workflows/reviewrouter-codex.yml",
        expectedActionOwnerRepo: "777genius/review-router",
        expectedProviderInstanceId: "codex-rotating:123456",
        expectedWorkflowSchemaVersion: 1,
      }),
    ).rejects.toThrow("codex_rotating_workflow_action_ref_not_allowed");
  });

  it("accepts rotating workflow source with any ref from the expected action repository", async () => {
    const workflow = renderCodexRotatingAdvisoryWorkflow({
      actionRef:
        "777genius/review-router@2222222222222222222222222222222222222222",
      apiUrl: "https://reviewrouter.site",
      providerInstanceId: "codex-rotating:123456",
    });
    mocks.auth.mockResolvedValueOnce({
      token: "ghs_contents_read_token",
      expiresAt: "2026-05-25T12:15:00.000Z",
      permissions: { contents: "read" },
    });
    mocks.request.mockResolvedValueOnce({
      data: {
        type: "file",
        encoding: "base64",
        content: Buffer.from(workflow, "utf8").toString("base64"),
      },
    });

    const gateway = new OctokitCodexRotatingGitHubSecretGateway({
      appId: "123",
      privateKey: "private-key",
    });

    await expect(
      gateway.verifyWorkflowSource({
        repository: {
          githubInstallationId: "129500385",
          githubRepositoryId: "123456",
          fullName: "777genius/example",
          owner: "777genius",
        },
        workflowSha: "abcdefabcdefabcdefabcdefabcdefabcdefabcd",
        workflowPath: ".github/workflows/reviewrouter-codex.yml",
        expectedActionOwnerRepo: "777genius/review-router",
        expectedProviderInstanceId: "codex-rotating:123456",
        expectedWorkflowSchemaVersion: 1,
      }),
    ).resolves.toMatchObject({
      binding: {
        providerInstanceId: "codex-rotating:123456",
        actionRef:
          "777genius/review-router@2222222222222222222222222222222222222222",
      },
    });
  });

  it("rejects non-numeric GitHub repository ids before token minting", async () => {
    const gateway = new OctokitCodexRotatingGitHubSecretGateway({
      appId: "123",
      privateKey: "private-key",
    });

    await expect(
      gateway.issueSecretsReadToken({
        githubInstallationId: "129500385",
        githubRepositoryId: "R_kgDOExample",
        repositoryFullName: "777genius/example",
      }),
    ).rejects.toThrow("codex_rotating_secret_repository_id_invalid");
    expect(mocks.auth).not.toHaveBeenCalled();
  });
});
