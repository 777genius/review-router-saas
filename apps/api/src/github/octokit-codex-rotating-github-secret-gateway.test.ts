import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CodexRotatingReviewActionV2Mode,
  renderCodexRotatingAdvisoryWorkflow,
} from "@reviewrouter/features-codex-oauth-rotating";
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

  it("verifies a truly old schema-1 workflow source at workflow_sha before prelease", async () => {
    const workflow = renderCodexRotatingAdvisoryWorkflow({
      actionRef:
        "777genius/review-router@0123456789abcdef0123456789abcdef01234567",
      apiUrl: "https://reviewrouter.site",
      providerInstanceId: "codex-rotating:123456",
    })
      .replaceAll(", converted_to_draft", "")
      .replace(
        "          max-changed-lines: ${{ vars.REVIEW_ROUTER_MAX_CHANGED_LINES }}\n",
        "",
      )
      .replace(
        "          review-timeout-minutes: ${{ vars.REVIEW_ROUTER_TIMEOUT_MINUTES || '60' }}\n",
        "",
      )
      .replace(
        "    timeout-minutes: ${{ fromJSON(vars.REVIEW_ROUTER_TIMEOUT_MINUTES || '60') }}",
        "    timeout-minutes: 60",
      );
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

  it("accepts only an immutable T0 workflow inventory without legacy writers", async () => {
    const actionSha = "a".repeat(40);
    const workflow = renderCodexRotatingAdvisoryWorkflow({
      actionRef: `777genius/review-router@${actionSha}`,
      apiUrl: "https://api.reviewrouter.site",
      providerInstanceId: "codex-rotating:123456",
      refreshScheduleCron: null,
      reviewActionV2Mode: CodexRotatingReviewActionV2Mode.T0,
    });
    mockManagedWorkflowInventory({ reviewWorkflow: workflow });
    const gateway = new OctokitCodexRotatingGitHubSecretGateway({
      appId: "123",
      privateKey: "private-key",
    });

    await expect(
      gateway.inspectReviewV2ManagedWorkflowInventory({
        githubInstallationId: "129500385",
        githubRepositoryId: "123456",
        repositoryFullName: "777genius/example",
        owner: "777genius",
      }),
    ).resolves.toMatchObject({
      compatible: true,
      inventoryHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      actionCommitSha: expect.stringMatching(/^[a-f0-9]{40}$/),
    });
  });

  it("rejects a default workflow bound to a different Action repository", async () => {
    const actionSha = "a".repeat(40);
    const workflow = renderCodexRotatingAdvisoryWorkflow({
      actionRef: `attacker/review-router@${actionSha}`,
      apiUrl: "https://api.reviewrouter.site",
      providerInstanceId: "codex-rotating:123456",
      refreshScheduleCron: null,
      reviewActionV2Mode: CodexRotatingReviewActionV2Mode.T0,
    });
    mockManagedWorkflowInventory({ reviewWorkflow: workflow });
    const gateway = new OctokitCodexRotatingGitHubSecretGateway({
      appId: "123",
      privateKey: "private-key",
    });

    await expect(
      gateway.inspectReviewV2ManagedWorkflowInventory({
        githubInstallationId: "129500385",
        githubRepositoryId: "123456",
        repositoryFullName: "777genius/example",
        owner: "777genius",
      }),
    ).resolves.toMatchObject({
      compatible: false,
      actionCommitSha: actionSha,
    });
  });

  it("rejects an authoritative ref with a different provider binding", async () => {
    const actionSha = "a".repeat(40);
    const defaultWorkflow = renderCodexRotatingAdvisoryWorkflow({
      actionRef: `777genius/review-router@${actionSha}`,
      apiUrl: "https://api.reviewrouter.site",
      providerInstanceId: "codex-rotating:123456",
      refreshScheduleCron: null,
      reviewActionV2Mode: CodexRotatingReviewActionV2Mode.T0,
    });
    const mismatchedWorkflow = renderCodexRotatingAdvisoryWorkflow({
      actionRef: `777genius/review-router@${actionSha}`,
      apiUrl: "https://api.reviewrouter.site",
      providerInstanceId: "codex-rotating:654321",
      refreshScheduleCron: null,
      reviewActionV2Mode: CodexRotatingReviewActionV2Mode.T0,
    });
    mockManagedWorkflowInventory({
      reviewWorkflow: defaultWorkflow,
      activePullRequests: [
        {
          number: 240,
          baseRef: "dev",
          baseHeadSha: "d".repeat(40),
          headSha: "c".repeat(40),
          mergeCommitSha: "e".repeat(40),
          reviewWorkflowAtBase: defaultWorkflow,
          reviewWorkflowAtMerge: mismatchedWorkflow,
        },
      ],
    });
    const gateway = new OctokitCodexRotatingGitHubSecretGateway({
      appId: "123",
      privateKey: "private-key",
    });

    await expect(
      gateway.inspectReviewV2ManagedWorkflowInventory({
        githubInstallationId: "129500385",
        githubRepositoryId: "123456",
        repositoryFullName: "777genius/example",
        owner: "777genius",
      }),
    ).resolves.toMatchObject({ compatible: false });
  });

  it("rejects a stale legacy writer on an active non-default PR base branch", async () => {
    const actionSha = "a".repeat(40);
    const t0Workflow = renderCodexRotatingAdvisoryWorkflow({
      actionRef: `777genius/review-router@${actionSha}`,
      apiUrl: "https://api.reviewrouter.site",
      providerInstanceId: "codex-rotating:123456",
      refreshScheduleCron: null,
      reviewActionV2Mode: CodexRotatingReviewActionV2Mode.T0,
    });
    const legacyWorkflow = renderCodexRotatingAdvisoryWorkflow({
      actionRef: `777genius/review-router@${actionSha}`,
      apiUrl: "https://api.reviewrouter.site",
      providerInstanceId: "codex-rotating:123456",
      refreshScheduleCron: null,
    });
    mockManagedWorkflowInventory({
      reviewWorkflow: t0Workflow,
      activePullRequests: [
        {
          number: 240,
          baseRef: "dev",
          baseHeadSha: "d".repeat(40),
          headSha: "c".repeat(40),
          reviewWorkflowAtBase: legacyWorkflow,
        },
      ],
    });
    const gateway = new OctokitCodexRotatingGitHubSecretGateway({
      appId: "123",
      privateKey: "private-key",
    });

    await expect(
      gateway.inspectReviewV2ManagedWorkflowInventory({
        githubInstallationId: "129500385",
        githubRepositoryId: "123456",
        repositoryFullName: "777genius/example",
        owner: "777genius",
      }),
    ).resolves.toMatchObject({
      compatible: false,
      actionCommitSha: actionSha,
    });
  });

  it("accepts an active PR base branch pinned to the selected T0 runtime", async () => {
    const actionSha = "a".repeat(40);
    const workflow = renderCodexRotatingAdvisoryWorkflow({
      actionRef: `777genius/review-router@${actionSha}`,
      apiUrl: "https://api.reviewrouter.site",
      providerInstanceId: "codex-rotating:123456",
      refreshScheduleCron: null,
      reviewActionV2Mode: CodexRotatingReviewActionV2Mode.T0,
    });
    mockManagedWorkflowInventory({
      reviewWorkflow: workflow,
      activePullRequests: [
        {
          number: 240,
          baseRef: "dev",
          baseHeadSha: "d".repeat(40),
          headSha: "c".repeat(40),
          reviewWorkflowAtBase: workflow,
        },
      ],
    });
    const gateway = new OctokitCodexRotatingGitHubSecretGateway({
      appId: "123",
      privateKey: "private-key",
    });

    await expect(
      gateway.inspectReviewV2ManagedWorkflowInventory({
        githubInstallationId: "129500385",
        githubRepositoryId: "123456",
        repositoryFullName: "777genius/example",
        owner: "777genius",
      }),
    ).resolves.toMatchObject({
      compatible: true,
      actionCommitSha: actionSha,
    });
  });

  it("fails closed when an inventoried PR base branch moves during inspection", async () => {
    const actionSha = "a".repeat(40);
    const workflow = renderCodexRotatingAdvisoryWorkflow({
      actionRef: `777genius/review-router@${actionSha}`,
      apiUrl: "https://api.reviewrouter.site",
      providerInstanceId: "codex-rotating:123456",
      refreshScheduleCron: null,
      reviewActionV2Mode: CodexRotatingReviewActionV2Mode.T0,
    });
    mockManagedWorkflowInventory({
      reviewWorkflow: workflow,
      activePullRequests: [
        {
          number: 240,
          baseRef: "dev",
          baseHeadSha: "d".repeat(40),
          movedBaseHeadSha: "e".repeat(40),
          headSha: "c".repeat(40),
          reviewWorkflowAtBase: workflow,
        },
      ],
    });
    const gateway = new OctokitCodexRotatingGitHubSecretGateway({
      appId: "123",
      privateKey: "private-key",
    });

    await expect(
      gateway.inspectReviewV2ManagedWorkflowInventory({
        githubInstallationId: "129500385",
        githubRepositoryId: "123456",
        repositoryFullName: "777genius/example",
        owner: "777genius",
      }),
    ).rejects.toThrow("codex_rotating_workflow_inventory_coverage_moved");
  });

  it("rejects a legacy workflow in the current merge ref of a mergeable PR", async () => {
    const actionSha = "a".repeat(40);
    const t0Workflow = renderCodexRotatingAdvisoryWorkflow({
      actionRef: `777genius/review-router@${actionSha}`,
      apiUrl: "https://api.reviewrouter.site",
      providerInstanceId: "codex-rotating:123456",
      refreshScheduleCron: null,
      reviewActionV2Mode: CodexRotatingReviewActionV2Mode.T0,
    });
    const legacyWorkflow = renderCodexRotatingAdvisoryWorkflow({
      actionRef: `777genius/review-router@${actionSha}`,
      apiUrl: "https://api.reviewrouter.site",
      providerInstanceId: "codex-rotating:123456",
      refreshScheduleCron: null,
    });
    mockManagedWorkflowInventory({
      reviewWorkflow: t0Workflow,
      activePullRequests: [
        {
          number: 240,
          baseRef: "dev",
          baseHeadSha: "d".repeat(40),
          headSha: "c".repeat(40),
          mergeCommitSha: "e".repeat(40),
          reviewWorkflowAtBase: t0Workflow,
          reviewWorkflowAtMerge: legacyWorkflow,
        },
      ],
    });
    const gateway = new OctokitCodexRotatingGitHubSecretGateway({
      appId: "123",
      privateKey: "private-key",
    });

    await expect(
      gateway.inspectReviewV2ManagedWorkflowInventory({
        githubInstallationId: "129500385",
        githubRepositoryId: "123456",
        repositoryFullName: "777genius/example",
        owner: "777genius",
      }),
    ).resolves.toMatchObject({ compatible: false });
  });

  it("does not treat a test merge built from an old base tip as current authority", async () => {
    const actionSha = "a".repeat(40);
    const t0Workflow = renderCodexRotatingAdvisoryWorkflow({
      actionRef: `777genius/review-router@${actionSha}`,
      apiUrl: "https://api.reviewrouter.site",
      providerInstanceId: "codex-rotating:123456",
      refreshScheduleCron: null,
      reviewActionV2Mode: CodexRotatingReviewActionV2Mode.T0,
    });
    const legacyWorkflow = renderCodexRotatingAdvisoryWorkflow({
      actionRef: `777genius/review-router@${actionSha}`,
      apiUrl: "https://api.reviewrouter.site",
      providerInstanceId: "codex-rotating:123456",
      refreshScheduleCron: null,
    });
    mockManagedWorkflowInventory({
      reviewWorkflow: t0Workflow,
      activePullRequests: [
        {
          number: 292,
          baseRef: "dev",
          baseHeadSha: "f".repeat(40),
          listedBaseSha: "d".repeat(40),
          headSha: "c".repeat(40),
          mergeCommitSha: "e".repeat(40),
          reviewWorkflowAtBase: t0Workflow,
          reviewWorkflowAtMerge: legacyWorkflow,
        },
      ],
    });
    const gateway = new OctokitCodexRotatingGitHubSecretGateway({
      appId: "123",
      privateKey: "private-key",
    });

    await expect(
      gateway.inspectReviewV2ManagedWorkflowInventory({
        githubInstallationId: "129500385",
        githubRepositoryId: "123456",
        repositoryFullName: "777genius/example",
        owner: "777genius",
      }),
    ).resolves.toMatchObject({ compatible: true });
  });

  it("ignores a stale merge ref after GitHub proves the PR is conflicted", async () => {
    const actionSha = "a".repeat(40);
    const workflow = renderCodexRotatingAdvisoryWorkflow({
      actionRef: `777genius/review-router@${actionSha}`,
      apiUrl: "https://api.reviewrouter.site",
      providerInstanceId: "codex-rotating:123456",
      refreshScheduleCron: null,
      reviewActionV2Mode: CodexRotatingReviewActionV2Mode.T0,
    });
    mockManagedWorkflowInventory({
      reviewWorkflow: workflow,
      activePullRequests: [
        {
          number: 252,
          baseRef: "dev",
          baseHeadSha: "d".repeat(40),
          headSha: "c".repeat(40),
          mergeCommitSha: null,
          mergeable: false,
          reviewWorkflowAtBase: workflow,
        },
      ],
    });
    const gateway = new OctokitCodexRotatingGitHubSecretGateway({
      appId: "123",
      privateKey: "private-key",
    });

    await expect(
      gateway.inspectReviewV2ManagedWorkflowInventory({
        githubInstallationId: "129500385",
        githubRepositoryId: "123456",
        repositoryFullName: "777genius/example",
        owner: "777genius",
      }),
    ).resolves.toMatchObject({ compatible: true });
  });

  it("fails closed while GitHub mergeability is still unknown", async () => {
    const actionSha = "a".repeat(40);
    const workflow = renderCodexRotatingAdvisoryWorkflow({
      actionRef: `777genius/review-router@${actionSha}`,
      apiUrl: "https://api.reviewrouter.site",
      providerInstanceId: "codex-rotating:123456",
      refreshScheduleCron: null,
      reviewActionV2Mode: CodexRotatingReviewActionV2Mode.T0,
    });
    mockManagedWorkflowInventory({
      reviewWorkflow: workflow,
      activePullRequests: [
        {
          number: 240,
          baseRef: "dev",
          baseHeadSha: "d".repeat(40),
          headSha: "c".repeat(40),
          mergeCommitSha: null,
          mergeable: null,
          reviewWorkflowAtBase: workflow,
        },
      ],
    });
    const gateway = new OctokitCodexRotatingGitHubSecretGateway({
      appId: "123",
      privateKey: "private-key",
    });

    await expect(
      gateway.inspectReviewV2ManagedWorkflowInventory({
        githubInstallationId: "129500385",
        githubRepositoryId: "123456",
        repositoryFullName: "777genius/example",
        owner: "777genius",
      }),
    ).rejects.toThrow(
      "codex_rotating_workflow_inventory_mergeability_unavailable",
    );
  });

  it("fails closed when a merge ref moves during inspection", async () => {
    const actionSha = "a".repeat(40);
    const workflow = renderCodexRotatingAdvisoryWorkflow({
      actionRef: `777genius/review-router@${actionSha}`,
      apiUrl: "https://api.reviewrouter.site",
      providerInstanceId: "codex-rotating:123456",
      refreshScheduleCron: null,
      reviewActionV2Mode: CodexRotatingReviewActionV2Mode.T0,
    });
    mockManagedWorkflowInventory({
      reviewWorkflow: workflow,
      activePullRequests: [
        {
          number: 240,
          baseRef: "dev",
          baseHeadSha: "d".repeat(40),
          headSha: "c".repeat(40),
          mergeCommitSha: "e".repeat(40),
          movedMergeCommitSha: "9".repeat(40),
          reviewWorkflowAtBase: workflow,
          reviewWorkflowAtMerge: workflow,
        },
      ],
    });
    const gateway = new OctokitCodexRotatingGitHubSecretGateway({
      appId: "123",
      privateKey: "private-key",
    });

    await expect(
      gateway.inspectReviewV2ManagedWorkflowInventory({
        githubInstallationId: "129500385",
        githubRepositoryId: "123456",
        repositoryFullName: "777genius/example",
        owner: "777genius",
      }),
    ).rejects.toThrow("codex_rotating_workflow_inventory_coverage_moved");
  });

  it("fails closed when the open PR set changes during inspection", async () => {
    const actionSha = "a".repeat(40);
    const workflow = renderCodexRotatingAdvisoryWorkflow({
      actionRef: `777genius/review-router@${actionSha}`,
      apiUrl: "https://api.reviewrouter.site",
      providerInstanceId: "codex-rotating:123456",
      refreshScheduleCron: null,
      reviewActionV2Mode: CodexRotatingReviewActionV2Mode.T0,
    });
    mockManagedWorkflowInventory({
      reviewWorkflow: workflow,
      revalidatedActivePullRequests: [
        {
          number: 240,
          baseRef: "dev",
          baseHeadSha: "d".repeat(40),
          headSha: "c".repeat(40),
          mergeCommitSha: null,
          mergeable: false,
          reviewWorkflowAtBase: workflow,
        },
      ],
    });
    const gateway = new OctokitCodexRotatingGitHubSecretGateway({
      appId: "123",
      privateKey: "private-key",
    });

    await expect(
      gateway.inspectReviewV2ManagedWorkflowInventory({
        githubInstallationId: "129500385",
        githubRepositoryId: "123456",
        repositoryFullName: "777genius/example",
        owner: "777genius",
      }),
    ).rejects.toThrow("codex_rotating_workflow_inventory_coverage_moved");
  });

  it("accepts an interaction workflow pinned to the same immutable T0 runtime", async () => {
    const actionSha = "a".repeat(40);
    const workflow = renderCodexRotatingAdvisoryWorkflow({
      actionRef: `777genius/review-router@${actionSha}`,
      apiUrl: "https://api.reviewrouter.site",
      providerInstanceId: "codex-rotating:123456",
      refreshScheduleCron: null,
      reviewActionV2Mode: CodexRotatingReviewActionV2Mode.T0,
    });
    mockManagedWorkflowInventory({
      reviewWorkflow: workflow,
      interactionWorkflow: renderT0InteractionWorkflow(actionSha),
    });
    const gateway = new OctokitCodexRotatingGitHubSecretGateway({
      appId: "123",
      privateKey: "private-key",
    });

    await expect(
      gateway.inspectReviewV2ManagedWorkflowInventory({
        githubInstallationId: "129500385",
        githubRepositoryId: "123456",
        repositoryFullName: "777genius/example",
        owner: "777genius",
      }),
    ).resolves.toMatchObject({
      compatible: true,
      actionCommitSha: actionSha,
    });
  });

  it("rejects an interaction workflow pinned to a different runtime", async () => {
    const actionSha = "a".repeat(40);
    const workflow = renderCodexRotatingAdvisoryWorkflow({
      actionRef: `777genius/review-router@${actionSha}`,
      apiUrl: "https://api.reviewrouter.site",
      providerInstanceId: "codex-rotating:123456",
      refreshScheduleCron: null,
      reviewActionV2Mode: CodexRotatingReviewActionV2Mode.T0,
    });
    mockManagedWorkflowInventory({
      reviewWorkflow: workflow,
      interactionWorkflow: renderT0InteractionWorkflow("b".repeat(40)),
    });
    const gateway = new OctokitCodexRotatingGitHubSecretGateway({
      appId: "123",
      privateKey: "private-key",
    });

    await expect(
      gateway.inspectReviewV2ManagedWorkflowInventory({
        githubInstallationId: "129500385",
        githubRepositoryId: "123456",
        repositoryFullName: "777genius/example",
        owner: "777genius",
      }),
    ).resolves.toMatchObject({ compatible: false, actionCommitSha: actionSha });
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

function mockManagedWorkflowInventory(input: {
  readonly reviewWorkflow: string;
  readonly interactionWorkflow?: string;
  readonly activePullRequests?: readonly {
    readonly number: number;
    readonly draft?: boolean;
    readonly baseRef: string;
    readonly baseHeadSha: string;
    readonly listedBaseSha?: string;
    readonly movedBaseHeadSha?: string;
    readonly headSha: string;
    readonly mergeCommitSha?: string | null;
    readonly movedMergeCommitSha?: string | null;
    readonly mergeable?: boolean | null;
    readonly reviewWorkflowAtBase?: string;
    readonly legacyWorkflowAtBase?: string;
    readonly reviewWorkflowAtMerge?: string;
    readonly legacyWorkflowAtMerge?: string;
  }[];
  readonly revalidatedActivePullRequests?: readonly {
    readonly number: number;
    readonly draft?: boolean;
    readonly baseRef: string;
    readonly baseHeadSha: string;
    readonly listedBaseSha?: string;
    readonly movedBaseHeadSha?: string;
    readonly headSha: string;
    readonly mergeCommitSha?: string | null;
    readonly movedMergeCommitSha?: string | null;
    readonly mergeable?: boolean | null;
    readonly reviewWorkflowAtBase?: string;
    readonly legacyWorkflowAtBase?: string;
    readonly reviewWorkflowAtMerge?: string;
    readonly legacyWorkflowAtMerge?: string;
  }[];
}) {
  const activePullRequests = input.activePullRequests ?? [];
  const allPullRequests = [
    ...activePullRequests,
    ...(input.revalidatedActivePullRequests ?? []),
  ];
  const branches = [
    {
      ref: "main",
      headSha: "f".repeat(40),
      reviewWorkflow: input.reviewWorkflow,
      interactionWorkflow: input.interactionWorkflow,
    },
    ...allPullRequests.map((pullRequest) => ({
      ref: pullRequest.baseRef,
      headSha: pullRequest.baseHeadSha,
      movedHeadSha: pullRequest.movedBaseHeadSha,
      reviewWorkflow: pullRequest.reviewWorkflowAtBase,
      legacyWorkflow: pullRequest.legacyWorkflowAtBase,
    })),
  ];
  const mergeReferences = activePullRequests.flatMap((pullRequest) =>
    pullRequest.mergeCommitSha
      ? [
          {
            ref: pullRequest.mergeCommitSha,
            reviewWorkflow: pullRequest.reviewWorkflowAtMerge,
            legacyWorkflow: pullRequest.legacyWorkflowAtMerge,
          },
        ]
      : [],
  );
  const branchReads = new Map<string, number>();
  let pullListReads = 0;
  mocks.auth.mockResolvedValueOnce({
    token: "ghs_contents_read_token",
    expiresAt: "2026-05-25T12:15:00.000Z",
    permissions: { contents: "read", pull_requests: "read" },
  });
  mocks.request.mockImplementation(
    async (route: string, request: Record<string, unknown>) => {
      if (route === "GET /repos/{owner}/{repo}") {
        return { data: { id: 123456, default_branch: "main" } };
      }
      if (route === "GET /repos/{owner}/{repo}/pulls") {
        const pulls =
          pullListReads > 0 && input.revalidatedActivePullRequests
            ? input.revalidatedActivePullRequests
            : activePullRequests;
        pullListReads += 1;
        return {
          data:
            request.page === 1
              ? pulls.map((pullRequest) => ({
                  number: pullRequest.number,
                  draft: pullRequest.draft ?? false,
                  merge_commit_sha:
                    pullListReads > 1 && "movedMergeCommitSha" in pullRequest
                      ? pullRequest.movedMergeCommitSha
                      : (pullRequest.mergeCommitSha ?? null),
                  base: {
                    ref: pullRequest.baseRef,
                    sha:
                      pullListReads > 1 && "movedBaseHeadSha" in pullRequest
                        ? pullRequest.movedBaseHeadSha
                        : (pullRequest.listedBaseSha ??
                          pullRequest.baseHeadSha),
                    repo: { id: 123456 },
                  },
                  head: { sha: pullRequest.headSha },
                }))
              : [],
        };
      }
      if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") {
        const pullRequest = allPullRequests.find(
          (candidate) => candidate.number === request.pull_number,
        );
        if (!pullRequest) throw { status: 404 };
        return {
          data: {
            number: pullRequest.number,
            draft: pullRequest.draft ?? false,
            mergeable:
              "mergeable" in pullRequest ? pullRequest.mergeable : false,
            merge_commit_sha: pullRequest.mergeCommitSha ?? null,
            base: {
              ref: pullRequest.baseRef,
              sha: pullRequest.listedBaseSha ?? pullRequest.baseHeadSha,
              repo: { id: 123456 },
            },
            head: { sha: pullRequest.headSha },
          },
        };
      }
      if (route === "GET /repos/{owner}/{repo}/branches/{branch}") {
        const ref = String(request.branch);
        const branch = branches.find((candidate) => candidate.ref === ref);
        if (!branch) throw { status: 404 };
        const readCount = branchReads.get(ref) ?? 0;
        branchReads.set(ref, readCount + 1);
        return {
          data: {
            name: ref,
            commit: {
              sha:
                readCount > 0 &&
                "movedHeadSha" in branch &&
                typeof branch.movedHeadSha === "string"
                  ? branch.movedHeadSha
                  : branch.headSha,
            },
          },
        };
      }
      if (route === "GET /repos/{owner}/{repo}/contents/{path}") {
        const reference =
          branches.find((candidate) => candidate.headSha === request.ref) ??
          mergeReferences.find((candidate) => candidate.ref === request.ref);
        if (!reference) throw { status: 404 };
        const path = String(request.path);
        if (path === ".github/workflows/reviewrouter-codex.yml") {
          if (!reference.reviewWorkflow) throw { status: 404 };
          return fileContent(reference.reviewWorkflow);
        }
        if (path === ".github/workflows/reviewrouter.yml") {
          if (
            !("legacyWorkflow" in reference) ||
            typeof reference.legacyWorkflow !== "string"
          ) {
            throw { status: 404 };
          }
          return fileContent(reference.legacyWorkflow);
        }
        if (path === ".github/workflows/reviewrouter-interaction.yml") {
          if (
            !("interactionWorkflow" in reference) ||
            typeof reference.interactionWorkflow !== "string"
          ) {
            throw { status: 404 };
          }
          return fileContent(reference.interactionWorkflow);
        }
        throw { status: 404 };
      }
      throw new Error(`unexpected_github_route:${route}`);
    },
  );
}

function fileContent(workflow: string) {
  return {
    data: {
      type: "file",
      encoding: "base64",
      content: Buffer.from(workflow, "utf8").toString("base64"),
    },
  };
}

function renderT0InteractionWorkflow(actionSha: string) {
  return `name: ReviewRouter Interaction

permissions:
  actions: write
  id-token: write

jobs:
  interaction:
    env:
      RR_RUNTIME_REF: "${actionSha}"
      REVIEWROUTER_RUNTIME_CONFIG_MODE: "oidc"
      REVIEW_ROUTER_REVIEW_WORKFLOW_FILE: "reviewrouter-codex.yml"
    steps:
      - uses: actions/checkout@v6
        with:
          repository: 777genius/review-router
          ref: \${{ env.RR_RUNTIME_REF }}
`;
}
