import { describe, expect, it, vi } from "vitest";
import {
  InMemoryCodexRotatingOAuthRepository,
  preleaseCodexRotatingOAuth,
  abandonCodexRotatingOAuthLease,
  finalizeCodexRotatingOAuthLease,
  preflightCodexRotatingOAuthWriteback,
  writebackCodexRotatingOAuth,
  issueCodexRotatingOAuthCheckoutToken,
  issueCodexRotatingOAuthCommentToken,
  codexRotatingCommentTokenRefreshTtlMs,
  CodexRotatingVersionedWritebackDispatcher,
} from "../index";
import { parseReviewConfiguration } from "@reviewrouter/features-review-config";
import {
  computeEncryptedPayloadDigest,
  createVersionedSecretWorkflowSourceAttestation,
  WorkflowSourceTrust,
} from "@reviewrouter/features-codex-oauth-rotating";

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
  ref: "refs/pull/240/merge",
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

const pullRequestTargetClaims = {
  ...claims,
  event_name: "pull_request_target",
  ref: "refs/heads/main",
} as const;

describe("Codex rotating OAuth action control plane", () => {
  it("fails closed across a recovery-witness change before memory lease and writeback mutation", async () => {
    const witnessOne = "witness_generation_one_12345678901234567890";
    const witnessTwo = "witness_generation_two_12345678901234567890";
    let currentWitness = witnessOne;
    const binding = {
      providerInstanceId: "codex-rotating:123456",
      repositoryFullName: "777genius/agent-teams-ai",
      githubRepositoryId: "123456",
      actionRef: `777genius/review-router@${workflowSha}`,
      workflowPath: ".github/workflows/reviewrouter-codex.yml",
      workflowSchemaVersion: 1,
    } as const;
    const ledger = new InMemoryCodexRotatingOAuthRepository([binding], {
      initialDatabaseRecoveryWitness: witnessOne,
      currentDatabaseRecoveryWitness: () => currentWitness,
    });
    await ledger.ensureVerifiedProviderBinding({ repository, binding });

    currentWitness = witnessTwo;
    await expect(
      ledger.acquirePrelease({
        repository,
        providerInstanceId: binding.providerInstanceId,
        githubRunId: "witness-run",
        githubRunAttempt: "1",
        now,
        newWorkAdmissionBarrier: allowNewWorkAdmission,
      }),
    ).rejects.toThrow("codex_rotating_database_recovery_witness_mismatch");

    currentWitness = witnessOne;
    const lease = await ledger.acquirePrelease({
      repository,
      providerInstanceId: binding.providerInstanceId,
      githubRunId: "witness-run",
      githubRunAttempt: "1",
      now,
      newWorkAdmissionBarrier: allowNewWorkAdmission,
    });
    expect(lease.status).toBe("preleased");

    currentWitness = witnessTwo;
    await expect(
      ledger.finalizeLease({
        leaseId: lease.leaseId,
        providerInstanceId: binding.providerInstanceId,
        restoredGenerationHash: "restored-generation-hash-value",
        now,
      }),
    ).rejects.toThrow("codex_rotating_database_recovery_witness_mismatch");

    currentWitness = witnessOne;
    const finalized = await ledger.finalizeLease({
      leaseId: lease.leaseId,
      providerInstanceId: binding.providerInstanceId,
      restoredGenerationHash: "restored-generation-hash-value",
      now,
    });
    await ledger.preflightWriteback({
      leaseId: lease.leaseId,
      providerInstanceId: binding.providerInstanceId,
      githubKeyId: "github-key",
      now,
    });
    const request = {
      protocolVersion: 1 as const,
      leaseId: lease.leaseId,
      providerInstanceId: binding.providerInstanceId,
      generation: finalized.nextGeneration,
      latestGenerationHash: "latest-generation-hash-value-0123456789",
      accountIdentityHash: "account-identity-hash-value-0123456789",
      accountIdentityAlgorithm: "provider_issuer_subject_account_v1" as const,
      encryptedValue: Buffer.from("ciphertext").toString("base64"),
      keyId: "github-key",
      idempotencyKey: "idem:witness-proof",
    };

    currentWitness = witnessTwo;
    await expect(
      ledger.prepareVersionedWriteback({
        request,
        encryptedPayloadDigest: "encrypted-digest",
        now,
      }),
    ).rejects.toThrow("codex_rotating_database_recovery_witness_mismatch");

    currentWitness = witnessOne;
    await expect(
      ledger.prepareVersionedWriteback({
        request,
        encryptedPayloadDigest: "encrypted-digest",
        now,
      }),
    ).resolves.toMatchObject({ status: "ready" });
  });

  it("never falls back to the legacy fixed-name writer", async () => {
    const dispatchOneShot = vi.fn().mockResolvedValue({
      status: "writeback_recovery_required",
    });

    await expect(
      writebackCodexRotatingOAuth(
        {
          body: {
            protocolVersion: 1,
            leaseId: "lease-pre-dispatch",
            providerInstanceId: "codex-rotating:123456",
            generation: 2,
            latestGenerationHash: "latest-generation-hash-value-0123456789",
            accountIdentityHash: "account-identity-hash-value-0123456789",
            accountIdentityAlgorithm: "provider_issuer_subject_account_v1",
            encryptedValue: Buffer.from("ciphertext").toString("base64"),
            keyId: "github-key",
            idempotencyKey: "idem:pre-dispatch",
          },
        },
        {
          codexRotatingVersionedWriteback: { dispatchOneShot },
          codexRotatingWritebackHmacKey: "test-writeback-hmac-key",
          clock: { now: () => now },
        },
      ),
    ).resolves.toEqual({
      protocolVersion: 1,
      status: "writeback_recovery_required",
    });
    expect(dispatchOneShot).toHaveBeenCalledOnce();
  });

  it("preserves completed and unchanged digest evidence across stale retirement", async () => {
    const witnessOne = "witness_generation_one_12345678901234567890";
    const witnessTwo = "witness_generation_two_12345678901234567890";
    let currentWitness = witnessOne;
    let currentIncarnation = "database-incarnation-one";
    const codexRotatingOAuth = new InMemoryCodexRotatingOAuthRepository(
      [
        {
          providerInstanceId: "codex-rotating:123456",
          repositoryFullName: "777genius/agent-teams-ai",
          githubRepositoryId: "123456",
          actionRef: `777genius/review-router@${workflowSha}`,
          workflowPath: ".github/workflows/reviewrouter-codex.yml",
          workflowSchemaVersion: 1,
        },
      ],
      {
        initialDatabaseRecoveryWitness: witnessOne,
        currentDatabaseRecoveryWitness: () => currentWitness,
        currentDatabaseIncarnation: () => currentIncarnation,
      },
    );
    const dependencies = {
      oidcVerifier: {
        verify: vi.fn().mockResolvedValue(pullRequestTargetClaims),
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
        resolveWorkflowRunPullRequest: vi.fn().mockResolvedValue(240),
      },
      codexRotatingNewWorkAdmission: allowNewWorkAdmission,
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
      codexRotatingVersionedWriteback: {
        dispatchOneShot: vi.fn(),
      },
      clock: { now: () => now },
    };
    Object.assign(dependencies, {
      codexRotatingVersionedWriteback:
        new CodexRotatingVersionedWritebackDispatcher(
          codexRotatingOAuth,
          dependencies.codexRotatingSecretWriter,
          {
            publishAndVerifyVersionedWorkflow: vi.fn(async ({ namespace }) =>
              createVersionedSecretWorkflowSourceAttestation({
                repositoryId: namespace.scope.repositoryId,
                workflowPath: ".github/workflows/reviewrouter-codex.yml",
                workflowSourceCommitSha: "a".repeat(40),
                workflowSourceBlobSha: "b".repeat(40),
                workflowSourceSha256: "c".repeat(64),
                workflowSemanticSha256: "d".repeat(64),
                workflowSchemaVersion: 5,
                sourceTrust: WorkflowSourceTrust.TrustedDefaultBranchRevision,
                secretNamespace: namespace,
              }),
            ),
          },
          dependencies.clock,
        ),
    });

    const prelease = requireLease(
      await preleaseCodexRotatingOAuth(
        {
          oidcToken: "jwt",
          audience: "reviewrouter",
          providerInstanceId: "codex-rotating:123456",
          workflowSchemaVersion: 1,
        },
        dependencies,
      ),
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
        expectedProviderInstanceId: "codex-rotating:123456",
        expectedWorkflowSchemaVersion: 1,
      }),
    );
    expect(
      dependencies.codexRotatingWorkflowSourceVerifier
        .resolveWorkflowRunPullRequest,
    ).toHaveBeenCalledWith({
      repository,
      githubRunId: "9001",
      githubRunAttempt: "1",
      eventName: "pull_request_target",
    });

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

    const preparation = vi.spyOn(
      codexRotatingOAuth,
      "prepareVersionedWriteback",
    );
    const activation = vi.spyOn(
      codexRotatingOAuth,
      "activateVersionedWriteback",
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
            accountIdentityHash: "account-identity-hash-value-0123456789",
            accountIdentityAlgorithm: "provider_issuer_subject_account_v1",
            encryptedValue: Buffer.from("ciphertext").toString("base64"),
            keyId: "github-key",
            idempotencyKey: "idem:9001:1",
          },
        },
        dependencies,
      ),
    ).resolves.toEqual({ protocolVersion: 1, status: "accepted" });

    currentWitness = witnessTwo;
    await expect(
      writebackCodexRotatingOAuth(
        {
          body: {
            protocolVersion: 1,
            leaseId: prelease.leaseId,
            providerInstanceId: "codex-rotating:123456",
            generation: finalized.nextGeneration,
            latestGenerationHash: "latest-generation-hash-value-0123456789",
            accountIdentityHash: "account-identity-hash-value-0123456789",
            accountIdentityAlgorithm: "provider_issuer_subject_account_v1",
            encryptedValue: Buffer.from("ciphertext").toString("base64"),
            keyId: "github-key",
            idempotencyKey: "idem:9001:1",
          },
        },
        dependencies,
      ),
    ).rejects.toThrow("codex_rotating_database_recovery_witness_mismatch");

    currentWitness = witnessOne;
    currentIncarnation = "database-incarnation-two";
    await expect(
      writebackCodexRotatingOAuth(
        {
          body: {
            protocolVersion: 1,
            leaseId: prelease.leaseId,
            providerInstanceId: "codex-rotating:123456",
            generation: finalized.nextGeneration,
            latestGenerationHash: "latest-generation-hash-value-0123456789",
            accountIdentityHash: "account-identity-hash-value-0123456789",
            accountIdentityAlgorithm: "provider_issuer_subject_account_v1",
            encryptedValue: Buffer.from("ciphertext").toString("base64"),
            keyId: "github-key",
            idempotencyKey: "idem:9001:1",
          },
        },
        dependencies,
      ),
    ).rejects.toThrow("codex_rotating_database_incarnation_mismatch");

    currentIncarnation = "database-incarnation-one";

    await expect(
      writebackCodexRotatingOAuth(
        {
          body: {
            protocolVersion: 1,
            leaseId: prelease.leaseId,
            providerInstanceId: "codex-rotating:123456",
            generation: finalized.nextGeneration,
            latestGenerationHash: "latest-generation-hash-value-0123456789",
            accountIdentityHash: "account-identity-hash-value-0123456789",
            accountIdentityAlgorithm: "provider_issuer_subject_account_v1",
            encryptedValue: Buffer.from("ciphertext").toString("base64"),
            keyId: "github-key",
            idempotencyKey: "idem:9001:1",
          },
        },
        dependencies,
      ),
    ).resolves.toEqual({ protocolVersion: 1, status: "idempotent_replay" });
    await expect(
      writebackCodexRotatingOAuth(
        {
          body: {
            protocolVersion: 1,
            leaseId: prelease.leaseId,
            providerInstanceId: "codex-rotating:123456",
            generation: finalized.nextGeneration,
            latestGenerationHash: "latest-generation-hash-value-0123456789",
            accountIdentityHash: "account-identity-hash-value-0123456789",
            accountIdentityAlgorithm: "provider_issuer_subject_account_v1",
            encryptedValue: Buffer.from("different-ciphertext").toString(
              "base64",
            ),
            keyId: "github-key",
            idempotencyKey: "idem:9001:1",
          },
        },
        dependencies,
      ),
    ).resolves.toEqual({
      protocolVersion: 1,
      status: "writeback_idempotency_conflict",
    });
    expect(
      dependencies.codexRotatingSecretWriter.putEncryptedRepositorySecret,
    ).toHaveBeenCalledOnce();

    const activatedAttempt = activation.mock.calls[0]?.[0];
    if (!activatedAttempt) throw new Error("expected activated writeback");
    const preparedAttempt = await preparation.mock.results[0]?.value;
    if (!preparedAttempt || preparedAttempt.status !== "ready") {
      throw new Error("expected prepared writeback");
    }
    await codexRotatingOAuth.retireAmbiguousVersionedWriteback({
      intentId: activatedAttempt.intentId,
      attemptId: activatedAttempt.attemptId,
      executorOwner: activatedAttempt.executorOwner,
      retirementIdentity: preparedAttempt.retirementIdentity,
      safeErrorCode: "stale_retirement_after_activation",
      now,
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
            accountIdentityHash: "account-identity-hash-value-0123456789",
            accountIdentityAlgorithm: "provider_issuer_subject_account_v1",
            encryptedValue: Buffer.from("ciphertext").toString("base64"),
            keyId: "github-key",
            idempotencyKey: "idem:9001:1",
          },
        },
        dependencies,
      ),
    ).resolves.toEqual({ protocolVersion: 1, status: "idempotent_replay" });

    const unchangedLease = await codexRotatingOAuth.acquirePrelease({
      repository,
      providerInstanceId: "codex-rotating:123456",
      githubRunId: "9002",
      githubRunAttempt: "1",
      now,
      newWorkAdmissionBarrier: allowNewWorkAdmission,
    });
    if (unchangedLease.status === "conflict") {
      throw new Error("expected unchanged-generation lease");
    }
    const unchangedFinalized = await codexRotatingOAuth.finalizeLease({
      leaseId: unchangedLease.leaseId,
      providerInstanceId: "codex-rotating:123456",
      restoredGenerationHash: "latest-generation-hash-value-0123456789",
      now,
    });
    await codexRotatingOAuth.preflightWriteback({
      leaseId: unchangedLease.leaseId,
      providerInstanceId: "codex-rotating:123456",
      githubKeyId: "github-key",
      now,
    });
    const unchangedRequest = {
      protocolVersion: 1 as const,
      leaseId: unchangedLease.leaseId,
      providerInstanceId: "codex-rotating:123456",
      generation: unchangedFinalized.nextGeneration,
      latestGenerationHash: "latest-generation-hash-value-0123456789",
      accountIdentityHash: "account-identity-hash-value-0123456789",
      accountIdentityAlgorithm: "provider_issuer_subject_account_v1" as const,
      encryptedValue: Buffer.from("unchanged-ciphertext").toString("base64"),
      keyId: "github-key",
      idempotencyKey: "idem:9002:1",
    };
    const unchangedDigest = computeEncryptedPayloadDigest({
      encryptedValue: unchangedRequest.encryptedValue,
      hmacKey: dependencies.codexRotatingWritebackHmacKey,
    });
    await expect(
      codexRotatingOAuth.prepareVersionedWriteback({
        request: unchangedRequest,
        encryptedPayloadDigest: unchangedDigest,
        now,
      }),
    ).resolves.toEqual({
      status: "unchanged_generation",
      generation: unchangedRequest.generation,
    });
    await expect(
      codexRotatingOAuth.prepareVersionedWriteback({
        request: unchangedRequest,
        encryptedPayloadDigest: unchangedDigest,
        now,
      }),
    ).resolves.toEqual({
      status: "idempotent_replay",
      generation: unchangedRequest.generation,
    });
    await expect(
      codexRotatingOAuth.prepareVersionedWriteback({
        request: unchangedRequest,
        encryptedPayloadDigest: computeEncryptedPayloadDigest({
          encryptedValue: Buffer.from("changed-unchanged-ciphertext").toString(
            "base64",
          ),
          hmacKey: dependencies.codexRotatingWritebackHmacKey,
        }),
        now,
      }),
    ).resolves.toEqual({ status: "writeback_idempotency_conflict" });

    const newerOwner = await codexRotatingOAuth.acquirePrelease({
      repository,
      providerInstanceId: "codex-rotating:123456",
      githubRunId: "9003",
      githubRunAttempt: "1",
      now,
      newWorkAdmissionBarrier: allowNewWorkAdmission,
    });
    if (newerOwner.status === "conflict") {
      throw new Error("expected newer mutation owner");
    }
    await codexRotatingOAuth.retireAmbiguousVersionedWriteback({
      intentId: activatedAttempt.intentId,
      attemptId: activatedAttempt.attemptId,
      executorOwner: activatedAttempt.executorOwner,
      retirementIdentity: preparedAttempt.retirementIdentity,
      safeErrorCode: "stale_retirement_after_new_owner",
      now,
    });
    await expect(
      codexRotatingOAuth.finalizeLease({
        leaseId: newerOwner.leaseId,
        providerInstanceId: "codex-rotating:123456",
        restoredGenerationHash: "latest-generation-hash-value-0123456789",
        now,
      }),
    ).resolves.toMatchObject({ status: "finalized" });

    await expect(
      codexRotatingOAuth.authorizeReviewExecutionCheckpointAccess({
        leaseId: prelease.leaseId,
        providerInstanceId: "codex-rotating:123456",
        pullRequestNumber: 240,
        now,
      }),
    ).resolves.toMatchObject({
      status: "ready",
      scope: { pullRequestNumber: 240 },
    });
    await expect(
      codexRotatingOAuth.authorizeReviewSnapshotAccess({
        leaseId: prelease.leaseId,
        providerInstanceId: "codex-rotating:123456",
        pullRequestNumber: 240,
        now,
      }),
    ).resolves.toMatchObject({
      status: "ready",
      scope: { pullRequestNumber: 240 },
    });

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
            accountIdentityHash: "account-identity-hash-value-0123456789",
            accountIdentityAlgorithm: "provider_issuer_subject_account_v1",
            encryptedValue: '{"auth_mode":"chatgpt"}',
            keyId: "github-key",
            idempotencyKey: "idem:plaintext",
          },
        },
        dependencies,
      ),
    ).rejects.toThrow();
  });

  it.each([
    {
      name: "rejects a mutable ref from the expected action repository",
      workflowActionRef: "777genius/review-router@main",
      allowedActionRefs: undefined,
      accepted: false,
    },
    {
      name: "accepts an explicitly trusted old SHA during A to B overlap",
      workflowActionRef: `777genius/review-router@${"a".repeat(40)}`,
      allowedActionRefs: [
        `777genius/review-router@${workflowSha}`,
        `777genius/review-router@${"a".repeat(40)}`,
      ],
      accepted: true,
    },
    {
      name: "rejects an immutable same-repository SHA outside the overlap",
      workflowActionRef: `777genius/review-router@${"b".repeat(40)}`,
      allowedActionRefs: [
        `777genius/review-router@${workflowSha}`,
        `777genius/review-router@${"a".repeat(40)}`,
      ],
      accepted: false,
    },
  ])("$name", async ({ workflowActionRef, allowedActionRefs, accepted }) => {
    const currentActionRef = `777genius/review-router@${workflowSha}`;
    const binding = {
      providerInstanceId: "codex-rotating:123456",
      repositoryFullName: "777genius/agent-teams-ai",
      githubRepositoryId: "123456",
      actionRef: currentActionRef,
      ...(allowedActionRefs ? { allowedActionRefs } : {}),
      workflowPath: ".github/workflows/reviewrouter-codex.yml",
      workflowSchemaVersion: 1,
    };
    const codexRotatingOAuth = new InMemoryCodexRotatingOAuthRepository([
      binding,
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
            actionRef: workflowActionRef,
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
      clock: { now: () => now },
    };

    const result = preleaseCodexRotatingOAuth(
      {
        oidcToken: "jwt",
        audience: "reviewrouter",
        providerInstanceId: "codex-rotating:123456",
        workflowSchemaVersion: 1,
      },
      dependencies,
    );
    if (accepted) {
      await expect(result).resolves.toMatchObject({
        providerInstanceId: "codex-rotating:123456",
        repository: "777genius/agent-teams-ai",
      });
    } else {
      await expect(result).rejects.toThrow(
        "codex_rotating_workflow_action_ref_not_allowed",
      );
    }
    expect(
      dependencies.codexRotatingWorkflowSourceVerifier.verifyWorkflowSource,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedActionOwnerRepo: "777genius/review-router",
      }),
    );
  });

  it("abandons reconnect failures without leaving an active lease conflict", async () => {
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
        verify: vi
          .fn()
          .mockResolvedValueOnce(claims)
          .mockResolvedValueOnce({
            ...claims,
            run_id: "9002",
            jti: "jti-9002",
          }),
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
      codexRotatingNewWorkAdmission: allowNewWorkAdmission,
      replayNonces: {
        tryConsumeNonce: vi.fn().mockResolvedValue(true),
      },
      clock: { now: () => now },
    };

    const prelease = requireLease(
      await preleaseCodexRotatingOAuth(
        {
          oidcToken: "jwt",
          audience: "reviewrouter",
          providerInstanceId: "codex-rotating:123456",
          workflowSchemaVersion: 1,
        },
        dependencies,
      ),
    );

    await expect(
      abandonCodexRotatingOAuthLease(
        {
          leaseId: prelease.leaseId,
          providerInstanceId: "codex-rotating:123456",
          reason: "needs_reconnect",
        },
        dependencies,
      ),
    ).resolves.toEqual({ protocolVersion: 1, status: "abandoned" });

    await expect(
      preleaseCodexRotatingOAuth(
        {
          oidcToken: "jwt-2",
          audience: "reviewrouter",
          providerInstanceId: "codex-rotating:123456",
          workflowSchemaVersion: 1,
        },
        dependencies,
      ),
    ).rejects.toThrow("codex_rotating_provider_needs_reconnect");
  });

  it("rejects verifier bindings from an unexpected action repository", async () => {
    const dependencies = buildRotatingDependencies({
      codexRotatingWorkflowSourceVerifier: {
        verifyWorkflowSource: vi.fn().mockResolvedValue({
          binding: {
            providerInstanceId: "codex-rotating:123456",
            repositoryFullName: "777genius/agent-teams-ai",
            githubRepositoryId: "123456",
            actionRef: "evil/review-router@main",
            workflowPath: ".github/workflows/reviewrouter-codex.yml",
            workflowSchemaVersion: 1,
          },
          workflowSourceSha256:
            "workflow-source-sha256-012345678901234567890123456789",
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
    ).rejects.toThrow("codex_rotating_workflow_action_ref_not_allowed");
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

  it("checks the separate fail-closed new-work fence immediately before lease acquisition", async () => {
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
    const acquire = vi.spyOn(codexRotatingOAuth, "acquirePrelease");
    const dependencies = buildRotatingDependencies({
      codexRotatingOAuth,
      codexRotatingNewWorkAdmission: {
        assertAdmitted: () => {
          throw new Error("codex_rotating_new_work_admission_closed");
        },
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
    ).rejects.toThrow("codex_rotating_new_work_admission_closed");
    expect(acquire).not.toHaveBeenCalled();
    expect(dependencies.replayNonces.tryConsumeNonce).not.toHaveBeenCalled();
  });

  it("rechecks the live fence inside lease acquisition after the precheck", async () => {
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
    const assertAdmitted = vi
      .fn()
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error("codex_rotating_new_work_admission_closed");
      });
    const acquire = vi.spyOn(codexRotatingOAuth, "acquirePrelease");
    const dependencies = buildRotatingDependencies({
      codexRotatingOAuth,
      codexRotatingNewWorkAdmission: { assertAdmitted },
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
    ).rejects.toThrow("codex_rotating_new_work_admission_closed");
    expect(assertAdmitted).toHaveBeenCalledTimes(2);
    expect(dependencies.replayNonces.tryConsumeNonce).toHaveBeenCalledOnce();
    expect(acquire).toHaveBeenCalledOnce();
  });

  it("returns a policy skip before consuming the OIDC nonce or OAuth lease", async () => {
    const replayNonces = {
      tryConsumeNonce: vi.fn().mockResolvedValue(true),
    };
    const hostedReviewPreleaseGate = {
      evaluate: vi.fn().mockResolvedValue({
        status: "skipped" as const,
        reason: "max_changed_lines_exceeded" as const,
        changedLines: 346_978,
        maxChangedLines: 250_000,
        decisionHash: "a".repeat(64),
      }),
    };
    const dependencies = buildRotatingDependencies({
      replayNonces,
      hostedReviewPreleaseGate,
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
    ).resolves.toEqual({
      protocolVersion: 1,
      status: "skipped",
      reason: "max_changed_lines_exceeded",
      changedLines: 346_978,
      maxChangedLines: 250_000,
      decisionHash: "a".repeat(64),
    });
    expect(hostedReviewPreleaseGate.evaluate).toHaveBeenCalledWith({
      repository,
      sourceRunId: "9001",
      sourceRunAttempt: "1",
      intentRequired: true,
      now,
    });
    expect(replayNonces.tryConsumeNonce).not.toHaveBeenCalled();
  });

  it("rejects an unbound pull-request run before consuming capacity", async () => {
    const replayNonces = {
      tryConsumeNonce: vi.fn().mockResolvedValue(true),
    };
    const hostedReviewPreleaseGate = {
      evaluate: vi.fn().mockResolvedValue({
        status: "not_applicable" as const,
      }),
    };
    const dependencies = buildRotatingDependencies({
      replayNonces,
      hostedReviewPreleaseGate,
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
    ).rejects.toThrow("review_request_intent_required");
    expect(replayNonces.tryConsumeNonce).not.toHaveBeenCalled();
  });

  it("allows a canonical client-triggered T0 run when durable intent admission is disabled", async () => {
    const replayNonces = {
      tryConsumeNonce: vi.fn().mockResolvedValue(true),
    };
    const hostedReviewPreleaseGate = {
      evaluate: vi.fn().mockResolvedValue({
        status: "not_applicable" as const,
      }),
    };
    const binding = {
      providerInstanceId: "codex-rotating:123456",
      repositoryFullName: "777genius/agent-teams-ai",
      githubRepositoryId: "123456",
      actionRef: `777genius/review-router@${workflowSha}`,
      workflowPath: ".github/workflows/reviewrouter-codex.yml",
      workflowSchemaVersion: 2,
    } as const;
    const dependencies = buildRotatingDependencies({
      reviewIntentAdmissionRequired: false,
      replayNonces,
      hostedReviewPreleaseGate,
      codexRotatingOAuth: new InMemoryCodexRotatingOAuthRepository([binding]),
      codexRotatingWorkflowSourceVerifier: {
        verifyWorkflowSource: vi.fn().mockResolvedValue({
          binding,
          workflowSourceSha256:
            "workflow-source-sha256-012345678901234567890123456789",
        }),
      },
    });

    const result = await preleaseCodexRotatingOAuth(
      {
        oidcToken: "jwt",
        audience: "reviewrouter",
        providerInstanceId: "codex-rotating:123456",
        workflowSchemaVersion: 2,
      },
      dependencies,
    );

    expect("status" in result).toBe(false);
    expect(hostedReviewPreleaseGate.evaluate).toHaveBeenCalledWith({
      repository,
      sourceRunId: "9001",
      sourceRunAttempt: "1",
      intentRequired: false,
      now,
    });
    expect(replayNonces.tryConsumeNonce).toHaveBeenCalledOnce();
  });

  it("requires a bound intent for managed T0 workflow dispatch", async () => {
    const replayNonces = {
      tryConsumeNonce: vi.fn().mockResolvedValue(true),
    };
    const hostedReviewPreleaseGate = {
      evaluate: vi.fn().mockResolvedValue({
        status: "not_applicable" as const,
      }),
    };
    const dependencies = buildRotatingDependencies({
      oidcVerifier: {
        verify: vi.fn().mockResolvedValue({
          ...claims,
          event_name: "workflow_dispatch" as const,
          ref: "refs/heads/dev",
          job_workflow_ref: `777genius/review-router/.github/workflows/reviewrouter-execution-reusable.yml@${workflowSha}`,
          job_workflow_sha: workflowSha,
        }),
      },
      replayNonces,
      hostedReviewPreleaseGate,
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
    ).rejects.toThrow("review_request_intent_required");
    expect(hostedReviewPreleaseGate.evaluate).toHaveBeenCalledWith({
      repository,
      sourceRunId: "9001",
      sourceRunAttempt: "1",
      intentRequired: true,
      now,
    });
    expect(replayNonces.tryConsumeNonce).not.toHaveBeenCalled();
  });

  it("allows direct managed workflow dispatch to refresh OAuth without an intent", async () => {
    const replayNonces = {
      tryConsumeNonce: vi.fn().mockResolvedValue(true),
    };
    const hostedReviewPreleaseGate = {
      evaluate: vi.fn().mockResolvedValue({
        status: "not_applicable" as const,
      }),
    };
    const dependencies = buildRotatingDependencies({
      oidcVerifier: {
        verify: vi.fn().mockResolvedValue({
          ...claims,
          event_name: "workflow_dispatch" as const,
          ref: "refs/heads/dev",
        }),
      },
      replayNonces,
      hostedReviewPreleaseGate,
    });

    const result = await preleaseCodexRotatingOAuth(
      {
        oidcToken: "jwt",
        audience: "reviewrouter",
        providerInstanceId: "codex-rotating:123456",
        workflowSchemaVersion: 1,
      },
      dependencies,
    );

    expect("status" in result).toBe(false);
    expect(hostedReviewPreleaseGate.evaluate).toHaveBeenCalledWith({
      repository,
      sourceRunId: "9001",
      sourceRunAttempt: "1",
      intentRequired: false,
      now,
    });
    expect(replayNonces.tryConsumeNonce).toHaveBeenCalledOnce();
  });

  it("rejects an untrusted reusable workflow identity before consuming capacity", async () => {
    const replayNonces = {
      tryConsumeNonce: vi.fn().mockResolvedValue(true),
    };
    const hostedReviewPreleaseGate = {
      evaluate: vi.fn().mockResolvedValue({
        status: "not_applicable" as const,
      }),
    };
    const dependencies = buildRotatingDependencies({
      oidcVerifier: {
        verify: vi.fn().mockResolvedValue({
          ...claims,
          event_name: "workflow_dispatch" as const,
          ref: "refs/heads/dev",
          job_workflow_ref: `evil/review-router/.github/workflows/reviewrouter-execution-reusable.yml@${workflowSha}`,
          job_workflow_sha: workflowSha,
        }),
      },
      replayNonces,
      hostedReviewPreleaseGate,
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
    ).rejects.toThrow("codex_rotating_review_job_attestation_invalid");
    expect(hostedReviewPreleaseGate.evaluate).not.toHaveBeenCalled();
    expect(replayNonces.tryConsumeNonce).not.toHaveBeenCalled();
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

    const prelease = requireLease(
      await preleaseCodexRotatingOAuth(
        {
          oidcToken: "jwt",
          audience: "reviewrouter",
          providerInstanceId: "codex-rotating:123456",
          workflowSchemaVersion: 1,
        },
        dependencies,
      ),
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

  it("issues rotating comment tokens after auth lease expiry when posting window is fresh", async () => {
    let currentNow = now;
    const dependencies = buildRotatingDependencies({
      clock: { now: () => currentNow },
    });
    const { prelease } = await completeRotatingWriteback(dependencies);

    currentNow = new Date(now.getTime() + 20 * 60 * 1000);

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
  });

  it("reuses the active namespace across refreshes and preserves completed lease posting windows", async () => {
    const dependencies = buildRotatingDependencies();
    const ledger =
      dependencies.codexRotatingOAuth as InMemoryCodexRotatingOAuthRepository;
    const first = await completeRotatingWriteback(dependencies);
    const firstTarget = await ledger.findCompletedLeaseWriteTarget({
      leaseId: first.prelease.leaseId,
      providerInstanceId: "codex-rotating:123456",
      now,
    });
    expect(firstTarget).toMatchObject({ status: "ready" });
    if (firstTarget.status !== "ready")
      throw new Error("expected_first_target");
    expect(firstTarget.writeTarget.secretName).toMatch(
      /^REVIEWROUTER_CODEX_AUTH_JSON_R123456_P[0-9a-f]{16}_E1_[0-9a-f]{32}$/,
    );

    const second = await completeRotatingWriteback(dependencies, {
      restoredGenerationHash: "latest-generation-hash-value-0123456789",
      latestGenerationHash: "latest-generation-hash-value-second-0123456789",
      idempotencyKey: "idem:9001:second",
    });
    const secondTarget = await ledger.findCompletedLeaseWriteTarget({
      leaseId: second.prelease.leaseId,
      providerInstanceId: "codex-rotating:123456",
      now,
    });
    expect(secondTarget).toMatchObject({ status: "ready" });
    if (secondTarget.status !== "ready")
      throw new Error("expected_second_target");
    expect(secondTarget.writeTarget.secretName).toBe(
      firstTarget.writeTarget.secretName,
    );

    await expect(
      ledger.findCompletedLeaseWriteTarget({
        leaseId: first.prelease.leaseId,
        providerInstanceId: "codex-rotating:123456",
        now,
      }),
    ).resolves.toMatchObject({
      status: "ready",
      writeTarget: {
        secretName: firstTarget.writeTarget.secretName,
      },
    });
    await expect(
      ledger.authorizeReviewSnapshotAccess({
        leaseId: second.prelease.leaseId,
        providerInstanceId: "codex-rotating:123456",
        pullRequestNumber: 240,
        now,
      }),
    ).resolves.toMatchObject({ status: "ready" });
    await expect(
      ledger.authorizeReviewExecutionCheckpointAccess({
        leaseId: second.prelease.leaseId,
        providerInstanceId: "codex-rotating:123456",
        pullRequestNumber: 240,
        now,
      }),
    ).resolves.toMatchObject({ status: "ready" });
    await expect(
      issueCodexRotatingOAuthCheckoutToken(
        {
          leaseId: second.prelease.leaseId,
          providerInstanceId: "codex-rotating:123456",
        },
        dependencies,
      ),
    ).resolves.toMatchObject({ token: "ghs_contents_read_token" });
    await expect(
      issueCodexRotatingOAuthCommentToken(
        {
          leaseId: second.prelease.leaseId,
          providerInstanceId: "codex-rotating:123456",
          authCleared: true,
        },
        dependencies,
      ),
    ).resolves.toMatchObject({ token: "ghs_comment_token" });
  });

  it("expires rotating comment token refresh after the completed posting window", async () => {
    let currentNow = now;
    const dependencies = buildRotatingDependencies({
      clock: { now: () => currentNow },
    });
    const { prelease } = await completeRotatingWriteback(dependencies);

    currentNow = new Date(
      now.getTime() + codexRotatingCommentTokenRefreshTtlMs + 1,
    );

    await expect(
      issueCodexRotatingOAuthCommentToken(
        {
          leaseId: prelease.leaseId,
          providerInstanceId: "codex-rotating:123456",
          authCleared: true,
        },
        dependencies,
      ),
    ).rejects.toThrow("codex_rotating_lease_not_active");
  });

  it("keeps expired unfinished rotating leases closed for comment tokens", async () => {
    let currentNow = now;
    const dependencies = buildRotatingDependencies({
      clock: { now: () => currentNow },
    });
    const prelease = requireLease(
      await preleaseCodexRotatingOAuth(
        {
          oidcToken: "jwt",
          audience: "reviewrouter",
          providerInstanceId: "codex-rotating:123456",
          workflowSchemaVersion: 1,
        },
        dependencies,
      ),
    );

    currentNow = new Date(now.getTime() + 20 * 60 * 1000);

    await expect(
      issueCodexRotatingOAuthCommentToken(
        {
          leaseId: prelease.leaseId,
          providerInstanceId: "codex-rotating:123456",
          authCleared: true,
        },
        dependencies,
      ),
    ).rejects.toThrow("codex_rotating_lease_not_active");
  });

  it("allows only one durable intent and provider PUT per finalized lease across idempotency keys", async () => {
    const dependencies = buildRotatingDependencies();
    const prelease = requireLease(
      await preleaseCodexRotatingOAuth(
        {
          oidcToken: "jwt",
          audience: "reviewrouter",
          providerInstanceId: "codex-rotating:123456",
          workflowSchemaVersion: 1,
        },
        dependencies,
      ),
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
    const body = {
      protocolVersion: 1 as const,
      leaseId: prelease.leaseId,
      providerInstanceId: "codex-rotating:123456",
      generation: finalized.nextGeneration,
      latestGenerationHash: "latest-generation-hash-value-0123456789",
      accountIdentityHash: "account-identity-hash-value-0123456789",
      accountIdentityAlgorithm: "provider_issuer_subject_account_v1" as const,
      encryptedValue: Buffer.from("ciphertext").toString("base64"),
      keyId: "github-key",
      idempotencyKey: "idem:dropped-after-claim",
    };
    const digest = computeEncryptedPayloadDigest({
      encryptedValue: body.encryptedValue,
      hmacKey: dependencies.codexRotatingWritebackHmacKey,
    });

    const ledger =
      dependencies.codexRotatingOAuth as InMemoryCodexRotatingOAuthRepository;
    const prepare = (request = body) =>
      ledger.prepareVersionedWriteback({
        request,
        encryptedPayloadDigest: digest,
        now,
      });
    const inMemoryRace = await Promise.all([
      prepare(),
      prepare({ ...body, idempotencyKey: "idem:different-key-same-lease" }),
    ]);
    expect(inMemoryRace.map((result) => result.status).sort()).toEqual([
      "ready",
      "writeback_idempotency_conflict",
    ]);

    await expect(
      writebackCodexRotatingOAuth({ body }, dependencies),
    ).resolves.toEqual({
      protocolVersion: 1,
      status: "in_progress",
    });
    expect(
      dependencies.codexRotatingSecretWriter.putEncryptedRepositorySecret,
    ).not.toHaveBeenCalled();

    await expect(
      writebackCodexRotatingOAuth(
        {
          body: {
            ...body,
            encryptedValue: Buffer.from("different-ciphertext").toString(
              "base64",
            ),
          },
        },
        dependencies,
      ),
    ).resolves.toEqual({
      protocolVersion: 1,
      status: "writeback_idempotency_conflict",
    });
    expect(
      dependencies.codexRotatingSecretWriter.putEncryptedRepositorySecret,
    ).not.toHaveBeenCalled();
  });

  it.each(["dispatch-authorized", "provider-confirmed"] as const)(
    "retires a %s writeback replayed with randomized ciphertext without a provider PUT",
    async (restartState) => {
      const dependencies = buildRotatingDependencies();
      const prelease = requireLease(
        await preleaseCodexRotatingOAuth(
          {
            oidcToken: "jwt",
            audience: "reviewrouter",
            providerInstanceId: "codex-rotating:123456",
            workflowSchemaVersion: 1,
          },
          dependencies,
        ),
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
      const body = {
        protocolVersion: 1 as const,
        leaseId: prelease.leaseId,
        providerInstanceId: "codex-rotating:123456",
        generation: finalized.nextGeneration,
        latestGenerationHash: "latest-generation-hash-value-0123456789",
        accountIdentityHash: "account-identity-hash-value-0123456789",
        accountIdentityAlgorithm: "provider_issuer_subject_account_v1" as const,
        encryptedValue: Buffer.from("first-randomized-ciphertext").toString(
          "base64",
        ),
        keyId: "github-key",
        idempotencyKey: "idem:randomized-restart",
      };
      const ledger =
        dependencies.codexRotatingOAuth as InMemoryCodexRotatingOAuthRepository;
      const authorized = await ledger.prepareVersionedWriteback({
        request: body,
        encryptedPayloadDigest: computeEncryptedPayloadDigest({
          encryptedValue: body.encryptedValue,
          hmacKey: dependencies.codexRotatingWritebackHmacKey,
        }),
        now,
      });
      if (authorized.status !== "ready") {
        throw new Error("expected versioned writeback authorization");
      }
      if (restartState === "provider-confirmed") {
        await ledger.confirmVersionedProviderWrite({
          intentId: authorized.intentId,
          attemptId: authorized.attemptId,
          executorOwner: authorized.executorOwner,
          statusCode: 204,
          now,
        });
      }

      await expect(
        writebackCodexRotatingOAuth(
          {
            body: {
              ...body,
              encryptedValue: Buffer.from(
                "second-randomized-ciphertext",
              ).toString("base64"),
            },
          },
          dependencies,
        ),
      ).resolves.toEqual({
        protocolVersion: 1,
        status: "writeback_idempotency_conflict",
      });
      expect(
        dependencies.codexRotatingSecretWriter.putEncryptedRepositorySecret,
      ).not.toHaveBeenCalled();
      await expect(
        preleaseCodexRotatingOAuth(
          {
            oidcToken: "jwt-after-randomized-restart",
            audience: "reviewrouter",
            providerInstanceId: "codex-rotating:123456",
            workflowSchemaVersion: 1,
          },
          dependencies,
        ),
      ).rejects.toThrow("codex_rotating_mutation_fence_conflict");
    },
  );

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

    const prelease = requireLease(
      await preleaseCodexRotatingOAuth(
        {
          oidcToken: "jwt",
          audience: "reviewrouter",
          providerInstanceId: "codex-rotating:123456",
          workflowSchemaVersion: 1,
        },
        dependencies,
      ),
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
            accountIdentityHash: "account-identity-hash-value-0123456789",
            accountIdentityAlgorithm: "provider_issuer_subject_account_v1",
            encryptedValue: Buffer.from("ciphertext").toString("base64"),
            keyId: "github-key",
            idempotencyKey: "idem:failed-writeback",
          },
        },
        dependencies,
      ),
    ).resolves.toEqual({
      protocolVersion: 1,
      status: "writeback_recovery_required",
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
            accountIdentityHash: "account-identity-hash-value-0123456789",
            accountIdentityAlgorithm: "provider_issuer_subject_account_v1",
            encryptedValue: Buffer.from("ciphertext").toString("base64"),
            keyId: "github-key",
            idempotencyKey: "idem:failed-writeback",
          },
        },
        dependencies,
      ),
    ).resolves.toEqual({
      protocolVersion: 1,
      status: "writeback_recovery_required",
    });
    expect(
      dependencies.codexRotatingSecretWriter.putEncryptedRepositorySecret,
    ).toHaveBeenCalledOnce();

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

  it("rejects a caller-controlled provider id before verification or persistence", async () => {
    const dependencies = buildRotatingDependencies();
    const ensure = vi.spyOn(
      dependencies.codexRotatingOAuth,
      "ensureVerifiedProviderBinding",
    );
    const acquire = vi.spyOn(
      dependencies.codexRotatingOAuth,
      "acquirePrelease",
    );

    await expect(
      preleaseCodexRotatingOAuth(
        {
          oidcToken: "forged-jwt",
          audience: "reviewrouter",
          providerInstanceId: "codex-rotating:999999",
          workflowSchemaVersion: 1,
        },
        dependencies,
      ),
    ).rejects.toThrow("codex_rotating_provider_identity_mismatch");

    expect(ensure).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
    expect(dependencies.replayNonces.tryConsumeNonce).not.toHaveBeenCalled();
    expect(
      dependencies.codexRotatingWorkflowSourceVerifier.verifyWorkflowSource,
    ).not.toHaveBeenCalled();
  });

  it("fails closed when a newer owner replaces the post-PUT epoch", async () => {
    const dependencies = buildRotatingDependencies();
    const prelease = requireLease(
      await preleaseCodexRotatingOAuth(
        {
          oidcToken: "jwt",
          audience: "reviewrouter",
          providerInstanceId: "codex-rotating:123456",
          workflowSchemaVersion: 1,
        },
        dependencies,
      ),
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
    vi.mocked(
      dependencies.codexRotatingSecretWriter.putEncryptedRepositorySecret,
    ).mockImplementation(async () => {
      await dependencies.codexRotatingOAuth.abandonLease({
        leaseId: prelease.leaseId,
        providerInstanceId: "codex-rotating:123456",
        reason: "unknown_auth_state",
      });
      return { status: "accepted", statusCode: 204 };
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
            accountIdentityHash: "account-identity-hash-value-0123456789",
            accountIdentityAlgorithm: "provider_issuer_subject_account_v1",
            encryptedValue: Buffer.from("ciphertext").toString("base64"),
            keyId: "github-key",
            idempotencyKey: "idem:stale-post-put",
          },
        },
        dependencies,
      ),
    ).rejects.toThrow("codex_rotating_versioned_retirement_fence_conflict");
    expect(
      dependencies.codexRotatingSecretWriter.putEncryptedRepositorySecret,
    ).toHaveBeenCalledOnce();

    await expect(
      writebackCodexRotatingOAuth(
        {
          body: {
            protocolVersion: 1,
            leaseId: prelease.leaseId,
            providerInstanceId: "codex-rotating:123456",
            generation: finalized.nextGeneration,
            latestGenerationHash: "latest-generation-hash-value-0123456789",
            accountIdentityHash: "account-identity-hash-value-0123456789",
            accountIdentityAlgorithm: "provider_issuer_subject_account_v1",
            encryptedValue: Buffer.from("ciphertext").toString("base64"),
            keyId: "github-key",
            idempotencyKey: "idem:stale-post-put",
          },
        },
        dependencies,
      ),
    ).resolves.toEqual({
      protocolVersion: 1,
      status: "in_progress",
    });
    expect(
      dependencies.codexRotatingSecretWriter.putEncryptedRepositorySecret,
    ).toHaveBeenCalledOnce();
  });

  it("persists the canonical binding only after workflow verification", async () => {
    const dependencies = buildRotatingDependencies();
    const ensure = vi.spyOn(
      dependencies.codexRotatingOAuth,
      "ensureVerifiedProviderBinding",
    );

    await preleaseCodexRotatingOAuth(
      {
        oidcToken: "jwt",
        audience: "reviewrouter",
        providerInstanceId: "codex-rotating:123456",
        workflowSchemaVersion: 1,
      },
      dependencies,
    );

    const verify = dependencies.codexRotatingWorkflowSourceVerifier
      .verifyWorkflowSource as ReturnType<typeof vi.fn>;
    expect(verify.mock.invocationCallOrder[0]).toBeLessThan(
      ensure.mock.invocationCallOrder[0]!,
    );
    expect(ensure).toHaveBeenCalledWith({
      repository,
      binding: expect.objectContaining({
        providerInstanceId: "codex-rotating:123456",
        githubRepositoryId: "123456",
      }),
    });
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
    new InMemoryCodexRotatingOAuthRepository(
      [
        {
          providerInstanceId: "codex-rotating:123456",
          repositoryFullName: "777genius/agent-teams-ai",
          githubRepositoryId: "123456",
          actionRef: `777genius/review-router@${workflowSha}`,
          workflowPath: ".github/workflows/reviewrouter-codex.yml",
          workflowSchemaVersion: 1,
        },
      ],
      { clock: { now: () => now } },
    );
  const codexRotatingSecretWriter = overrides.codexRotatingSecretWriter ?? {
    assertCanWriteRepositorySecret: vi
      .fn()
      .mockResolvedValue({ status: "ready" as const }),
    putEncryptedRepositorySecret: vi.fn().mockResolvedValue({
      status: "accepted" as const,
      statusCode: 204 as const,
    }),
  };
  const codexRotatingVersionedWriteback =
    overrides.codexRotatingVersionedWriteback ??
    (codexRotatingOAuth instanceof InMemoryCodexRotatingOAuthRepository
      ? new CodexRotatingVersionedWritebackDispatcher(
          codexRotatingOAuth,
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
                workflowSchemaVersion: 5,
                sourceTrust: WorkflowSourceTrust.TrustedDefaultBranchRevision,
                secretNamespace: namespace,
              }),
            ),
          },
          { now: () => now },
        )
      : {
          dispatchOneShot: vi.fn(async ({ request }) => ({
            status: "accepted" as const,
            generation: request.generation,
          })),
        });

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
    codexRotatingNewWorkAdmission:
      overrides.codexRotatingNewWorkAdmission ??
      ({
        assertAdmitted: () => undefined,
      } satisfies RotatingDependencies["codexRotatingNewWorkAdmission"]),
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
        repository: "777genius/agent-teams-ai",
        permissions: {
          contents: "read",
          pullRequests: "write",
          issues: "write",
          statuses: "write",
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

const allowNewWorkAdmission = {
  assertAdmitted: () => undefined,
};

async function completeRotatingWriteback(
  dependencies: RotatingDependencies,
  options: Readonly<{
    restoredGenerationHash?: string;
    latestGenerationHash?: string;
    idempotencyKey?: string;
  }> = {},
) {
  const prelease = requireLease(
    await preleaseCodexRotatingOAuth(
      {
        oidcToken: "jwt",
        audience: "reviewrouter",
        providerInstanceId: "codex-rotating:123456",
        workflowSchemaVersion: 1,
      },
      dependencies,
    ),
  );
  const finalized = await finalizeCodexRotatingOAuthLease(
    {
      leaseId: prelease.leaseId,
      providerInstanceId: "codex-rotating:123456",
      restoredGenerationHash:
        options.restoredGenerationHash ?? "restored-generation-hash-value",
    },
    dependencies,
  );
  if (finalized.status !== "finalized") {
    throw new Error("expected_finalized");
  }
  await preflightCodexRotatingOAuthWriteback(
    {
      leaseId: prelease.leaseId,
      providerInstanceId: "codex-rotating:123456",
      githubKeyId: "github-key",
    },
    dependencies,
  );
  await writebackCodexRotatingOAuth(
    {
      body: {
        protocolVersion: 1,
        leaseId: prelease.leaseId,
        providerInstanceId: "codex-rotating:123456",
        generation: finalized.nextGeneration,
        latestGenerationHash:
          options.latestGenerationHash ??
          "latest-generation-hash-value-0123456789",
        accountIdentityHash: "account-identity-hash-value-0123456789",
        accountIdentityAlgorithm: "provider_issuer_subject_account_v1",
        encryptedValue: Buffer.from("ciphertext").toString("base64"),
        keyId: "github-key",
        idempotencyKey: options.idempotencyKey ?? "idem:9001:1",
      },
    },
    dependencies,
  );
  return { prelease, finalized };
}

function requireLease(
  response: Awaited<ReturnType<typeof preleaseCodexRotatingOAuth>>,
) {
  if ("status" in response) {
    throw new Error("expected_codex_rotating_prelease_lease");
  }
  return response;
}
