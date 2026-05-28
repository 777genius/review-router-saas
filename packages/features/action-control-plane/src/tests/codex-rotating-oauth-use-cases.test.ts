import { describe, expect, it, vi } from "vitest";
import {
  InMemoryCodexRotatingOAuthRepository,
  preleaseCodexRotatingOAuth,
  finalizeCodexRotatingOAuthLease,
  preflightCodexRotatingOAuthWriteback,
  writebackCodexRotatingOAuth,
  issueCodexRotatingOAuthCheckoutToken,
  issueCodexRotatingOAuthCommentToken,
} from "../index";
import { parseReviewConfiguration } from "@reviewrouter/features-review-config";

const now = new Date("2026-05-25T12:00:00.000Z");
const workflowSha = "0123456789abcdef0123456789abcdef01234567";

const repository = {
  workspaceId: "workspace_1",
  repositoryId: "repo_1",
  githubRepositoryId: "123456",
  githubInstallationId: "789",
  fullName: "777genius/agent-teams-ai",
  owner: "777genius",
  selected: true,
  installationStatus: "active",
};

const claims = {
  iss: "https://token.actions.githubusercontent.com",
  aud: "reviewrouter",
  repository: "777genius/agent-teams-ai",
  repository_id: "123456",
  repository_visibility: "private",
  event_name: "pull_request",
  run_id: "9001",
  run_attempt: "1",
  workflow_ref:
    "777genius/agent-teams-ai/.github/workflows/reviewrouter-codex.yml@refs/heads/main",
  workflow_sha: workflowSha,
  actor: "belief",
  runner_environment: "github-hosted",
  iat: Math.floor(now.getTime() / 1000) - 10,
  nbf: Math.floor(now.getTime() / 1000) - 20,
  exp: Math.floor(now.getTime() / 1000) + 120,
  jti: "jti-123456789",
} as const;

describe("Codex rotating OAuth action control plane", () => {
  it("preleases, finalizes, and records encrypted writeback without plaintext", async () => {
    const codexRotatingOAuth = new InMemoryCodexRotatingOAuthRepository([
      {
        providerInstanceId: "codex-rotating:123456",
        repositoryFullName: "777genius/agent-teams-ai",
        githubRepositoryId: "123456",
        actionRef: `777genius/review-router@${workflowSha}`,
        workflowPath: ".github/workflows/reviewrouter-codex.yml",
        workflowSchemaVersion: 1,
      },
    ]);
    const dependencies = {
      oidcVerifier: {
        verify: vi.fn().mockResolvedValue(claims),
      },
      repositories: {
        findSelectedRepositoryByGithubId: vi.fn().mockResolvedValue(repository),
        findRuntimeReviewConfiguration: vi.fn(),
        recordHealthReport: vi.fn(),
      },
      codexRotatingOAuth,
      codexRotatingWorkflowSourceVerifier: {
        verifyWorkflowSource: vi.fn().mockResolvedValue({
          binding: {
            providerInstanceId: "codex-rotating:123456",
            repositoryFullName: "777genius/agent-teams-ai",
            githubRepositoryId: "123456",
            actionRef: `777genius/review-router@${workflowSha}`,
            workflowPath: ".github/workflows/reviewrouter-codex.yml",
            workflowSchemaVersion: 1,
          },
          workflowSourceSha256:
            "workflow-source-sha256-012345678901234567890123456789",
        }),
      },
      replayNonces: {
        tryConsumeNonce: vi.fn().mockResolvedValue(true),
      },
      codexRotatingSecretsReadTokens: {
        issueSecretsReadToken: vi.fn().mockResolvedValue({
          token: "ghs_public_key_read_token",
          expiresAt: new Date("2026-05-25T12:15:00.000Z"),
          permissions: { secrets: "read" },
        }),
      },
      codexRotatingSecretWriter: {
        assertCanWriteRepositorySecret: vi
          .fn()
          .mockResolvedValue({ status: "ready" }),
        putEncryptedRepositorySecret: vi.fn().mockResolvedValue({
          status: "accepted",
          statusCode: 204,
        }),
      },
      codexRotatingCheckoutTokens: {
        issueContentsReadToken: vi.fn().mockResolvedValue({
          token: "ghs_contents_read_token",
          expiresAt: new Date("2026-05-25T12:15:00.000Z"),
          permissions: { contents: "read", pullRequests: "read" },
        }),
      },
      commentTokens: {
        issueCommentToken: vi.fn().mockResolvedValue({
          token: "ghs_comment_token",
          expiresAt: new Date("2026-05-25T12:15:00.000Z"),
          repository: "777genius/agent-teams-ai",
          permissions: {
            contents: "read",
            pullRequests: "write",
            issues: "write",
          },
        }),
      },
      codexRotatingWritebackHmacKey: "writeback-key",
      clock: { now: () => now },
    };

    const prelease = await preleaseCodexRotatingOAuth(
      {
        oidcToken: "jwt",
        audience: "reviewrouter",
        providerInstanceId: "codex-rotating:123456",
        workflowSchemaVersion: 1,
      },
      dependencies,
    );
    expect(prelease).toMatchObject({
      protocolVersion: 1,
      providerInstanceId: "codex-rotating:123456",
      repository: "777genius/agent-teams-ai",
      generationHashSalt: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY",
      currentGeneration: 1,
    });
    expect(
      dependencies.codexRotatingWorkflowSourceVerifier.verifyWorkflowSource,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedActionOwnerRepo: "777genius/review-router",
        expectedActionRef: `777genius/review-router@${workflowSha}`,
        expectedActionRefs: [`777genius/review-router@${workflowSha}`],
        expectedProviderInstanceId: "codex-rotating:123456",
        expectedWorkflowSchemaVersion: 1,
      }),
    );

    const finalized = await finalizeCodexRotatingOAuthLease(
      {
        leaseId: prelease.leaseId,
        providerInstanceId: "codex-rotating:123456",
        restoredGenerationHash: "restored-generation-hash-value",
      },
      dependencies,
    );
    expect(finalized).toMatchObject({
      status: "finalized",
      nextGeneration: 2,
      repositoryOwner: "777genius",
      repositoryName: "agent-teams-ai",
      publicKeyReadToken: "ghs_public_key_read_token",
      runtimeConfigVersion: 1,
      runtimeEnv: {
        REVIEW_AUTH_MODE: "codex-oauth-rotating",
      },
    });

    await expect(
      preflightCodexRotatingOAuthWriteback(
        {
          leaseId: prelease.leaseId,
          providerInstanceId: "codex-rotating:123456",
          githubKeyId: "github-key",
        },
        dependencies,
      ),
    ).resolves.toEqual({ protocolVersion: 1, status: "ready" });

    await expect(
      writebackCodexRotatingOAuth(
        {
          body: {
            protocolVersion: 1,
            leaseId: prelease.leaseId,
            providerInstanceId: "codex-rotating:123456",
            generation: finalized.nextGeneration,
            latestGenerationHash: "latest-generation-hash-value-0123456789",
            encryptedValue: Buffer.from("ciphertext").toString("base64"),
            keyId: "github-key",
            idempotencyKey: "idem:9001:1",
          },
        },
        dependencies,
      ),
    ).resolves.toEqual({ protocolVersion: 1, status: "accepted" });

    await expect(
      issueCodexRotatingOAuthCheckoutToken(
        {
          leaseId: prelease.leaseId,
          providerInstanceId: "codex-rotating:123456",
        },
        dependencies,
      ),
    ).resolves.toEqual({
      protocolVersion: 1,
      token: "ghs_contents_read_token",
      expiresAt: "2026-05-25T12:15:00.000Z",
      repository: "777genius/agent-teams-ai",
      permissions: { contents: "read", pullRequests: "read" },
    });

    await expect(
      issueCodexRotatingOAuthCommentToken(
        {
          leaseId: prelease.leaseId,
          providerInstanceId: "codex-rotating:123456",
          authCleared: true,
        },
        dependencies,
      ),
    ).resolves.toMatchObject({
      protocolVersion: 1,
      token: "ghs_comment_token",
      repository: "777genius/agent-teams-ai",
    });

    await expect(
      writebackCodexRotatingOAuth(
        {
          body: {
            protocolVersion: 1,
            leaseId: prelease.leaseId,
            providerInstanceId: "codex-rotating:123456",
            generation: finalized.nextGeneration,
            latestGenerationHash: "latest-generation-hash-value-0123456789",
            encryptedValue: '{"auth_mode":"chatgpt"}',
            keyId: "github-key",
            idempotencyKey: "idem:plaintext",
          },
        },
        dependencies,
      ),
    ).rejects.toThrow();
  });

  it("accepts a trusted rollout action SHA while keeping the primary workflow pin strict", async () => {
    const previousActionRef =
      "777genius/review-router@1111111111111111111111111111111111111111";
    const currentActionRef = `777genius/review-router@${workflowSha}`;
    const codexRotatingOAuth = new InMemoryCodexRotatingOAuthRepository([
      {
        providerInstanceId: "codex-rotating:123456",
        repositoryFullName: "777genius/agent-teams-ai",
        githubRepositoryId: "123456",
        actionRef: currentActionRef,
        allowedActionRefs: [currentActionRef, previousActionRef],
        workflowPath: ".github/workflows/reviewrouter-codex.yml",
        workflowSchemaVersion: 1,
      },
    ]);
    const dependencies = {
      oidcVerifier: {
        verify: vi.fn().mockResolvedValue(claims),
      },
      repositories: {
        findSelectedRepositoryByGithubId: vi.fn().mockResolvedValue(repository),
        findRuntimeReviewConfiguration: vi.fn(),
        recordHealthReport: vi.fn(),
      },
      codexRotatingOAuth,
      codexRotatingWorkflowSourceVerifier: {
        verifyWorkflowSource: vi.fn().mockResolvedValue({
          binding: {
            providerInstanceId: "codex-rotating:123456",
            repositoryFullName: "777genius/agent-teams-ai",
            githubRepositoryId: "123456",
            actionRef: previousActionRef,
            workflowPath: ".github/workflows/reviewrouter-codex.yml",
            workflowSchemaVersion: 1,
          },
          workflowSourceSha256:
            "workflow-source-sha256-012345678901234567890123456789",
        }),
      },
      replayNonces: {
        tryConsumeNonce: vi.fn().mockResolvedValue(true),
      },
      clock: { now: () => now },
    };

    await expect(
      preleaseCodexRotatingOAuth(
        {
          oidcToken: "jwt",
          audience: "reviewrouter",
          providerInstanceId: "codex-rotating:123456",
          workflowSchemaVersion: 1,
        },
        dependencies,
      ),
    ).resolves.toMatchObject({
      providerInstanceId: "codex-rotating:123456",
      repository: "777genius/agent-teams-ai",
    });
    expect(
      dependencies.codexRotatingWorkflowSourceVerifier.verifyWorkflowSource,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedActionRef: currentActionRef,
        expectedActionRefs: [currentActionRef, previousActionRef],
      }),
    );
  });

  it("blocks rotating prelease when the production gate denies the repository", async () => {
    const dependencies = buildRotatingDependencies({
      codexRotatingRuntimeGate: {
        assertCodexRotatingOAuthEnabled: vi.fn(() => {
          throw new Error("codex_rotating_not_enabled");
        }),
      },
    });

    await expect(
      preleaseCodexRotatingOAuth(
        {
          oidcToken: "jwt",
          audience: "reviewrouter",
          providerInstanceId: "codex-rotating:123456",
          workflowSchemaVersion: 1,
        },
        dependencies,
      ),
    ).rejects.toThrow("codex_rotating_not_enabled");
    expect(
      dependencies.codexRotatingWorkflowSourceVerifier.verifyWorkflowSource,
    ).not.toHaveBeenCalled();
  });

  it("finalizes hybrid runtime env for rotating Codex reviews", async () => {
    const dependencies = buildRotatingDependencies({
      repositories: {
        findSelectedRepositoryByGithubId: vi.fn().mockResolvedValue(repository),
        findRuntimeReviewConfiguration: vi.fn().mockResolvedValue({
          source: "repository",
          version: 17,
          config: parseReviewConfiguration({
            schemaVersion: 2,
            providers: [
              {
                kind: "codex",
                authMode: "codex_subscription_oauth_rotating",
                model: "gpt-5.5",
                reasoningEffort: "high",
                agenticContext: true,
                fastMode: false,
              },
              {
                kind: "claude",
                authMode: "claude_code_oauth",
                model: "sonnet",
                reasoningEffort: "medium",
                agenticContext: true,
                fastMode: false,
              },
              {
                kind: "openrouter",
                authMode: "openrouter_api_key",
                model: "openai/gpt-5.3-codex",
                reasoningEffort: "medium",
                agenticContext: true,
                fastMode: false,
              },
              {
                kind: "openrouter",
                authMode: "openrouter_api_key",
                model: "anthropic/claude-sonnet-4.5",
                reasoningEffort: "medium",
                agenticContext: true,
                fastMode: false,
              },
            ],
            execution: {
              providerMaxParallel: 4,
              inlineMinAgreement: 2,
            },
            blockingPolicy: { failOnSeverity: "critical" },
            limits: { inlineMaxComments: 5, targetTokensPerBatch: 50000 },
          }),
        }),
        recordHealthReport: vi.fn(),
      },
    });

    const prelease = await preleaseCodexRotatingOAuth(
      {
        oidcToken: "jwt",
        audience: "reviewrouter",
        providerInstanceId: "codex-rotating:123456",
        workflowSchemaVersion: 1,
      },
      dependencies,
    );
    const finalized = await finalizeCodexRotatingOAuthLease(
      {
        leaseId: prelease.leaseId,
        providerInstanceId: "codex-rotating:123456",
        restoredGenerationHash: "restored-generation-hash-value",
      },
      dependencies,
    );

    expect(finalized.status).toBe("finalized");
    if (finalized.status !== "finalized") {
      throw new Error("expected_finalized");
    }
    expect(finalized.runtimeConfigVersion).toBe(17);
    expect(finalized.runtimeEnv).toMatchObject({
      REVIEW_AUTH_MODE: "codex-oauth-rotating",
      REVIEW_PROVIDERS:
        "codex/gpt-5.5,claude/sonnet,openrouter/openai/gpt-5.3-codex,openrouter/anthropic/claude-sonnet-4.5",
      REQUIRED_HEALTHY_PROVIDERS: "codex/gpt-5.5",
      PROVIDER_LIMIT: "4",
      PROVIDER_MAX_PARALLEL: "4",
      INLINE_MIN_AGREEMENT: "2",
      CODEX_MODEL: "gpt-5.5",
      CLAUDE_MODEL: "sonnet",
      CLAUDE_AGENTIC_CONTEXT: "true",
    });
    expect(finalized.runtimeEnv).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
    expect(finalized.runtimeEnv).not.toHaveProperty("OPENROUTER_API_KEY");
  });

  it("moves failed encrypted writeback into unknown auth state before another refresh can start", async () => {
    const codexRotatingOAuth = new InMemoryCodexRotatingOAuthRepository([
      {
        providerInstanceId: "codex-rotating:123456",
        repositoryFullName: "777genius/agent-teams-ai",
        githubRepositoryId: "123456",
        actionRef: `777genius/review-router@${workflowSha}`,
        workflowPath: ".github/workflows/reviewrouter-codex.yml",
        workflowSchemaVersion: 1,
      },
    ]);
    const dependencies = buildRotatingDependencies({
      codexRotatingOAuth,
      oidcVerifier: {
        verify: vi
          .fn()
          .mockResolvedValueOnce(claims)
          .mockResolvedValueOnce({
            ...claims,
            run_id: "9002",
            jti: "jti-after-failed-writeback",
          }),
      },
      codexRotatingSecretWriter: {
        assertCanWriteRepositorySecret: vi
          .fn()
          .mockResolvedValue({ status: "ready" }),
        putEncryptedRepositorySecret: vi
          .fn()
          .mockRejectedValue(new Error("github_put_failed")),
      },
    });

    const prelease = await preleaseCodexRotatingOAuth(
      {
        oidcToken: "jwt",
        audience: "reviewrouter",
        providerInstanceId: "codex-rotating:123456",
        workflowSchemaVersion: 1,
      },
      dependencies,
    );
    const finalized = await finalizeCodexRotatingOAuthLease(
      {
        leaseId: prelease.leaseId,
        providerInstanceId: "codex-rotating:123456",
        restoredGenerationHash: "restored-generation-hash-value",
      },
      dependencies,
    );
    await preflightCodexRotatingOAuthWriteback(
      {
        leaseId: prelease.leaseId,
        providerInstanceId: "codex-rotating:123456",
        githubKeyId: "github-key",
      },
      dependencies,
    );

    await expect(
      writebackCodexRotatingOAuth(
        {
          body: {
            protocolVersion: 1,
            leaseId: prelease.leaseId,
            providerInstanceId: "codex-rotating:123456",
            generation: finalized.nextGeneration,
            latestGenerationHash: "latest-generation-hash-value-0123456789",
            encryptedValue: Buffer.from("ciphertext").toString("base64"),
            keyId: "github-key",
            idempotencyKey: "idem:failed-writeback",
          },
        },
        dependencies,
      ),
    ).resolves.toEqual({
      protocolVersion: 1,
      status: "github_put_failed",
    });

    await expect(
      preleaseCodexRotatingOAuth(
        {
          oidcToken: "jwt-after-failed-writeback",
          audience: "reviewrouter",
          providerInstanceId: "codex-rotating:123456",
          workflowSchemaVersion: 1,
        },
        dependencies,
      ),
    ).rejects.toThrow("codex_rotating_provider_unknown_auth_state");
  });
});

type RotatingDependencies = Parameters<typeof preleaseCodexRotatingOAuth>[1] &
  Parameters<typeof finalizeCodexRotatingOAuthLease>[1] &
  Parameters<typeof preflightCodexRotatingOAuthWriteback>[1] &
  Parameters<typeof writebackCodexRotatingOAuth>[1] &
  Parameters<typeof issueCodexRotatingOAuthCheckoutToken>[1] &
  Parameters<typeof issueCodexRotatingOAuthCommentToken>[1];

function buildRotatingDependencies(
  overrides: Partial<RotatingDependencies> = {},
): RotatingDependencies {
  const codexRotatingOAuth =
    overrides.codexRotatingOAuth ??
    new InMemoryCodexRotatingOAuthRepository([
      {
        providerInstanceId: "codex-rotating:123456",
        repositoryFullName: "777genius/agent-teams-ai",
        githubRepositoryId: "123456",
        actionRef: `777genius/review-router@${workflowSha}`,
        workflowPath: ".github/workflows/reviewrouter-codex.yml",
        workflowSchemaVersion: 1,
      },
    ]);

  const defaults = {
    oidcVerifier: overrides.oidcVerifier ?? {
      verify: vi.fn().mockResolvedValue(claims),
    },
    repositories: {
      findSelectedRepositoryByGithubId: vi.fn().mockResolvedValue(repository),
      findRuntimeReviewConfiguration: vi.fn(),
      recordHealthReport: vi.fn(),
    },
    codexRotatingOAuth,
    ...(overrides.codexRotatingRuntimeGate
      ? { codexRotatingRuntimeGate: overrides.codexRotatingRuntimeGate }
      : {}),
    codexRotatingWorkflowSourceVerifier: {
      verifyWorkflowSource: vi.fn().mockResolvedValue({
        binding: {
          providerInstanceId: "codex-rotating:123456",
          repositoryFullName: "777genius/agent-teams-ai",
          githubRepositoryId: "123456",
          actionRef: `777genius/review-router@${workflowSha}`,
          workflowPath: ".github/workflows/reviewrouter-codex.yml",
          workflowSchemaVersion: 1,
        },
        workflowSourceSha256:
          "workflow-source-sha256-012345678901234567890123456789",
      }),
    },
    replayNonces: {
      tryConsumeNonce: vi.fn().mockResolvedValue(true),
    },
    codexRotatingSecretsReadTokens: {
      issueSecretsReadToken: vi.fn().mockResolvedValue({
        token: "ghs_public_key_read_token",
        expiresAt: new Date("2026-05-25T12:15:00.000Z"),
        permissions: { secrets: "read" },
      }),
    },
    codexRotatingSecretWriter: overrides.codexRotatingSecretWriter ?? {
      assertCanWriteRepositorySecret: vi
        .fn()
        .mockResolvedValue({ status: "ready" }),
      putEncryptedRepositorySecret: vi.fn().mockResolvedValue({
        status: "accepted",
        statusCode: 204,
      }),
    },
    codexRotatingCheckoutTokens: {
      issueContentsReadToken: vi.fn().mockResolvedValue({
        token: "ghs_contents_read_token",
        expiresAt: new Date("2026-05-25T12:15:00.000Z"),
        permissions: { contents: "read", pullRequests: "read" },
      }),
    },
    commentTokens: {
      issueCommentToken: vi.fn().mockResolvedValue({
        token: "ghs_comment_token",
        expiresAt: new Date("2026-05-25T12:15:00.000Z"),
        repository: "777genius/agent-teams-ai",
        permissions: {
          contents: "read",
          pullRequests: "write",
          issues: "write",
        },
      }),
    },
    codexRotatingWritebackHmacKey: "writeback-key",
    clock: { now: () => now },
  } satisfies RotatingDependencies;

  return {
    ...defaults,
    ...overrides,
    codexRotatingOAuth,
  };
}
