import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import type {
  ReviewSnapshotRecord,
  ReviewSnapshotRepositoryPort,
} from "@reviewrouter/features-review-snapshots";
import {
  computeCodexAuthGenerationHash,
  encryptCodexRotatingAuthForGitHubSecret,
  readCodexRotatingWorkflowSourceMetadata,
  renderCodexRotatingAdvisoryWorkflow,
  scanCodexRotatingAdvisoryWorkflow,
  createVersionedSecretWorkflowSourceAttestation,
  WorkflowSourceTrust,
} from "@reviewrouter/features-codex-oauth-rotating";
import {
  finalizeCodexRotatingOAuthLease,
  InMemoryCodexRotatingOAuthRepository,
  issueCodexRotatingOAuthCheckoutToken,
  issueCodexRotatingOAuthCommentToken,
  preflightCodexRotatingOAuthWriteback,
  preleaseCodexRotatingOAuth,
  registerActionControlPlaneRoutes,
  writebackCodexRotatingOAuth,
  CodexRotatingVersionedWritebackDispatcher,
} from "../index";

const firstRunAt = new Date("2026-05-25T12:00:00.000Z");
const secondRunAt = new Date("2026-05-25T12:05:00.000Z");
const workflowSha = "0123456789abcdef0123456789abcdef01234567";
const actionRef = `777genius/review-router@${workflowSha}`;
const providerInstanceId = "codex-rotating:123456";
const generationHashSalt = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY";
const allowNewWorkAdmission = {
  assertAdmitted: () => undefined,
};

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

const initialAuthJson = JSON.stringify({
  auth_mode: "chatgpt",
  tokens: {
    refresh_token: "initial-refresh-token",
    access_token: "initial-access-token",
  },
  last_refresh: "2026-05-25T11:55:00.000Z",
});

const refreshedAuthJson = JSON.stringify({
  auth_mode: "chatgpt",
  tokens: {
    refresh_token: "refreshed-refresh-token",
    access_token: "refreshed-access-token",
  },
  last_refresh: "2026-05-25T12:01:00.000Z",
});

describe("Codex rotating OAuth local E2E", () => {
  it("proves setup workflow -> first writeback -> next-run restore without plaintext SaaS", async () => {
    const githubPublicKeyBase64 = Buffer.alloc(32, 1).toString("base64");
    const workflow = renderCodexRotatingAdvisoryWorkflow({
      actionRef,
      apiUrl: "https://reviewrouter.site",
      providerInstanceId,
    });
    expect(scanCodexRotatingAdvisoryWorkflow(workflow)).toEqual({
      valid: true,
      errors: [],
    });
    const workflowMetadata = readCodexRotatingWorkflowSourceMetadata(workflow);

    const codexRotatingOAuth = new InMemoryCodexRotatingOAuthRepository([
      {
        providerInstanceId,
        repositoryFullName: repository.fullName,
        githubRepositoryId: repository.githubRepositoryId,
        actionRef,
        workflowPath: ".github/workflows/reviewrouter-codex.yml",
        workflowSchemaVersion: 1,
      },
    ]);
    const tokens = buildTokenFakes(codexRotatingOAuth);
    const dependencies = {
      oidcVerifier: {
        verify: vi
          .fn()
          .mockResolvedValueOnce(
            githubOidcClaims({
              runId: "9001",
              jti: "jti-first",
              now: firstRunAt,
            }),
          )
          .mockResolvedValueOnce(
            githubOidcClaims({
              runId: "9002",
              jti: "jti-second",
              now: secondRunAt,
            }),
          ),
      },
      repositories: {
        findSelectedRepositoryByGithubId: vi.fn().mockResolvedValue(repository),
        findRuntimeReviewConfiguration: vi.fn(),
        recordHealthReport: vi.fn(),
      },
      codexRotatingOAuth,
      codexRotatingWorkflowSourceVerifier: {
        verifyWorkflowSource: vi.fn(async (input) => {
          expect(input.expectedActionOwnerRepo).toBe("777genius/review-router");
          expect(input.expectedProviderInstanceId).toBe(providerInstanceId);
          expect(workflowMetadata.actionRef).toBe(actionRef);
          return {
            binding: {
              providerInstanceId: workflowMetadata.providerInstanceId,
              repositoryFullName: repository.fullName,
              githubRepositoryId: repository.githubRepositoryId,
              actionRef: workflowMetadata.actionRef,
              workflowPath: ".github/workflows/reviewrouter-codex.yml",
              workflowSchemaVersion: workflowMetadata.workflowSchemaVersion,
            },
            workflowSourceSha256:
              "workflow-source-sha256-012345678901234567890123456789",
          };
        }),
      },
      codexRotatingNewWorkAdmission: allowNewWorkAdmission,
      replayNonces: {
        tryConsumeNonce: vi.fn().mockResolvedValue(true),
      },
      ...tokens,
      codexRotatingWritebackHmacKey: "writeback-key",
      clock: { now: vi.fn(() => firstRunAt) },
    };

    const firstPrelease = requireLease(
      await preleaseCodexRotatingOAuth(
        {
          oidcToken: "first-oidc-jwt",
          audience: "reviewrouter",
          providerInstanceId,
          workflowSchemaVersion: 1,
        },
        dependencies,
      ),
    );
    expect(firstPrelease.currentGeneration).toBe(1);
    expect(firstPrelease.currentGenerationHash).toBeUndefined();

    const restoredGenerationHash = computeCodexAuthGenerationHash({
      authJsonBytes: initialAuthJson,
      generationHashSalt,
    });
    const firstLease = await finalizeCodexRotatingOAuthLease(
      {
        leaseId: firstPrelease.leaseId,
        providerInstanceId,
        restoredGenerationHash,
      },
      dependencies,
    );
    expect(firstLease.status).toBe("finalized");

    const encrypted = await encryptCodexRotatingAuthForGitHubSecret({
      authJsonBytes: refreshedAuthJson,
      githubPublicKeyBase64,
      githubKeyId: "github-key",
      generationHashSalt,
    });

    await expect(
      preflightCodexRotatingOAuthWriteback(
        {
          leaseId: firstPrelease.leaseId,
          providerInstanceId,
          githubKeyId: encrypted.keyId,
        },
        dependencies,
      ),
    ).resolves.toEqual({ protocolVersion: 1, status: "ready" });

    await expect(
      writebackCodexRotatingOAuth(
        {
          body: {
            protocolVersion: 1,
            leaseId: firstPrelease.leaseId,
            providerInstanceId,
            generation: firstLease.nextGeneration,
            latestGenerationHash: encrypted.latestGenerationHash,
            accountIdentityHash: "account-identity-hash-value-0123456789",
            accountIdentityAlgorithm: "provider_issuer_subject_account_v1",
            encryptedValue: encrypted.encryptedValue,
            keyId: encrypted.keyId,
            idempotencyKey: "idem:first-run",
          },
        },
        dependencies,
      ),
    ).resolves.toEqual({ protocolVersion: 1, status: "accepted" });
    expect(
      tokens.codexRotatingSecretWriter.putEncryptedRepositorySecret,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        encryptedValue: encrypted.encryptedValue,
        keyId: encrypted.keyId,
      }),
    );
    expect(
      JSON.stringify(
        tokens.codexRotatingSecretWriter.putEncryptedRepositorySecret.mock
          .calls,
      ),
    ).not.toContain("refreshed-refresh-token");

    await expect(
      issueCodexRotatingOAuthCheckoutToken(
        {
          leaseId: firstPrelease.leaseId,
          providerInstanceId,
        },
        dependencies,
      ),
    ).resolves.toMatchObject({
      protocolVersion: 1,
      repository: repository.fullName,
      permissions: { contents: "read", pullRequests: "read" },
    });

    await expect(
      issueCodexRotatingOAuthCommentToken(
        {
          leaseId: firstPrelease.leaseId,
          providerInstanceId,
          authCleared: true,
        },
        dependencies,
      ),
    ).resolves.toMatchObject({
      protocolVersion: 1,
      repository: repository.fullName,
    });

    dependencies.clock.now.mockReturnValue(secondRunAt);
    const secondPrelease = requireLease(
      await preleaseCodexRotatingOAuth(
        {
          oidcToken: "second-oidc-jwt",
          audience: "reviewrouter",
          providerInstanceId,
          workflowSchemaVersion: 1,
        },
        dependencies,
      ),
    );
    expect(secondPrelease.currentGeneration).toBe(2);
    expect(secondPrelease.currentGenerationHash).toBe(
      encrypted.latestGenerationHash,
    );
    await expect(
      finalizeCodexRotatingOAuthLease(
        {
          leaseId: secondPrelease.leaseId,
          providerInstanceId,
          restoredGenerationHash: encrypted.latestGenerationHash,
        },
        dependencies,
      ),
    ).resolves.toMatchObject({
      status: "finalized",
      nextGeneration: 3,
    });
  });

  it("exercises the rotating OAuth HTTP route chain without plaintext auth", async () => {
    const codexRotatingOAuth = new InMemoryCodexRotatingOAuthRepository([
      {
        providerInstanceId,
        repositoryFullName: repository.fullName,
        githubRepositoryId: repository.githubRepositoryId,
        actionRef,
        workflowPath: ".github/workflows/reviewrouter-codex.yml",
        workflowSchemaVersion: 1,
      },
    ]);
    const tokenFakes = buildTokenFakes(codexRotatingOAuth);
    const mutationAdmission = { assertEnabled: vi.fn() };
    const reviewSnapshots = new InMemoryReviewSnapshotRepository();
    const workflow = renderCodexRotatingAdvisoryWorkflow({
      actionRef,
      apiUrl: "https://reviewrouter.site",
      providerInstanceId,
    });
    const workflowMetadata = readCodexRotatingWorkflowSourceMetadata(workflow);
    const dependencies = {
      oidcVerifier: {
        verify: vi.fn().mockResolvedValue(
          githubOidcClaims({
            runId: "9003",
            jti: "jti-http",
            now: firstRunAt,
          }),
        ),
      },
      repositories: {
        findSelectedRepositoryByGithubId: vi.fn().mockResolvedValue(repository),
        findRuntimeReviewConfiguration: vi.fn(),
        recordHealthReport: vi.fn(),
      },
      codexRotatingOAuth,
      codexRotatingMutationAdmission: mutationAdmission,
      codexRotatingReviewSnapshotAccess: codexRotatingOAuth,
      reviewSnapshots,
      codexRotatingWorkflowSourceVerifier: {
        verifyWorkflowSource: vi.fn().mockResolvedValue({
          binding: {
            providerInstanceId: workflowMetadata.providerInstanceId,
            repositoryFullName: repository.fullName,
            githubRepositoryId: repository.githubRepositoryId,
            actionRef: workflowMetadata.actionRef,
            workflowPath: ".github/workflows/reviewrouter-codex.yml",
            workflowSchemaVersion: workflowMetadata.workflowSchemaVersion,
          },
          workflowSourceSha256:
            "workflow-source-sha256-012345678901234567890123456789",
        }),
      },
      codexRotatingNewWorkAdmission: allowNewWorkAdmission,
      replayNonces: {
        tryConsumeNonce: vi
          .fn()
          .mockResolvedValueOnce(true)
          .mockResolvedValueOnce(false),
      },
      ...tokenFakes,
      codexRotatingWritebackHmacKey: "writeback-key",
      clock: { now: vi.fn(() => firstRunAt) },
      sessions: {},
      ledgerKeys: {},
      compatibility: {},
    };
    const app = Fastify({ logger: false });
    await registerActionControlPlaneRoutes(
      app,
      dependencies as unknown as Parameters<
        typeof registerActionControlPlaneRoutes
      >[1],
    );

    const wrongAudiencePrelease = await app.inject({
      method: "POST",
      url: "/api/action/v1/codex-oauth/prelease",
      payload: {
        oidcToken: "otherwise-valid-wrong-audience-token",
        audience: "another-relying-party",
        providerInstanceId,
        workflowSchemaVersion: 1,
      },
    });
    expect(wrongAudiencePrelease.statusCode).toBe(401);
    expect(wrongAudiencePrelease.json()).toEqual({
      error: {
        code: "invalid_action_token",
        message:
          "GitHub Actions OIDC token is invalid, expired, or already used.",
        retryable: false,
      },
    });
    expect(dependencies.oidcVerifier.verify).not.toHaveBeenCalled();

    const prelease = await app.inject({
      method: "POST",
      url: "/api/action/v1/codex-oauth/prelease",
      payload: {
        oidcToken: "oidc-jwt",
        providerInstanceId,
        workflowSchemaVersion: 1,
      },
    });
    expect(prelease.statusCode).toBe(200);
    expect(dependencies.oidcVerifier.verify).toHaveBeenCalledWith({
      token: "oidc-jwt",
      audience: "reviewrouter",
    });
    const preleaseBody = prelease.json<{
      readonly leaseId: string;
      readonly generationHashSalt: string;
      readonly currentGeneration: number;
    }>();
    expect(preleaseBody.currentGeneration).toBe(1);

    const conflictingLease = await codexRotatingOAuth.acquirePrelease({
      repository,
      providerInstanceId,
      githubRunId: "9004",
      githubRunAttempt: "1",
      now: firstRunAt,
      newWorkAdmissionBarrier: allowNewWorkAdmission,
    });
    expect(conflictingLease).toMatchObject({
      leaseId: preleaseBody.leaseId,
      status: "conflict",
      runId: "9003",
      runAttempt: "1",
    });

    const restoredGenerationHash = computeCodexAuthGenerationHash({
      authJsonBytes: initialAuthJson,
      generationHashSalt: preleaseBody.generationHashSalt,
    });
    const finalize = await app.inject({
      method: "POST",
      url: "/api/action/v1/codex-oauth/finalize",
      payload: {
        leaseId: preleaseBody.leaseId,
        providerInstanceId,
        restoredGenerationHash,
      },
    });
    expect(finalize.statusCode).toBe(200);
    const finalizeBody = finalize.json<{ readonly nextGeneration: number }>();
    expect(finalizeBody.nextGeneration).toBe(2);

    const encrypted = await encryptCodexRotatingAuthForGitHubSecret({
      authJsonBytes: refreshedAuthJson,
      githubPublicKeyBase64: Buffer.alloc(32, 1).toString("base64"),
      githubKeyId: "github-key-http",
      generationHashSalt: preleaseBody.generationHashSalt,
    });
    const preflight = await app.inject({
      method: "POST",
      url: "/api/action/v1/codex-oauth/writeback-preflight",
      payload: {
        leaseId: preleaseBody.leaseId,
        providerInstanceId,
        githubKeyId: encrypted.keyId,
      },
    });
    expect(preflight.statusCode).toBe(200);
    expect(preflight.json()).toEqual({ protocolVersion: 1, status: "ready" });

    const invalidWriteback = await app.inject({
      method: "POST",
      url: "/api/action/v1/codex-oauth/writeback",
      payload: {
        protocolVersion: 1,
        leaseId: preleaseBody.leaseId,
        providerInstanceId,
        generation: finalizeBody.nextGeneration,
        latestGenerationHash: encrypted.latestGenerationHash,
        encryptedValue: encrypted.encryptedValue,
        keyId: encrypted.keyId,
        idempotencyKey: "idem:http-invalid-schema",
      },
    });
    expect(invalidWriteback.statusCode).toBe(400);
    expect(invalidWriteback.json()).toMatchObject({
      error: {
        code: "invalid_action_request",
        retryable: false,
      },
    });

    const writeback = await app.inject({
      method: "POST",
      url: "/api/action/v1/codex-oauth/writeback",
      payload: {
        protocolVersion: 1,
        leaseId: preleaseBody.leaseId,
        providerInstanceId,
        generation: finalizeBody.nextGeneration,
        latestGenerationHash: encrypted.latestGenerationHash,
        accountIdentityHash: "account-identity-hash-value-0123456789",
        accountIdentityAlgorithm: "provider_issuer_subject_account_v1",
        encryptedValue: encrypted.encryptedValue,
        keyId: encrypted.keyId,
        idempotencyKey: "idem:http-run",
      },
    });
    expect(writeback.statusCode).toBe(200);
    expect(writeback.json()).toEqual({
      protocolVersion: 1,
      status: "accepted",
    });
    expect(mutationAdmission.assertEnabled).toHaveBeenCalledTimes(4);
    expect(
      JSON.stringify(
        tokenFakes.codexRotatingSecretWriter.putEncryptedRepositorySecret.mock
          .calls,
      ),
    ).not.toContain("refreshed-refresh-token");

    const checkout = await app.inject({
      method: "POST",
      url: "/api/action/v1/codex-oauth/checkout-token",
      payload: {
        leaseId: preleaseBody.leaseId,
        providerInstanceId,
      },
    });
    expect(checkout.statusCode).toBe(200);
    expect(checkout.json()).toMatchObject({
      protocolVersion: 1,
      repository: repository.fullName,
      permissions: { contents: "read", pullRequests: "read" },
    });

    const comment = await app.inject({
      method: "POST",
      url: "/api/action/v1/codex-oauth/comment-token",
      payload: {
        leaseId: preleaseBody.leaseId,
        providerInstanceId,
        authCleared: true,
      },
    });
    expect(comment.statusCode).toBe(200);
    expect(comment.json()).toMatchObject({
      protocolVersion: 1,
      repository: repository.fullName,
    });

    const snapshotHeadToken = await app.inject({
      method: "POST",
      url: "/api/action/v1/codex-oauth/review-snapshot/head-token",
      payload: {
        leaseId: preleaseBody.leaseId,
        providerInstanceId,
      },
    });
    expect(snapshotHeadToken.statusCode).toBe(200);
    expect(snapshotHeadToken.json()).toMatchObject({
      protocolVersion: 1,
      repository: repository.fullName,
      permissions: { contents: "read", pullRequests: "read" },
    });

    const missingSnapshot = await app.inject({
      method: "POST",
      url: "/api/action/v1/codex-oauth/review-snapshot/restore",
      payload: {
        protocolVersion: 1,
        leaseId: preleaseBody.leaseId,
        providerInstanceId,
        pullRequestNumber: 240,
        baseSha: "b".repeat(40),
      },
    });
    expect(missingSnapshot.statusCode).toBe(200);
    expect(missingSnapshot.json()).toEqual({
      protocolVersion: 1,
      status: "missing",
      expectedVersion: 0,
    });

    const forgedScope = await app.inject({
      method: "POST",
      url: "/api/action/v1/codex-oauth/review-snapshot/restore",
      payload: {
        protocolVersion: 1,
        leaseId: preleaseBody.leaseId,
        providerInstanceId,
        repositoryId: "attacker_repo",
        pullRequestNumber: 240,
        baseSha: "b".repeat(40),
      },
    });
    expect(forgedScope.statusCode).toBe(400);

    const committedSnapshot = await app.inject({
      method: "POST",
      url: "/api/action/v1/codex-oauth/review-snapshot/commit",
      payload: {
        protocolVersion: 1,
        leaseId: preleaseBody.leaseId,
        providerInstanceId,
        expectedVersion: 0,
        pullRequestNumber: 240,
        schemaVersion: 1,
        reviewedHeadSha: "a".repeat(40),
        baseSha: "b".repeat(40),
        compatibilityKey: "c".repeat(64),
        payload: {
          reviewSummary: "Review complete",
          findings: [
            {
              file: "src/index.ts",
              line: 12,
              severity: "major",
              title: "Persist the state",
              message: "The state must be durable between runs.",
            },
          ],
        },
      },
    });
    expect(committedSnapshot.statusCode).toBe(200);
    expect(committedSnapshot.json()).toMatchObject({
      protocolVersion: 1,
      status: "committed",
      version: 1,
      reviewedHeadSha: "a".repeat(40),
    });
    expect(reviewSnapshots.record).toMatchObject({
      workspaceId: repository.workspaceId,
      repositoryId: repository.repositoryId,
      sourceRunId: "9003",
      sourceRunAttempt: "1",
    });

    const conflictingSnapshot = await app.inject({
      method: "POST",
      url: "/api/action/v1/codex-oauth/review-snapshot/commit",
      payload: {
        protocolVersion: 1,
        leaseId: preleaseBody.leaseId,
        providerInstanceId,
        expectedVersion: 0,
        pullRequestNumber: 240,
        schemaVersion: 1,
        reviewedHeadSha: "d".repeat(40),
        baseSha: "b".repeat(40),
        compatibilityKey: "c".repeat(64),
        payload: {
          reviewSummary: "Conflicting review",
          findings: [],
        },
      },
    });
    expect(conflictingSnapshot.statusCode).toBe(200);
    expect(conflictingSnapshot.json()).toEqual({
      protocolVersion: 1,
      status: "conflict",
      currentVersion: 1,
      currentHeadSha: "a".repeat(40),
    });

    const restoredSnapshot = await app.inject({
      method: "POST",
      url: "/api/action/v1/codex-oauth/review-snapshot/restore",
      payload: {
        protocolVersion: 1,
        leaseId: preleaseBody.leaseId,
        providerInstanceId,
        pullRequestNumber: 240,
        baseSha: "b".repeat(40),
      },
    });
    expect(restoredSnapshot.statusCode).toBe(200);
    expect(restoredSnapshot.json()).toMatchObject({
      protocolVersion: 1,
      status: "found",
      expectedVersion: 1,
      snapshot: {
        version: 1,
        reviewedHeadSha: "a".repeat(40),
        baseSha: "b".repeat(40),
      },
    });

    const replay = await app.inject({
      method: "POST",
      url: "/api/action/v1/codex-oauth/prelease",
      payload: {
        oidcToken: "oidc-jwt-replay",
        audience: "reviewrouter",
        providerInstanceId,
        workflowSchemaVersion: 1,
      },
    });
    expect(replay.statusCode).toBe(401);
    expect(replay.json()).toMatchObject({
      error: {
        code: "invalid_action_token",
        retryable: false,
      },
    });

    mutationAdmission.assertEnabled.mockImplementationOnce(() => {
      throw new Error("codex_rotating_not_enabled");
    });
    const blockedAbandon = await app.inject({
      method: "POST",
      url: "/api/action/v1/codex-oauth/abandon",
      payload: {
        leaseId: preleaseBody.leaseId,
        providerInstanceId,
        reason: "workflow_failed",
      },
    });
    expect(blockedAbandon.statusCode).toBe(403);
    expect(blockedAbandon.json()).toMatchObject({
      error: { code: "codex_rotating_not_enabled", retryable: false },
    });
    expect(mutationAdmission.assertEnabled).toHaveBeenCalledTimes(5);

    await app.close();
  });

  it("reports workflow source validation failures as workflow mismatches", async () => {
    const codexRotatingOAuth = new InMemoryCodexRotatingOAuthRepository([
      {
        providerInstanceId,
        repositoryFullName: repository.fullName,
        githubRepositoryId: repository.githubRepositoryId,
        actionRef,
        workflowPath: ".github/workflows/reviewrouter-codex.yml",
        workflowSchemaVersion: 1,
      },
    ]);
    const dependencies = {
      oidcVerifier: {
        verify: vi.fn().mockResolvedValue(
          githubOidcClaims({
            runId: "9001",
            jti: "jti-workflow-invalid",
            now: firstRunAt,
          }),
        ),
      },
      repositories: {
        findSelectedRepositoryByGithubId: vi.fn().mockResolvedValue(repository),
        findRuntimeReviewConfiguration: vi.fn(),
        recordHealthReport: vi.fn(),
      },
      codexRotatingOAuth,
      codexRotatingWorkflowSourceVerifier: {
        verifyWorkflowSource: vi
          .fn()
          .mockRejectedValue(
            new Error(
              "codex_rotating_workflow_invalid:workflow_permissions_must_grant_id_token_only",
            ),
          ),
      },
      codexRotatingNewWorkAdmission: allowNewWorkAdmission,
      replayNonces: {
        tryConsumeNonce: vi.fn().mockResolvedValue(true),
      },
      ...buildTokenFakes(codexRotatingOAuth),
      codexRotatingWritebackHmacKey: "writeback-key",
      clock: { now: vi.fn(() => firstRunAt) },
      sessions: {},
      ledgerKeys: {},
      compatibility: {},
    };
    const app = Fastify({ logger: false });
    await registerActionControlPlaneRoutes(
      app,
      dependencies as unknown as Parameters<
        typeof registerActionControlPlaneRoutes
      >[1],
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/action/v1/codex-oauth/prelease",
      payload: {
        oidcToken: "oidc-jwt",
        audience: "reviewrouter",
        providerInstanceId,
        workflowSchemaVersion: 1,
      },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: {
        code: "workflow_schema_mismatch",
        retryable: false,
      },
    });

    await app.close();
  });

  it.each([
    {
      internalCode: "codex_rotating_new_work_admission_closed",
      statusCode: 503,
      retryable: true,
      message: "Codex OAuth new review admission is temporarily closed.",
    },
    {
      internalCode: "codex_rotating_new_work_cohort_required",
      statusCode: 503,
      retryable: true,
      message:
        "Codex OAuth new review admission has no approved repository cohort.",
    },
    {
      internalCode: "codex_rotating_new_work_repository_not_approved",
      statusCode: 403,
      retryable: false,
      message:
        "This repository is not approved for Codex OAuth new review admission.",
    },
  ])(
    "reports $internalCode without masking the admission gate",
    async ({ internalCode, statusCode, retryable, message }) => {
      const codexRotatingOAuth = new InMemoryCodexRotatingOAuthRepository([
        {
          providerInstanceId,
          repositoryFullName: repository.fullName,
          githubRepositoryId: repository.githubRepositoryId,
          actionRef,
          workflowPath: ".github/workflows/reviewrouter-codex.yml",
          workflowSchemaVersion: 1,
        },
      ]);
      const dependencies = {
        oidcVerifier: {
          verify: vi.fn().mockResolvedValue(
            githubOidcClaims({
              runId: `admission-${statusCode}`,
              jti: `jti-${internalCode}`,
              now: firstRunAt,
            }),
          ),
        },
        repositories: {
          findSelectedRepositoryByGithubId: vi
            .fn()
            .mockResolvedValue(repository),
          findRuntimeReviewConfiguration: vi.fn(),
          recordHealthReport: vi.fn(),
        },
        codexRotatingOAuth,
        codexRotatingWorkflowSourceVerifier: {
          verifyWorkflowSource: vi.fn().mockResolvedValue({
            binding: {
              providerInstanceId,
              repositoryFullName: repository.fullName,
              githubRepositoryId: repository.githubRepositoryId,
              actionRef,
              workflowPath: ".github/workflows/reviewrouter-codex.yml",
              workflowSchemaVersion: 1,
            },
          }),
        },
        codexRotatingNewWorkAdmission: {
          assertAdmitted: vi.fn(() => {
            throw new Error(internalCode);
          }),
        },
        replayNonces: { tryConsumeNonce: vi.fn().mockResolvedValue(true) },
        ...buildTokenFakes(codexRotatingOAuth),
        codexRotatingWritebackHmacKey: "writeback-key",
        clock: { now: vi.fn(() => firstRunAt) },
        sessions: {},
        ledgerKeys: {},
        compatibility: {},
      };
      const app = Fastify({ logger: false });
      await registerActionControlPlaneRoutes(
        app,
        dependencies as unknown as Parameters<
          typeof registerActionControlPlaneRoutes
        >[1],
      );

      const response = await app.inject({
        method: "POST",
        url: "/api/action/v1/codex-oauth/prelease",
        payload: {
          oidcToken: "oidc-jwt",
          audience: "reviewrouter",
          providerInstanceId,
          workflowSchemaVersion: 1,
        },
      });
      expect(response.statusCode).toBe(statusCode);
      expect(response.json()).toEqual({
        error: { code: internalCode, message, retryable },
      });
      expect(dependencies.replayNonces.tryConsumeNonce).not.toHaveBeenCalled();

      await app.close();
    },
  );

  it("reports missing managed review admission without masking it as an invalid action request", async () => {
    const codexRotatingOAuth = new InMemoryCodexRotatingOAuthRepository([
      {
        providerInstanceId,
        repositoryFullName: repository.fullName,
        githubRepositoryId: repository.githubRepositoryId,
        actionRef,
        workflowPath: ".github/workflows/reviewrouter-codex.yml",
        workflowSchemaVersion: 1,
      },
    ]);
    const workflow = renderCodexRotatingAdvisoryWorkflow({
      actionRef,
      apiUrl: "https://reviewrouter.site",
      providerInstanceId,
    });
    const workflowMetadata = readCodexRotatingWorkflowSourceMetadata(workflow);
    const replayNonces = {
      tryConsumeNonce: vi.fn().mockResolvedValue(true),
    };
    const dependencies = {
      oidcVerifier: {
        verify: vi.fn().mockResolvedValue(
          githubOidcClaims({
            runId: "9005",
            runAttempt: "2",
            jti: "jti-review-request-not-ready",
            now: firstRunAt,
          }),
        ),
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
            providerInstanceId: workflowMetadata.providerInstanceId,
            repositoryFullName: repository.fullName,
            githubRepositoryId: repository.githubRepositoryId,
            actionRef: workflowMetadata.actionRef,
            workflowPath: ".github/workflows/reviewrouter-codex.yml",
            workflowSchemaVersion: workflowMetadata.workflowSchemaVersion,
          },
          workflowSourceSha256:
            "workflow-source-sha256-012345678901234567890123456789",
        }),
      },
      replayNonces,
      hostedReviewPreleaseGate: {
        evaluate: vi
          .fn()
          .mockRejectedValue(
            new Error("review_request_rerun_predecessor_missing"),
          ),
      },
      ...buildTokenFakes(),
      codexRotatingWritebackHmacKey: "writeback-key",
      clock: { now: vi.fn(() => firstRunAt) },
      sessions: {},
      ledgerKeys: {},
      compatibility: {},
    };
    const app = Fastify({ logger: false });
    await registerActionControlPlaneRoutes(
      app,
      dependencies as unknown as Parameters<
        typeof registerActionControlPlaneRoutes
      >[1],
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/action/v1/codex-oauth/prelease",
      payload: {
        oidcToken: "oidc-jwt",
        audience: "reviewrouter",
        providerInstanceId,
        workflowSchemaVersion: 1,
      },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: {
        code: "review_request_not_ready",
        message: "Managed review request admission is not ready for this run.",
        retryable: false,
      },
    });
    expect(replayNonces.tryConsumeNonce).not.toHaveBeenCalled();

    await app.close();
  });

  it("skips stale queued secrets before refresh starts", async () => {
    const codexRotatingOAuth = new InMemoryCodexRotatingOAuthRepository([
      {
        providerInstanceId,
        repositoryFullName: repository.fullName,
        githubRepositoryId: repository.githubRepositoryId,
        actionRef,
        workflowPath: ".github/workflows/reviewrouter-codex.yml",
        workflowSchemaVersion: 1,
      },
    ]);
    const dependencies = {
      oidcVerifier: {
        verify: vi
          .fn()
          .mockResolvedValueOnce(
            githubOidcClaims({
              runId: "9001",
              jti: "jti-first",
              now: firstRunAt,
            }),
          )
          .mockResolvedValueOnce(
            githubOidcClaims({
              runId: "9002",
              jti: "jti-stale",
              now: secondRunAt,
            }),
          ),
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
            providerInstanceId,
            repositoryFullName: repository.fullName,
            githubRepositoryId: repository.githubRepositoryId,
            actionRef,
            workflowPath: ".github/workflows/reviewrouter-codex.yml",
            workflowSchemaVersion: 1,
          },
          workflowSourceSha256:
            "workflow-source-sha256-012345678901234567890123456789",
        }),
      },
      codexRotatingNewWorkAdmission: allowNewWorkAdmission,
      replayNonces: {
        tryConsumeNonce: vi.fn().mockResolvedValue(true),
      },
      ...buildTokenFakes(codexRotatingOAuth),
      codexRotatingWritebackHmacKey: "writeback-key",
      clock: { now: vi.fn(() => firstRunAt) },
    };

    const firstPrelease = requireLease(
      await preleaseCodexRotatingOAuth(
        {
          oidcToken: "first-oidc-jwt",
          audience: "reviewrouter",
          providerInstanceId,
          workflowSchemaVersion: 1,
        },
        dependencies,
      ),
    );
    const firstLease = await finalizeCodexRotatingOAuthLease(
      {
        leaseId: firstPrelease.leaseId,
        providerInstanceId,
        restoredGenerationHash: "first-generation-hash-value-0123456789",
      },
      dependencies,
    );
    await preflightCodexRotatingOAuthWriteback(
      {
        leaseId: firstPrelease.leaseId,
        providerInstanceId,
        githubKeyId: "github-key",
      },
      dependencies,
    );
    await writebackCodexRotatingOAuth(
      {
        body: {
          protocolVersion: 1,
          leaseId: firstPrelease.leaseId,
          providerInstanceId,
          generation: firstLease.nextGeneration,
          latestGenerationHash: "latest-generation-hash-value-0123456789",
          accountIdentityHash: "account-identity-hash-value-0123456789",
          accountIdentityAlgorithm: "provider_issuer_subject_account_v1",
          encryptedValue: Buffer.from("ciphertext").toString("base64"),
          keyId: "github-key",
          idempotencyKey: "idem:first-run",
        },
      },
      dependencies,
    );

    dependencies.clock.now.mockReturnValue(secondRunAt);
    const stalePrelease = requireLease(
      await preleaseCodexRotatingOAuth(
        {
          oidcToken: "stale-oidc-jwt",
          audience: "reviewrouter",
          providerInstanceId,
          workflowSchemaVersion: 1,
        },
        dependencies,
      ),
    );
    await expect(
      finalizeCodexRotatingOAuthLease(
        {
          leaseId: stalePrelease.leaseId,
          providerInstanceId,
          restoredGenerationHash: "old-generation-hash-value-0123456789",
        },
        dependencies,
      ),
    ).resolves.toMatchObject({
      status: "stale_queued_secret",
    });
  });
});

class InMemoryReviewSnapshotRepository implements ReviewSnapshotRepositoryPort {
  record: ReviewSnapshotRecord | null = null;

  async find(input: {
    readonly workspaceId: string;
    readonly repositoryId: string;
    readonly pullRequestNumber: number;
  }): Promise<ReviewSnapshotRecord | null> {
    return this.record?.workspaceId === input.workspaceId &&
      this.record.repositoryId === input.repositoryId &&
      this.record.pullRequestNumber === input.pullRequestNumber
      ? this.record
      : null;
  }

  async commit(input: {
    readonly expectedVersion: number;
    readonly record: ReviewSnapshotRecord;
  }) {
    if ((this.record?.version ?? 0) !== input.expectedVersion) {
      return {
        status: "conflict" as const,
        currentVersion: this.record?.version ?? 0,
        currentHeadSha:
          this.record?.reviewedHeadSha ?? input.record.reviewedHeadSha,
      };
    }
    this.record = input.record;
    return { status: "committed" as const, snapshot: input.record };
  }

  async pruneExpired(): Promise<number> {
    return 0;
  }
}

function githubOidcClaims(input: {
  readonly runId: string;
  readonly runAttempt?: string | undefined;
  readonly jti: string;
  readonly now: Date;
}) {
  return {
    iss: "https://token.actions.githubusercontent.com",
    aud: "reviewrouter",
    repository: repository.fullName,
    repository_id: repository.githubRepositoryId,
    repository_visibility: "private",
    event_name: "pull_request",
    ref: "refs/pull/240/merge",
    run_id: input.runId,
    run_attempt: input.runAttempt ?? "1",
    workflow_ref:
      "777genius/agent-teams-ai/.github/workflows/reviewrouter-codex.yml@refs/heads/main",
    workflow_sha: workflowSha,
    actor: "belief",
    runner_environment: "github-hosted",
    iat: Math.floor(input.now.getTime() / 1000) - 10,
    nbf: Math.floor(input.now.getTime() / 1000) - 20,
    exp: Math.floor(input.now.getTime() / 1000) + 120,
    jti: input.jti,
  } as const;
}

function requireLease(
  response: Awaited<ReturnType<typeof preleaseCodexRotatingOAuth>>,
) {
  if ("status" in response) {
    throw new Error("expected_codex_rotating_prelease_lease");
  }
  return response;
}

function buildTokenFakes(ledger?: InMemoryCodexRotatingOAuthRepository) {
  const codexRotatingSecretWriter = {
    assertCanWriteRepositorySecret: vi
      .fn()
      .mockResolvedValue({ status: "ready" as const }),
    putEncryptedRepositorySecret: vi.fn().mockResolvedValue({
      status: "accepted" as const,
      statusCode: 204 as const,
    }),
  };
  const codexRotatingVersionedWriteback = ledger
    ? new CodexRotatingVersionedWritebackDispatcher(
        ledger,
        codexRotatingSecretWriter,
        {
          publishAndVerifyVersionedWorkflow: vi.fn(async ({ namespace }) =>
            createVersionedSecretWorkflowSourceAttestation({
              repositoryId: namespace.scope.repositoryId,
              workflowPath: ".github/workflows/reviewrouter-codex.yml",
              workflowSourceCommitSha: "a".repeat(40),
              workflowSourceBlobSha: "b".repeat(40),
              workflowSourceSha256: "c".repeat(64),
              workflowSemanticSha256: "d".repeat(64),
              sourceTrust: WorkflowSourceTrust.TrustedDefaultBranchRevision,
              secretNamespace: namespace,
            }),
          ),
        },
        { now: () => firstRunAt },
      )
    : {
        dispatchOneShot: vi.fn(async ({ request }) => ({
          status: "accepted" as const,
          generation: request.generation,
        })),
      };
  return {
    codexRotatingSecretsReadTokens: {
      issueSecretsReadToken: vi.fn().mockResolvedValue({
        token: "ghs_public_key_read_token",
        expiresAt: new Date("2026-05-25T12:15:00.000Z"),
        permissions: { secrets: "read" },
      }),
    },
    codexRotatingSecretWriter,
    codexRotatingVersionedWriteback,
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
        repository: repository.fullName,
        permissions: {
          contents: "read",
          pullRequests: "write",
          issues: "write",
          statuses: "write",
        },
      }),
    },
  };
}
