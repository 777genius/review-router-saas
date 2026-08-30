import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexRotatingDefaultWorkflowSourcePort } from "@reviewrouter/features-provider-setup";

const mocks = vi.hoisted(() => ({
  activate: vi.fn(),
  assertTrusted: vi.fn(),
  createAttestation: vi.fn(),
  inspectNamespace: vi.fn(),
  readMetadata: vi.fn(),
  replaceActiveWorkflowSource: vi.fn(),
  semanticSha: vi.fn(),
}));

vi.mock("@reviewrouter/features-provider-setup", () => ({
  canonicalCodexRotatingProviderId: (repositoryId: string) =>
    `codex-rotating:${repositoryId}`,
  codexRotatingAuthMode: "codex_oauth_rotating",
  inspectCodexRotatingWorkflowNamespace: mocks.inspectNamespace,
}));
vi.mock("@reviewrouter/features-workflow-provisioning", () => ({
  CodexRotatingT0WorkflowSchemaVersion: {
    VersionedSecretNamespaceV4: 4,
    VersionedSecretNamespaceV5: 5,
  },
  assertTrustedCanonicalVersionedWorkflow: mocks.assertTrusted,
  createVersionedSecretWorkflowSourceAttestation: mocks.createAttestation,
  defaultCodexRotatingWorkflowPath: ".github/workflows/reviewrouter-codex.yml",
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
  codexRotatingSetupLedger: {
    activate: mocks.activate,
    replaceActiveWorkflowSource: mocks.replaceActiveWorkflowSource,
  },
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
    mocks.replaceActiveWorkflowSource.mockResolvedValue({
      status: "already_active",
      workflowSourceCommitSha: firstHead,
    });
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
    mocks.readMetadata.mockReturnValue({ actionRef: "action-sha" });
    mocks.semanticSha.mockReturnValue("b".repeat(64));
    mocks.createAttestation.mockReturnValue({
      repositoryId: "1228051727",
      workflowPath: ".github/workflows/reviewrouter-codex.yml",
      workflowSourceCommitSha: firstHead,
      workflowSourceBlobSha: blobSha,
      workflowSourceSha256: "c".repeat(64),
      workflowSemanticSha256: "b".repeat(64),
      workflowSchemaVersion: 5,
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
      5,
      "GET /repos/{owner}/{repo}/git/ref/{ref}",
      expect.objectContaining({ ref: "heads/main" }),
    );
    expect(mocks.assertTrusted).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedRepositoryId: "1228051727",
        expectedApiUrl: "https://api.reviewrouter.test",
        expectedWorkflowSchemaVersion: 5,
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

  it("rejects an independently observed workflow schema mismatch", async () => {
    const { input } = fixture();
    mocks.readMetadata.mockReturnValueOnce({
      actionRef: "action-sha",
      workflowSchemaVersion: 4,
    });
    mocks.assertTrusted.mockImplementationOnce(
      ({
        metadata,
        expectedWorkflowSchemaVersion,
      }: {
        metadata: { workflowSchemaVersion: number };
        expectedWorkflowSchemaVersion: number;
      }) => {
        if (metadata.workflowSchemaVersion !== expectedWorkflowSchemaVersion) {
          throw new Error("codex_rotating_workflow_schema_version_mismatch");
        }
      },
    );

    await expect(
      activateConfirmedCodexNamespaceAfterWorkflowMerge(input),
    ).rejects.toThrow("codex_rotating_workflow_schema_version_mismatch");
    expect(mocks.assertTrusted).toHaveBeenCalledWith(
      expect.objectContaining({ expectedWorkflowSchemaVersion: 5 }),
    );
    expect(mocks.activate).not.toHaveBeenCalled();
    expect(mocks.replaceActiveWorkflowSource).not.toHaveBeenCalled();
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
    expect(mocks.replaceActiveWorkflowSource).toHaveBeenCalledOnce();
  });

  it("is idempotent after an unrelated commit when trusted workflow bytes are unchanged", async () => {
    const unrelatedHead = "d".repeat(40);
    mocks.inspectNamespace.mockResolvedValueOnce({
      source: "active",
      namespace: {
        namespaceId: "namespace_2",
        epoch: 2n,
        name: "REVIEWROUTER_CODEX_AUTH_JSON_TEST_E2",
      },
    });
    mocks.createAttestation.mockReturnValueOnce({
      repositoryId: "1228051727",
      workflowPath: ".github/workflows/reviewrouter-codex.yml",
      workflowSourceCommitSha: unrelatedHead,
      workflowSourceBlobSha: blobSha,
      workflowSourceSha256: "c".repeat(64),
      workflowSemanticSha256: "b".repeat(64),
      workflowSchemaVersion: 5,
      sourceTrust: "trusted_default_branch_revision",
    });
    mocks.replaceActiveWorkflowSource.mockResolvedValueOnce({
      status: "already_active",
      workflowSourceCommitSha: unrelatedHead,
    });
    const { input, request } = fixture();
    request
      .mockReset()
      .mockResolvedValueOnce(repositoryResponse())
      .mockResolvedValueOnce(refResponse(unrelatedHead))
      .mockResolvedValueOnce(contentResponse())
      .mockResolvedValueOnce(repositoryResponse())
      .mockResolvedValueOnce(refResponse(unrelatedHead));

    await expect(
      activateConfirmedCodexNamespaceAfterWorkflowMerge(input),
    ).resolves.toEqual({
      status: "already_active",
      namespaceEpoch: "2",
      workflowSourceCommitSha: unrelatedHead,
    });
    expect(mocks.replaceActiveWorkflowSource).toHaveBeenCalledOnce();
  });

  it("fails closed when the active repository binding changed", async () => {
    mocks.inspectNamespace.mockResolvedValueOnce({
      source: "active",
      namespace: {
        namespaceId: "namespace_2",
        epoch: 2n,
        name: "REVIEWROUTER_CODEX_AUTH_JSON_TEST_E2",
      },
    });
    const { input, findAttestation } = fixture();
    mocks.replaceActiveWorkflowSource.mockRejectedValueOnce(
      new Error("codex_rotating_workflow_source_attestation_missing"),
    );
    findAttestation.mockResolvedValueOnce({
      workflowPath: ".github/workflows/reviewrouter-codex.yml",
      workflowSourceCommitSha: firstHead,
      workflowSourceBlobSha: blobSha,
      workflowSourceSha256: "c".repeat(64),
      workflowSemanticSha256: "b".repeat(64),
      workflowSourceTrust: "trusted_default_branch_revision",
      workflowSchemaVersion: 5,
      attestedRepositoryId: "999999999",
    });

    await expect(
      activateConfirmedCodexNamespaceAfterWorkflowMerge(input),
    ).rejects.toThrow("codex_rotating_workflow_source_attestation_missing");
    expect(mocks.replaceActiveWorkflowSource).toHaveBeenCalledOnce();
  });

  it("fails closed when trusted V5 workflow bytes changed", async () => {
    mocks.inspectNamespace.mockResolvedValueOnce({
      source: "active",
      namespace: {
        namespaceId: "namespace_2",
        epoch: 2n,
        name: "REVIEWROUTER_CODEX_AUTH_JSON_TEST_E2",
      },
    });
    mocks.createAttestation.mockReturnValueOnce({
      repositoryId: "1228051727",
      workflowPath: ".github/workflows/reviewrouter-codex.yml",
      workflowSourceCommitSha: firstHead,
      workflowSourceBlobSha: "e".repeat(40),
      workflowSourceSha256: "f".repeat(64),
      workflowSemanticSha256: "1".repeat(64),
      workflowSchemaVersion: 5,
      sourceTrust: "trusted_default_branch_revision",
    });
    const { input } = fixture();
    mocks.replaceActiveWorkflowSource.mockRejectedValueOnce(
      new Error("codex_rotating_workflow_reattestation_transition_invalid"),
    );

    await expect(
      activateConfirmedCodexNamespaceAfterWorkflowMerge(input),
    ).rejects.toThrow(
      "codex_rotating_workflow_reattestation_transition_invalid",
    );
    expect(mocks.replaceActiveWorkflowSource).toHaveBeenCalledOnce();
  });

  it("re-attests an active V4 namespace after its workflow is upgraded to V5", async () => {
    const previousSource = "name: canonical v4 workflow\n";
    const previousBlobSha = gitBlobSha(previousSource);
    const previousSourceSha256 = createHash("sha256")
      .update(previousSource)
      .digest("hex");
    const previousSemanticSha256 = "1".repeat(64);
    mocks.inspectNamespace.mockResolvedValueOnce({
      source: "active",
      claimId: "claim_1",
      attemptId: "attempt_1",
      namespace: {
        namespaceId: "namespace_2",
        epoch: 2n,
        name: "REVIEWROUTER_CODEX_AUTH_JSON_TEST_E2",
      },
    });
    const { input, findAttestation, request } = fixture();
    findAttestation.mockResolvedValueOnce({
      workflowPath: ".github/workflows/reviewrouter-codex.yml",
      workflowSourceCommitSha: "d".repeat(40),
      workflowSourceBlobSha: previousBlobSha,
      workflowSourceSha256: previousSourceSha256,
      workflowSemanticSha256: previousSemanticSha256,
      workflowSourceTrust: "trusted_default_branch_revision",
      workflowSchemaVersion: 4,
      attestedRepositoryId: "1228051727",
    });
    request.mockResolvedValueOnce({
      data: {
        type: "file",
        encoding: "base64",
        content: Buffer.from(previousSource, "utf8").toString("base64"),
        sha: previousBlobSha,
      },
    });
    request.mockResolvedValueOnce(refResponse(firstHead));
    mocks.semanticSha
      .mockReturnValueOnce("b".repeat(64))
      .mockReturnValueOnce(previousSemanticSha256);
    mocks.readMetadata
      .mockReturnValueOnce({
        actionRef: "action-sha",
        workflowSchemaVersion: 5,
      })
      .mockReturnValueOnce({
        actionRef: "action-sha",
        workflowSchemaVersion: 4,
      });
    mocks.replaceActiveWorkflowSource.mockResolvedValueOnce({
      status: "reattested",
      workflowSourceCommitSha: firstHead,
    });

    await expect(
      activateConfirmedCodexNamespaceAfterWorkflowMerge(input),
    ).resolves.toEqual({
      status: "activated",
      namespaceEpoch: "2",
      workflowSourceCommitSha: firstHead,
    });
    expect(mocks.replaceActiveWorkflowSource).toHaveBeenCalledWith(
      expect.objectContaining({
        claimId: "claim_1",
        attemptId: "attempt_1",
        expectedGenerationHash: "9".repeat(64),
        namespace: expect.objectContaining({ namespaceId: "namespace_2" }),
      }),
      expect.objectContaining({
        readDefaultSourceIdentity: expect.any(Function),
        readVerifiedWorkflowAt: expect.any(Function),
      }),
    );
  });

  it("re-reads the GitHub repository identity and exact default ref through the reattestation port", async () => {
    mocks.inspectNamespace.mockResolvedValueOnce({
      source: "active",
      claimId: "claim_1",
      attemptId: "attempt_1",
      namespace: {
        namespaceId: "namespace_2",
        epoch: 2n,
        name: "REVIEWROUTER_CODEX_AUTH_JSON_TEST_E2",
      },
    });
    const { input, request } = fixture();
    request
      .mockReset()
      .mockResolvedValueOnce(repositoryResponse())
      .mockResolvedValueOnce(refResponse(firstHead))
      .mockResolvedValueOnce(contentResponse())
      .mockResolvedValueOnce({
        data: {
          id: 1228051728,
          full_name: "attacker/renamed",
          default_branch: "main",
        },
      })
      .mockResolvedValueOnce(refResponse("d".repeat(40)));
    const observedIdentities: unknown[] = [];
    mocks.replaceActiveWorkflowSource.mockImplementationOnce(
      async (
        _target: unknown,
        sourcePort: CodexRotatingDefaultWorkflowSourcePort,
      ) => {
        const initial = await sourcePort.readDefaultSourceIdentity();
        observedIdentities.push(initial);
        await sourcePort.readVerifiedWorkflowAt({
          commitSha: initial.headCommitSha,
          expectedSchemaVersion: 5,
        });
        observedIdentities.push(await sourcePort.readDefaultSourceIdentity());
        return {
          status: "already_active",
          workflowSourceCommitSha: initial.headCommitSha,
        };
      },
    );

    await expect(
      activateConfirmedCodexNamespaceAfterWorkflowMerge(input),
    ).resolves.toMatchObject({ status: "already_active" });
    expect(observedIdentities).toEqual([
      {
        repositoryId: "1228051727",
        repositoryFullName: "777genius/review-router-saas-e2e",
        defaultBranch: "main",
        headCommitSha: firstHead,
      },
      {
        repositoryId: "1228051728",
        repositoryFullName: "attacker/renamed",
        defaultBranch: "main",
        headCommitSha: "d".repeat(40),
      },
    ]);
    expect(request).toHaveBeenNthCalledWith(
      5,
      "GET /repos/{owner}/{repo}/git/ref/{ref}",
      expect.objectContaining({ ref: "heads/main" }),
    );
  });

  it.each([
    ["repository id", { id: 1228051728 }],
    ["repository full name", { full_name: "attacker/renamed" }],
    ["default branch", { default_branch: "trunk" }],
  ])(
    "fails closed when the %s changes immediately before initial activation persistence",
    async (_name, identityChange) => {
      const { input, request } = fixture();
      request
        .mockReset()
        .mockResolvedValueOnce(repositoryResponse())
        .mockResolvedValueOnce(refResponse(firstHead))
        .mockResolvedValueOnce(contentResponse())
        .mockResolvedValueOnce({
          data: { ...repositoryResponse().data, ...identityChange },
        });

      await expect(
        activateConfirmedCodexNamespaceAfterWorkflowMerge(input),
      ).rejects.toThrow("codex_rotating_workflow_repository_identity_changed");
      expect(mocks.activate).not.toHaveBeenCalled();
    },
  );

  it("fails closed when the default head changes after the final identity reread", async () => {
    const { input, request } = fixture();
    request
      .mockReset()
      .mockResolvedValueOnce(repositoryResponse())
      .mockResolvedValueOnce(refResponse(firstHead))
      .mockResolvedValueOnce(contentResponse())
      .mockResolvedValueOnce(repositoryResponse())
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
  const findUnique = vi.fn().mockResolvedValue({
    id: "provider_1",
    latestGenerationHash: "9".repeat(64),
  });
  const findAttestation = vi.fn().mockResolvedValue({
    workflowPath: ".github/workflows/reviewrouter-codex.yml",
    workflowSourceCommitSha: firstHead,
    workflowSourceBlobSha: blobSha,
    workflowSourceSha256: "c".repeat(64),
    workflowSemanticSha256: "b".repeat(64),
    workflowSourceTrust: "trusted_default_branch_revision",
    workflowSchemaVersion: 5,
    attestedRepositoryId: "1228051727",
  });
  const request = vi
    .fn()
    .mockResolvedValueOnce(repositoryResponse())
    .mockResolvedValueOnce(refResponse(firstHead))
    .mockResolvedValueOnce(contentResponse())
    .mockResolvedValueOnce(repositoryResponse())
    .mockResolvedValueOnce(refResponse(firstHead));
  return {
    findUnique,
    findAttestation,
    request,
    input: {
      prisma: {
        codexOAuthProviderInstance: { findUnique },
        codexOAuthSecretNamespace: { findUnique: findAttestation },
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
      expectedWorkflowSchemaVersion: 5,
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
