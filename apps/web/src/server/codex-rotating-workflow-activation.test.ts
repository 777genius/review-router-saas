import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  activate: vi.fn(),
  assertTrusted: vi.fn(),
  createAttestation: vi.fn(),
  inspectNamespace: vi.fn(),
  preferredSetupBaseBranches: vi.fn(),
  readMetadata: vi.fn(),
  semanticSha: vi.fn(),
}));

vi.mock("@reviewrouter/features-provider-setup", () => ({
  canonicalCodexRotatingProviderId: (repositoryId: string) =>
    `codex-rotating:${repositoryId}`,
  codexRotatingAuthMode: "codex_oauth_rotating",
  inspectCodexRotatingWorkflowNamespace: mocks.inspectNamespace,
}));
vi.mock("@reviewrouter/features-workflow-provisioning", () => ({
  assertTrustedCanonicalVersionedWorkflow: mocks.assertTrusted,
  createVersionedSecretWorkflowSourceAttestation: mocks.createAttestation,
  defaultCodexRotatingWorkflowPath: ".github/workflows/reviewrouter-codex.yml",
  preferredSetupBaseBranches: mocks.preferredSetupBaseBranches,
  readCanonicalCodexRotatingT0WorkflowSourceMetadata: mocks.readMetadata,
  workflowDocumentSemanticSha256: mocks.semanticSha,
  WorkflowSourceTrust: {
    TrustedDefaultBranchRevision: "trusted_default_branch_revision",
  },
}));
vi.mock("@reviewrouter/platform-config", () => ({
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
    mocks.preferredSetupBaseBranches.mockImplementation(
      (defaultBranch: string) => [defaultBranch],
    );
    mocks.readMetadata.mockReturnValue({ actionRef: "action-sha" });
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

  it("attests the preferred integration branch when it differs from the GitHub default", async () => {
    mocks.preferredSetupBaseBranches.mockReturnValueOnce(["dev", "main"]);
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
      expect.objectContaining({ ref: "heads/dev" }),
    );
    expect(request).toHaveBeenNthCalledWith(
      4,
      "GET /repos/{owner}/{repo}/git/ref/{ref}",
      expect.objectContaining({ ref: "heads/dev" }),
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
