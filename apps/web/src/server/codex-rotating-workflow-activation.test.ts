import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  activate: vi.fn(),
  assertTrusted: vi.fn(),
  createAttestation: vi.fn(),
  createNamespace: vi.fn(),
  inspectNamespace: vi.fn(),
  readMetadata: vi.fn(),
  semanticSha: vi.fn(),
  v5Allowed: vi.fn(),
}));

vi.mock("@reviewrouter/features-provider-setup", () => ({
  canonicalCodexRotatingProviderId: (repositoryId: string) =>
    `codex-rotating:${repositoryId}`,
  codexRotatingAuthMode: "codex_oauth_rotating",
  inspectCodexRotatingWorkflowNamespace: mocks.inspectNamespace,
}));
vi.mock("@reviewrouter/features-workflow-provisioning", () => ({
  assertTrustedCanonicalVersionedWorkflow: mocks.assertTrusted,
  createVersionedProviderSecretNamespace: mocks.createNamespace,
  createVersionedSecretWorkflowSourceAttestation: mocks.createAttestation,
  defaultCodexRotatingWorkflowPath: ".github/workflows/reviewrouter-codex.yml",
  readCanonicalCodexRotatingT0WorkflowSourceMetadata: mocks.readMetadata,
  workflowDocumentSemanticSha256: mocks.semanticSha,
  WorkflowSourceTrust: {
    TrustedDefaultBranchRevision: "trusted_default_branch_revision",
  },
  CodexRotatingT0WorkflowSchemaVersion: {
    VersionedSecretNamespaceV4: 4,
    CertifiedForkReviewV5: 5,
  },
}));
vi.mock("@reviewrouter/platform-config", () => ({
  isCodexForkReviewV5AllowedForRepository: mocks.v5Allowed,
  requireReviewRouterDatabaseRecoveryWitness: () => ({ generation: "test" }),
  resolveReviewRouterCodexRotatingTrustedActionRefs: () => [
    "777genius/review-router@action-sha",
  ],
}));
vi.mock("./codex-rotating-setup-ledger", () => ({
  codexRotatingSetupLedger: { activate: mocks.activate },
}));
vi.mock("./prisma-codex-rotating-workflow-namespace", () => ({
  PrismaCodexRotatingWorkflowNamespace: class {},
}));

import { activateConfirmedCodexNamespaceAfterWorkflowMerge } from "./codex-rotating-workflow-activation";

const source = "name: canonical workflow\n";
const blobSha = gitBlobSha(source);
const firstHead = "a".repeat(40);

describe("activateConfirmedCodexNamespaceAfterWorkflowMerge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.inspectNamespace.mockResolvedValue({
      source: "confirmed_setup_candidate",
      claimId: "claim_1",
      attemptId: "attempt_1",
      namespace: {
        namespaceId: "namespace_2",
        epoch: 2n,
        name: "REVIEWROUTER_CODEX_AUTH_JSON_TEST_E2",
      },
    });
    mocks.v5Allowed.mockReturnValue(false);
    mocks.createNamespace.mockImplementation((input) => ({
      mode: "versioned_never_reused",
      ...input,
    }));
    mocks.readMetadata.mockReturnValue({
      actionRef: "action-sha",
      workflowSchemaVersion: 4,
    });
    mocks.semanticSha.mockReturnValue("b".repeat(64));
    mocks.createAttestation.mockReturnValue({
      repositoryId: "1228051727",
      workflowPath: ".github/workflows/reviewrouter-codex.yml",
      workflowSourceCommitSha: firstHead,
      workflowSourceBlobSha: blobSha,
      workflowSourceSha256: "c".repeat(64),
      workflowSemanticSha256: "b".repeat(64),
      sourceTrust: "trusted_default_branch_revision",
    });
  });

  it("attests the exact default-branch blob and activates the candidate", async () => {
    const { input, request } = fixture();

    await expect(
      activateConfirmedCodexNamespaceAfterWorkflowMerge(input),
    ).resolves.toEqual({
      status: "activated",
      namespaceEpoch: "2",
      workflowSourceCommitSha: firstHead,
    });
    expect(request).toHaveBeenNthCalledWith(
      2,
      "GET /repos/{owner}/{repo}/git/ref/{ref}",
      expect.objectContaining({ ref: "heads/main" }),
    );
    expect(request).toHaveBeenNthCalledWith(
      4,
      "GET /repos/{owner}/{repo}/git/ref/{ref}",
      expect.objectContaining({ ref: "heads/main" }),
    );
    expect(mocks.assertTrusted).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedRepositoryId: "1228051727",
        expectedApiUrl: "https://api.reviewrouter.test",
        expectedWorkflowSchemaVersion: 4,
      }),
    );
    expect(mocks.activate).toHaveBeenCalledWith(
      expect.objectContaining({
        claimId: "claim_1",
        attemptId: "attempt_1",
        namespaceEpoch: "2",
        workflowSourceCommitSha: firstHead,
      }),
    );
  });

  it("does not write the ledger again for an already-active namespace", async () => {
    mocks.inspectNamespace.mockResolvedValueOnce({
      source: "active",
      namespace: {
        namespaceId: "namespace_2",
        epoch: 2n,
        name: "REVIEWROUTER_CODEX_AUTH_JSON_TEST_E2",
      },
    });
    const { input } = fixture();

    await expect(
      activateConfirmedCodexNamespaceAfterWorkflowMerge(input),
    ).resolves.toEqual({
      status: "already_active",
      namespaceEpoch: "2",
      workflowSourceCommitSha: firstHead,
    });
    expect(mocks.activate).not.toHaveBeenCalled();
    expect(mocks.assertTrusted).toHaveBeenCalledWith(
      expect.not.objectContaining({ expectedWorkflowSchemaVersion: 4 }),
    );
  });

  it("requires the V5 cohort to still be enabled before candidate activation", async () => {
    mocks.readMetadata.mockReturnValueOnce({
      actionRef: "action-sha",
      workflowSchemaVersion: 5,
    });
    mocks.assertTrusted.mockImplementationOnce((input) => {
      if (
        input.expectedWorkflowSchemaVersion !==
        input.metadata.workflowSchemaVersion
      ) {
        throw new Error("codex_rotating_workflow_schema_mismatch");
      }
    });
    const { input } = fixture();

    await expect(
      activateConfirmedCodexNamespaceAfterWorkflowMerge(input),
    ).rejects.toThrow("codex_rotating_workflow_schema_mismatch");
    expect(mocks.activate).not.toHaveBeenCalled();

    vi.clearAllMocks();
    mocks.inspectNamespace.mockResolvedValue({
      source: "confirmed_setup_candidate",
      claimId: "claim_1",
      attemptId: "attempt_1",
      namespace: {
        namespaceId: "namespace_2",
        epoch: 2n,
        name: "REVIEWROUTER_CODEX_AUTH_JSON_TEST_E2",
      },
    });
    mocks.v5Allowed.mockReturnValue(true);
    mocks.readMetadata.mockReturnValue({
      actionRef: "action-sha",
      workflowSchemaVersion: 5,
    });
    mocks.semanticSha.mockReturnValue("b".repeat(64));
    mocks.createAttestation.mockReturnValue({
      repositoryId: "1228051727",
      workflowPath: ".github/workflows/reviewrouter-codex.yml",
      workflowSourceCommitSha: firstHead,
      workflowSourceBlobSha: blobSha,
      workflowSourceSha256: "c".repeat(64),
      workflowSemanticSha256: "b".repeat(64),
      sourceTrust: "trusted_default_branch_revision",
    });
    const enabled = fixture();
    await expect(
      activateConfirmedCodexNamespaceAfterWorkflowMerge(enabled.input),
    ).resolves.toMatchObject({ status: "activated" });
    expect(mocks.assertTrusted).toHaveBeenCalledWith(
      expect.objectContaining({ expectedWorkflowSchemaVersion: 5 }),
    );
  });

  it("fails closed when the default branch changes during attestation", async () => {
    const { input, request } = fixture();
    request
      .mockReset()
      .mockResolvedValueOnce(repositoryResponse())
      .mockResolvedValueOnce(refResponse(firstHead))
      .mockResolvedValueOnce(contentResponse())
      .mockResolvedValueOnce(refResponse("d".repeat(40)));

    await expect(
      activateConfirmedCodexNamespaceAfterWorkflowMerge(input),
    ).rejects.toThrow("codex_rotating_workflow_default_head_changed");
    expect(mocks.activate).not.toHaveBeenCalled();
  });

  it("fails closed when GitHub reports a different default branch", async () => {
    const { input, request } = fixture();
    request.mockReset().mockResolvedValueOnce({
      data: {
        id: 1228051727,
        full_name: "777genius/review-router-saas-e2e",
        default_branch: "trunk",
      },
    });

    await expect(
      activateConfirmedCodexNamespaceAfterWorkflowMerge(input),
    ).rejects.toThrow("codex_rotating_workflow_default_branch_mismatch");
    expect(mocks.activate).not.toHaveBeenCalled();
  });

  it("fails closed when decoded content does not match its blob SHA", async () => {
    const { input, request } = fixture();
    request
      .mockReset()
      .mockResolvedValueOnce(repositoryResponse())
      .mockResolvedValueOnce(refResponse(firstHead))
      .mockResolvedValueOnce({
        data: {
          ...contentResponse().data,
          sha: "e".repeat(40),
        },
      });

    await expect(
      activateConfirmedCodexNamespaceAfterWorkflowMerge(input),
    ).rejects.toThrow("codex_rotating_workflow_blob_sha_mismatch");
    expect(mocks.activate).not.toHaveBeenCalled();
  });

  it("does not call GitHub when rotating auth is not configured", async () => {
    const { input, request, findUnique } = fixture();
    findUnique.mockResolvedValueOnce(null);

    await expect(
      activateConfirmedCodexNamespaceAfterWorkflowMerge(input),
    ).resolves.toEqual({ status: "not_configured" });
    expect(request).not.toHaveBeenCalled();
    expect(mocks.inspectNamespace).not.toHaveBeenCalled();
  });

  it("activates a zero-login rollover only after the exact setup PR is merged at the requested default head", async () => {
    const operationId = "campaign-1:repo-1";
    const targetActionRef = `777genius/review-router@${"d".repeat(40)}`;
    const rolloverRecord = {
      operationId,
      repositoryFullName: "777genius/review-router-saas-e2e",
      providerInstanceId: "codex-rotating:1228051727",
      state: "setup_pr_open" as const,
      targetActionRef,
      candidateNamespaceId: "namespace_8",
      candidateNamespaceEpoch: 8n,
      candidateNamespaceName:
        "REVIEWROUTER_CODEX_AUTH_JSON_R1228051727_P1234567890abcdef_E8_1234567890abcdef1234567890abcdef",
      setupPullRequestNumber: 17,
      setupPullRequestHeadSha: "e".repeat(40),
      setupPullRequestBaseBranch: "main",
    };
    const activateAfterAttestation = vi.fn(async () => ({
      ...rolloverRecord,
      state: "activated" as const,
    }));
    const status = vi.fn(async () => rolloverRecord);
    mocks.v5Allowed.mockReturnValueOnce(true);
    mocks.readMetadata.mockReturnValueOnce({
      actionRef: targetActionRef,
      workflowSchemaVersion: 5,
    });
    const { input, request } = fixture();
    request
      .mockReset()
      .mockResolvedValueOnce(repositoryResponse())
      .mockResolvedValueOnce({
        data: {
          merged: true,
          merged_at: "2026-08-30T12:00:00.000Z",
          head: { sha: "e".repeat(40) },
          base: { ref: "main", repo: { id: 1228051727 } },
        },
      })
      .mockResolvedValueOnce(refResponse(firstHead))
      .mockResolvedValueOnce(contentResponse())
      .mockResolvedValueOnce(refResponse(firstHead));

    await expect(
      activateConfirmedCodexNamespaceAfterWorkflowMerge({
        ...input,
        zeroLoginRollover: {
          operationId,
          expectedNamespaceEpoch: 8n,
          expectedDefaultHeadSha: firstHead,
          ledger: { status, activateAfterAttestation },
        },
      }),
    ).resolves.toEqual({
      status: "activated",
      namespaceEpoch: "8",
      workflowSourceCommitSha: firstHead,
    });
    expect(request).toHaveBeenNthCalledWith(
      2,
      "GET /repos/{owner}/{repo}/pulls/{pull_number}",
      expect.objectContaining({ pull_number: 17 }),
    );
    expect(mocks.assertTrusted).toHaveBeenCalledWith(
      expect.objectContaining({
        trustedActionRefs: [targetActionRef],
        expectedWorkflowSchemaVersion: 5,
      }),
    );
    expect(activateAfterAttestation).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId,
        expectedNamespaceEpoch: 8n,
      }),
    );
  });

  it("does not activate a rollover when the merged PR head differs from durable evidence", async () => {
    const activateAfterAttestation = vi.fn();
    const { input, request } = fixture();
    request
      .mockReset()
      .mockResolvedValueOnce(repositoryResponse())
      .mockResolvedValueOnce({
        data: {
          merged: true,
          merged_at: "2026-08-30T12:00:00.000Z",
          head: { sha: "f".repeat(40) },
          base: { ref: "main", repo: { id: 1228051727 } },
        },
      });

    await expect(
      activateConfirmedCodexNamespaceAfterWorkflowMerge({
        ...input,
        zeroLoginRollover: {
          operationId: "campaign-1:repo-1",
          expectedNamespaceEpoch: 8n,
          expectedDefaultHeadSha: firstHead,
          ledger: {
            status: async () => ({
              operationId: "campaign-1:repo-1",
              repositoryFullName: "777genius/review-router-saas-e2e",
              providerInstanceId: "codex-rotating:1228051727",
              state: "setup_pr_open",
              targetActionRef: `777genius/review-router@${"d".repeat(40)}`,
              candidateNamespaceId: "namespace_8",
              candidateNamespaceEpoch: 8n,
              candidateNamespaceName:
                "REVIEWROUTER_CODEX_AUTH_JSON_R1228051727_P1234567890abcdef_E8_1234567890abcdef1234567890abcdef",
              setupPullRequestNumber: 17,
              setupPullRequestHeadSha: "e".repeat(40),
              setupPullRequestBaseBranch: "main",
            }),
            activateAfterAttestation,
          },
        },
      }),
    ).rejects.toThrow("zero_login_rollover_setup_pr_not_exactly_merged");
    expect(activateAfterAttestation).not.toHaveBeenCalled();
  });
});

function fixture() {
  const findUnique = vi.fn().mockResolvedValue({ id: "provider_1" });
  const request = vi
    .fn()
    .mockResolvedValueOnce(repositoryResponse())
    .mockResolvedValueOnce(refResponse(firstHead))
    .mockResolvedValueOnce(contentResponse())
    .mockResolvedValueOnce(refResponse(firstHead));
  return {
    findUnique,
    request,
    input: {
      prisma: {
        codexOAuthProviderInstance: { findUnique },
      } as never,
      octokit: { request },
      workspaceId: "workspace_1",
      repositoryId: "repo_1",
      githubRepositoryId: "1228051727",
      owner: "777genius",
      name: "review-router-saas-e2e",
      defaultBranch: "main",
      expectedRepositoryFullName: "777genius/review-router-saas-e2e",
      expectedApiUrl: "https://api.reviewrouter.test",
    },
  };
}

function repositoryResponse() {
  return {
    data: {
      id: 1228051727,
      full_name: "777genius/review-router-saas-e2e",
      default_branch: "main",
    },
  };
}

function refResponse(sha: string) {
  return { data: { object: { sha } } };
}

function contentResponse() {
  return {
    data: {
      type: "file",
      encoding: "base64",
      content: Buffer.from(source, "utf8").toString("base64"),
      sha: blobSha,
    },
  };
}

function gitBlobSha(value: string): string {
  return createHash("sha1")
    .update(`blob ${Buffer.byteLength(value, "utf8")}\0`, "utf8")
    .update(value, "utf8")
    .digest("hex");
}
