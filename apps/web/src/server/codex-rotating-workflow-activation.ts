import { createHash } from "node:crypto";
import {
  canonicalCodexRotatingProviderId,
  codexRotatingAuthMode,
  inspectCodexRotatingWorkflowNamespace,
} from "@reviewrouter/features-provider-setup";
import {
  assertTrustedCanonicalVersionedWorkflow,
  CodexRotatingT0WorkflowSchemaVersion,
  createVersionedSecretWorkflowSourceAttestation,
  defaultCodexRotatingWorkflowPath,
  readCanonicalCodexRotatingT0WorkflowSourceMetadata,
  workflowDocumentSemanticSha256,
  WorkflowSourceTrust,
} from "@reviewrouter/features-workflow-provisioning";
import type { PrismaClient } from "@reviewrouter/platform-db";
import {
  requireReviewRouterDatabaseRecoveryWitness,
  resolveReviewRouterCodexRotatingTrustedActionRefs,
} from "@reviewrouter/platform-config";
import { codexRotatingSetupLedger } from "./codex-rotating-setup-ledger";
import { PrismaCodexRotatingWorkflowNamespace } from "./prisma-codex-rotating-workflow-namespace";

type GitHubRequester = {
  request(
    route: string,
    parameters?: Record<string, unknown>,
  ): Promise<{ data: unknown }>;
};

export type CodexRotatingWorkflowActivationResult =
  | { readonly status: "not_configured" }
  | {
      readonly status: "already_active" | "activated";
      readonly namespaceEpoch: string;
      readonly workflowSourceCommitSha: string;
    };

export async function activateConfirmedCodexNamespaceAfterWorkflowMerge(input: {
  readonly prisma: PrismaClient;
  readonly octokit: GitHubRequester;
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly githubRepositoryId: string;
  readonly owner: string;
  readonly name: string;
  readonly defaultBranch: string;
  readonly expectedRepositoryFullName: string;
  readonly expectedApiUrl: string;
  readonly expectedWorkflowSchemaVersion: CodexRotatingT0WorkflowSchemaVersion;
}): Promise<CodexRotatingWorkflowActivationResult> {
  const rotatingProvider =
    await input.prisma.codexOAuthProviderInstance.findUnique({
      where: {
        repositoryId_authMode: {
          repositoryId: input.repositoryId,
          authMode: codexRotatingAuthMode,
        },
      },
      select: { id: true, latestGenerationHash: true },
    });
  if (!rotatingProvider) return { status: "not_configured" };

  const providerInstanceId = canonicalCodexRotatingProviderId(
    input.githubRepositoryId,
  );
  const inspection = await inspectCodexRotatingWorkflowNamespace(
    {
      workspaceId: input.workspaceId,
      repositoryId: input.repositoryId,
      githubRepositoryId: input.githubRepositoryId,
      providerInstanceId,
    },
    {
      workflowNamespace: new PrismaCodexRotatingWorkflowNamespace(
        input.prisma,
        requireReviewRouterDatabaseRecoveryWitness(),
      ),
    },
  );
  const namespace = inspection.namespace;
  const repositoryResponse = await input.octokit.request(
    "GET /repos/{owner}/{repo}",
    { owner: input.owner, repo: input.name },
  );
  const observedRepository = readGitHubRepositoryIdentity(
    repositoryResponse.data,
  );
  if (observedRepository.defaultBranch !== input.defaultBranch) {
    throw new Error("codex_rotating_workflow_default_branch_mismatch");
  }
  const refParameters = {
    owner: input.owner,
    repo: input.name,
    ref: `heads/${input.defaultBranch}`,
  };
  const refResponse = await input.octokit.request(
    "GET /repos/{owner}/{repo}/git/ref/{ref}",
    refParameters,
  );
  const workflowSourceCommitSha = readGitHubCommitSha(refResponse.data);
  const workflowPath = defaultCodexRotatingWorkflowPath;
  const contentResponse = await input.octokit.request(
    "GET /repos/{owner}/{repo}/contents/{path}",
    {
      owner: input.owner,
      repo: input.name,
      path: workflowPath,
      ref: workflowSourceCommitSha,
    },
  );
  const { source, blobSha } = readGitHubWorkflowBlob(contentResponse.data);
  const metadata = readCanonicalCodexRotatingT0WorkflowSourceMetadata(source);
  assertTrustedCanonicalVersionedWorkflow({
    metadata,
    observedRepositoryId: observedRepository.id,
    observedRepositoryFullName: observedRepository.fullName,
    expectedRepositoryId: input.githubRepositoryId,
    expectedRepositoryFullName: input.expectedRepositoryFullName,
    trustedActionRefs: resolveReviewRouterCodexRotatingTrustedActionRefs(),
    expectedApiUrl: input.expectedApiUrl,
    expectedProviderInstanceId: providerInstanceId,
    expectedSecretNamespace: namespace,
    expectedWorkflowSchemaVersion: input.expectedWorkflowSchemaVersion,
  });
  const attestation = createVersionedSecretWorkflowSourceAttestation({
    repositoryId: input.githubRepositoryId,
    workflowPath,
    workflowSourceCommitSha,
    workflowSourceBlobSha: blobSha,
    workflowSourceSha256: createHash("sha256").update(source).digest("hex"),
    workflowSemanticSha256: workflowDocumentSemanticSha256(source),
    workflowSchemaVersion: metadata.workflowSchemaVersion,
    sourceTrust: WorkflowSourceTrust.TrustedDefaultBranchRevision,
    secretNamespace: namespace,
  });
  const finalRefResponse = await input.octokit.request(
    "GET /repos/{owner}/{repo}/git/ref/{ref}",
    refParameters,
  );
  if (readGitHubCommitSha(finalRefResponse.data) !== workflowSourceCommitSha) {
    throw new Error("codex_rotating_workflow_default_head_changed");
  }
  if (inspection.source === "active") {
    const currentAttestation =
      await input.prisma.codexOAuthSecretNamespace.findUnique({
        where: { id: namespace.namespaceId },
        select: {
          workflowPath: true,
          workflowSourceCommitSha: true,
          workflowSourceBlobSha: true,
          workflowSourceSha256: true,
          workflowSemanticSha256: true,
          workflowSourceTrust: true,
          workflowSchemaVersion: true,
          attestedRepositoryId: true,
        },
      });
    if (
      currentAttestation?.workflowPath !== attestation.workflowPath ||
      !currentAttestation.workflowSourceCommitSha ||
      !currentAttestation.workflowSourceBlobSha ||
      !currentAttestation.workflowSourceSha256 ||
      !currentAttestation.workflowSemanticSha256 ||
      currentAttestation.workflowSourceTrust !== attestation.sourceTrust ||
      currentAttestation.workflowSchemaVersion === null ||
      currentAttestation.attestedRepositoryId !== attestation.repositoryId
    ) {
      throw new Error("codex_rotating_workflow_source_attestation_missing");
    }
    if (!rotatingProvider.latestGenerationHash) {
      throw new Error("codex_rotating_workflow_generation_missing");
    }
    if (
      currentAttestation.workflowSourceBlobSha ===
        attestation.workflowSourceBlobSha &&
      currentAttestation.workflowSourceSha256 ===
        attestation.workflowSourceSha256 &&
      currentAttestation.workflowSemanticSha256 ===
        attestation.workflowSemanticSha256 &&
      currentAttestation.workflowSchemaVersion ===
        input.expectedWorkflowSchemaVersion &&
      currentAttestation.workflowSourceTrust === attestation.sourceTrust &&
      currentAttestation.attestedRepositoryId === attestation.repositoryId
    ) {
      return {
        status: "already_active",
        namespaceEpoch: namespace.epoch.toString(),
        workflowSourceCommitSha,
      };
    }
    if (
      input.expectedWorkflowSchemaVersion !==
        CodexRotatingT0WorkflowSchemaVersion.VersionedSecretNamespaceV5 ||
      attestation.workflowSchemaVersion !==
        CodexRotatingT0WorkflowSchemaVersion.VersionedSecretNamespaceV5 ||
      currentAttestation.workflowSchemaVersion !==
        CodexRotatingT0WorkflowSchemaVersion.VersionedSecretNamespaceV4
    ) {
      throw new Error(
        "codex_rotating_workflow_reattestation_transition_invalid",
      );
    }
    const previousContentResponse = await input.octokit.request(
      "GET /repos/{owner}/{repo}/contents/{path}",
      {
        owner: input.owner,
        repo: input.name,
        path: workflowPath,
        ref: currentAttestation.workflowSourceCommitSha,
      },
    );
    const previousWorkflow = readGitHubWorkflowBlob(
      previousContentResponse.data,
    );
    if (
      previousWorkflow.blobSha !==
        currentAttestation.workflowSourceBlobSha.toLowerCase() ||
      createHash("sha256").update(previousWorkflow.source).digest("hex") !==
        currentAttestation.workflowSourceSha256.toLowerCase() ||
      workflowDocumentSemanticSha256(previousWorkflow.source) !==
        currentAttestation.workflowSemanticSha256.toLowerCase()
    ) {
      throw new Error("codex_rotating_workflow_previous_attestation_mismatch");
    }
    const previousMetadata = readCanonicalCodexRotatingT0WorkflowSourceMetadata(
      previousWorkflow.source,
    );
    assertTrustedCanonicalVersionedWorkflow({
      metadata: previousMetadata,
      observedRepositoryId: observedRepository.id,
      observedRepositoryFullName: observedRepository.fullName,
      expectedRepositoryId: input.githubRepositoryId,
      expectedRepositoryFullName: input.expectedRepositoryFullName,
      trustedActionRefs: resolveReviewRouterCodexRotatingTrustedActionRefs(),
      expectedApiUrl: input.expectedApiUrl,
      expectedProviderInstanceId: providerInstanceId,
      expectedSecretNamespace: namespace,
      expectedWorkflowSchemaVersion:
        CodexRotatingT0WorkflowSchemaVersion.VersionedSecretNamespaceV4,
    });
    const transitionRefResponse = await input.octokit.request(
      "GET /repos/{owner}/{repo}/git/ref/{ref}",
      refParameters,
    );
    if (
      readGitHubCommitSha(transitionRefResponse.data) !==
      workflowSourceCommitSha
    ) {
      throw new Error("codex_rotating_workflow_default_head_changed");
    }
    await codexRotatingSetupLedger.replaceActiveWorkflowSource({
      claimId: inspection.claimId,
      attemptId: inspection.attemptId,
      namespaceId: namespace.namespaceId,
      namespaceEpoch: namespace.epoch.toString(),
      secretName: namespace.name,
      repositoryId: attestation.repositoryId,
      expectedGenerationHash: rotatingProvider.latestGenerationHash,
      workflowPath: attestation.workflowPath,
      workflowSourceCommitSha: attestation.workflowSourceCommitSha,
      workflowSourceBlobSha: attestation.workflowSourceBlobSha,
      workflowSourceSha256: attestation.workflowSourceSha256,
      workflowSemanticSha256: attestation.workflowSemanticSha256,
      sourceTrust: attestation.sourceTrust,
      expectedCurrentWorkflowSchemaVersion:
        CodexRotatingT0WorkflowSchemaVersion.VersionedSecretNamespaceV4,
      workflowSchemaVersion: attestation.workflowSchemaVersion,
      expectedCurrentWorkflowSourceCommitSha:
        currentAttestation.workflowSourceCommitSha,
      expectedCurrentWorkflowSourceBlobSha:
        currentAttestation.workflowSourceBlobSha,
      expectedCurrentWorkflowSourceSha256:
        currentAttestation.workflowSourceSha256,
      expectedCurrentWorkflowSemanticSha256:
        currentAttestation.workflowSemanticSha256,
    });
    return {
      status: "activated",
      namespaceEpoch: namespace.epoch.toString(),
      workflowSourceCommitSha,
    };
  }
  await codexRotatingSetupLedger.activate({
    claimId: inspection.claimId,
    attemptId: inspection.attemptId,
    namespaceId: namespace.namespaceId,
    namespaceEpoch: namespace.epoch.toString(),
    secretName: namespace.name,
    repositoryId: attestation.repositoryId,
    workflowPath: attestation.workflowPath,
    workflowSourceCommitSha: attestation.workflowSourceCommitSha,
    workflowSourceBlobSha: attestation.workflowSourceBlobSha,
    workflowSourceSha256: attestation.workflowSourceSha256,
    workflowSemanticSha256: attestation.workflowSemanticSha256,
    sourceTrust: attestation.sourceTrust,
    workflowSchemaVersion: attestation.workflowSchemaVersion,
  });
  return {
    status: "activated",
    namespaceEpoch: namespace.epoch.toString(),
    workflowSourceCommitSha,
  };
}

function readGitHubRepositoryIdentity(data: unknown): {
  readonly id: string;
  readonly fullName: string;
  readonly defaultBranch: string;
} {
  const repository = data as {
    id?: unknown;
    full_name?: unknown;
    default_branch?: unknown;
  } | null;
  if (
    typeof repository?.id !== "number" ||
    !Number.isSafeInteger(repository.id) ||
    repository.id <= 0 ||
    typeof repository.full_name !== "string" ||
    typeof repository.default_branch !== "string" ||
    repository.default_branch.length === 0
  ) {
    throw new Error("codex_rotating_workflow_repository_invalid_response");
  }
  return {
    id: String(repository.id),
    fullName: repository.full_name,
    defaultBranch: repository.default_branch,
  };
}

function readGitHubCommitSha(data: unknown): string {
  const sha = (data as { object?: { sha?: unknown } } | null)?.object?.sha;
  if (typeof sha !== "string" || !/^[a-f0-9]{40}$/i.test(sha)) {
    throw new Error("codex_rotating_workflow_commit_invalid_response");
  }
  return sha.toLowerCase();
}

function readGitHubWorkflowBlob(data: unknown): {
  readonly source: string;
  readonly blobSha: string;
} {
  const blob = data as {
    type?: unknown;
    encoding?: unknown;
    content?: unknown;
    sha?: unknown;
  } | null;
  if (
    blob?.type !== "file" ||
    blob.encoding !== "base64" ||
    typeof blob.content !== "string" ||
    typeof blob.sha !== "string" ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(blob.sha)
  ) {
    throw new Error("codex_rotating_workflow_content_invalid_response");
  }
  const source = Buffer.from(
    blob.content.replace(/\s+/g, ""),
    "base64",
  ).toString("utf8");
  const blobSha = blob.sha.toLowerCase();
  const computed = createHash(blobSha.length === 40 ? "sha1" : "sha256")
    .update(`blob ${Buffer.byteLength(source, "utf8")}\0`, "utf8")
    .update(source, "utf8")
    .digest("hex");
  if (computed !== blobSha) {
    throw new Error("codex_rotating_workflow_blob_sha_mismatch");
  }
  return { source, blobSha };
}
