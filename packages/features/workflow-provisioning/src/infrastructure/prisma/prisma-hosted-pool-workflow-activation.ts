import { createHash } from "node:crypto";
import {
  assertActiveHostedPoolWorkflowAttestation,
  canonicalHostedPoolProviderInstanceId,
  createHostedPoolWorkflowSourceAttestation,
  hostedPoolWorkflowSemanticSha256,
  readCanonicalHostedPoolWorkflowMetadata,
  renderCanonicalHostedPoolWorkflowV2,
} from "../../domain/hosted-pool-workflow-template";
import type { Prisma, PrismaClient } from "@prisma/client";
import { defaultCodexRotatingWorkflowPath } from "../../domain/workflow-template";

type GitHubRequester = {
  request(
    route: string,
    parameters?: Record<string, unknown>,
  ): Promise<{ data: unknown }>;
};

export type VerifiedHostedPoolWorkflow = {
  readonly workflowPath: string;
  readonly workflowStyle: "reusable";
  readonly actionVersion: string;
  readonly bindingId: string;
  readonly bindingRevision: number;
  readonly workflowSourceCommitSha: string;
};

export type HostedPoolWorkflowActivationResult =
  | { readonly status: "not_configured" }
  | (VerifiedHostedPoolWorkflow & {
      readonly status: "already_active" | "activated";
    });

export async function activateConfirmedHostedPoolBindingAfterWorkflowMerge(input: {
  readonly prisma: PrismaClient;
  readonly trustedActionRefs: readonly string[];
  readonly switchConfiguration: (input: {
    readonly transaction: Prisma.TransactionClient;
    readonly workspaceId: string;
    readonly repositoryId: string;
    readonly authMode: "codex_subscription_oauth_hosted_pool";
  }) => Promise<boolean>;
  readonly octokit: GitHubRequester;
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly installationId: string;
  readonly githubRepositoryId: string;
  readonly owner: string;
  readonly name: string;
  readonly defaultBranch: string;
  readonly expectedRepositoryFullName: string;
  readonly expectedApiUrl: string;
  readonly now: Date;
  readonly expectedBinding?: {
    readonly id: string;
    readonly revision: bigint;
    readonly stateVersion: bigint;
    readonly status: string;
  };
  // Readiness is established by the canonical verifier below. Let the caller
  // fence its setup attempt against that exact artifact before any effects.
  readonly beforeActivation?: (
    workflow: VerifiedHostedPoolWorkflow,
  ) => Promise<void>;
}): Promise<HostedPoolWorkflowActivationResult> {
  const repositoryScope = {
    workspaceId: input.workspaceId,
    installationId: input.installationId,
    provider: "github",
    selected: true,
    archived: false,
    installation: { status: "active" },
  } as const;
  const binding = await input.prisma.hostedCodexRepositoryBinding.findFirst({
    where: {
      repositoryConnectionId: input.repositoryId,
      workspaceId: input.workspaceId,
      status: { in: ["pending_activation", "active"] },
      tombstonedAt: null,
      repository: repositoryScope,
    },
  });
  if (!binding) return { status: "not_configured" };
  if (
    input.expectedBinding &&
    (binding.id !== input.expectedBinding.id ||
      binding.revision !== input.expectedBinding.revision ||
      binding.stateVersion !== input.expectedBinding.stateVersion ||
      binding.status !== input.expectedBinding.status)
  )
    throw new Error("hosted_pool_binding_activation_conflict");

  const repositoryResponse = await input.octokit.request(
    "GET /repos/{owner}/{repo}",
    { owner: input.owner, repo: input.name },
  );
  const observedRepository = readGitHubRepositoryIdentity(
    repositoryResponse.data,
  );
  if (
    observedRepository.id !== input.githubRepositoryId ||
    observedRepository.fullName.toLowerCase() !==
      input.expectedRepositoryFullName.toLowerCase() ||
    observedRepository.defaultBranch !== input.defaultBranch
  ) {
    throw new Error("hosted_workflow_repository_mismatch");
  }

  const refParameters = {
    owner: input.owner,
    repo: input.name,
    ref: `heads/${input.defaultBranch}`,
  };
  const firstRef = await input.octokit.request(
    "GET /repos/{owner}/{repo}/git/ref/{ref}",
    refParameters,
  );
  const workflowSourceCommitSha = readGitHubCommitSha(firstRef.data);
  const contentResponse = await input.octokit.request(
    "GET /repos/{owner}/{repo}/contents/{path}",
    {
      owner: input.owner,
      repo: input.name,
      path: defaultCodexRotatingWorkflowPath,
      ref: workflowSourceCommitSha,
    },
  );
  const { source, blobSha } = readGitHubWorkflowBlob(contentResponse.data);
  const metadata = readCanonicalHostedPoolWorkflowMetadata(source);
  const bindingRevision = toSafeNumber(binding.revision);
  const expectedProviderInstanceId = canonicalHostedPoolProviderInstanceId(
    input.githubRepositoryId,
  );
  if (
    metadata.apiUrl !== input.expectedApiUrl ||
    metadata.providerInstanceId !== expectedProviderInstanceId ||
    metadata.bindingId !== binding.id ||
    metadata.bindingRevision !== bindingRevision ||
    !input.trustedActionRefs.includes(metadata.actionRef)
  ) {
    throw new Error("hosted_workflow_authority_mismatch");
  }
  const expectedWorkflow = renderCanonicalHostedPoolWorkflowV2(metadata);
  const attestation = createHostedPoolWorkflowSourceAttestation({
    repositoryId: input.githubRepositoryId,
    workflowPath: defaultCodexRotatingWorkflowPath,
    workflowSourceCommitSha,
    workflowSourceBlobSha: blobSha,
    workflowSourceSha256: createHash("sha256").update(source).digest("hex"),
    workflowSemanticSha256: hostedPoolWorkflowSemanticSha256(source),
    sourceTrust: "trusted_default_branch_revision",
    bindingId: binding.id,
    bindingRevision,
  });
  assertActiveHostedPoolWorkflowAttestation({
    attestation,
    repositoryId: input.githubRepositoryId,
    workflowPath: defaultCodexRotatingWorkflowPath,
    workflowSourceCommitSha,
    expectedBindingId: binding.id,
    expectedBindingRevision: bindingRevision,
    expectedWorkflow,
    expectedWorkflowSourceBlobSha: blobSha,
  });

  const finalRef = await input.octokit.request(
    "GET /repos/{owner}/{repo}/git/ref/{ref}",
    refParameters,
  );
  if (readGitHubCommitSha(finalRef.data) !== workflowSourceCommitSha) {
    throw new Error("hosted_workflow_default_head_changed");
  }

  const verifiedWorkflow: VerifiedHostedPoolWorkflow = {
    workflowPath: attestation.workflowPath,
    workflowStyle: "reusable",
    actionVersion: metadata.actionRef,
    bindingId: binding.id,
    bindingRevision,
    workflowSourceCommitSha,
  };
  if (binding.status === "active") {
    assertStoredAttestationMatches(binding, {
      ...attestation,
      actionRef: metadata.actionRef,
    });
  }
  await input.beforeActivation?.(verifiedWorkflow);
  if (binding.status === "active") {
    return { status: "already_active", ...verifiedWorkflow };
  }

  await input.prisma.$transaction(async (transaction) => {
    const configured = await input.switchConfiguration({
      transaction,
      workspaceId: input.workspaceId,
      repositoryId: input.repositoryId,
      authMode: "codex_subscription_oauth_hosted_pool",
    });
    if (!configured)
      throw new Error("hosted_pool_configuration_switch_rejected");
    const updated = await transaction.hostedCodexRepositoryBinding.updateMany({
      where: {
        id: binding.id,
        workspaceId: input.workspaceId,
        repositoryConnectionId: input.repositoryId,
        status: "pending_activation",
        revision: binding.revision,
        stateVersion: binding.stateVersion,
        tombstonedAt: null,
        repository: repositoryScope,
      },
      data: {
        status: "active",
        stateVersion: { increment: 1 },
        workflowPath: attestation.workflowPath,
        workflowActionRef: metadata.actionRef,
        workflowSourceCommitSha: attestation.workflowSourceCommitSha,
        workflowSourceBlobSha: attestation.workflowSourceBlobSha,
        workflowSourceSha256: attestation.workflowSourceSha256,
        workflowSemanticSha256: attestation.workflowSemanticSha256,
        workflowSourceTrust: attestation.sourceTrust,
        attestedGithubRepositoryId: BigInt(input.githubRepositoryId),
        attestedBindingRevision: binding.revision,
        activatedAt: input.now,
        updatedAt: input.now,
      },
    });
    if (updated.count !== 1)
      throw new Error("hosted_pool_binding_activation_conflict");
  });

  return {
    status: "activated",
    ...verifiedWorkflow,
  };
}

function assertStoredAttestationMatches(
  binding: Record<string, unknown>,
  expected: ReturnType<typeof createHostedPoolWorkflowSourceAttestation> & {
    readonly actionRef: string;
  },
): void {
  if (
    binding.workflowPath !== expected.workflowPath ||
    binding.workflowActionRef !== expected.actionRef ||
    binding.workflowSourceCommitSha !== expected.workflowSourceCommitSha ||
    binding.workflowSourceBlobSha !== expected.workflowSourceBlobSha ||
    binding.workflowSourceSha256 !== expected.workflowSourceSha256 ||
    binding.workflowSemanticSha256 !== expected.workflowSemanticSha256 ||
    binding.workflowSourceTrust !== expected.sourceTrust ||
    binding.attestedBindingRevision !== BigInt(expected.bindingRevision) ||
    binding.attestedGithubRepositoryId !== BigInt(expected.repositoryId)
  ) {
    throw new Error("hosted_workflow_stored_attestation_mismatch");
  }
}

function readGitHubRepositoryIdentity(data: unknown) {
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
    throw new Error("hosted_workflow_repository_invalid_response");
  }
  return {
    id: String(repository.id),
    fullName: repository.full_name,
    defaultBranch: repository.default_branch,
  };
}

function readGitHubCommitSha(data: unknown): string {
  const sha = (data as { object?: { sha?: unknown } } | null)?.object?.sha;
  if (typeof sha !== "string" || !/^[a-f0-9]{40}$/iu.test(sha))
    throw new Error("hosted_workflow_commit_invalid_response");
  return sha.toLowerCase();
}

function readGitHubWorkflowBlob(data: unknown) {
  const blob = data as {
    type?: unknown;
    path?: unknown;
    encoding?: unknown;
    content?: unknown;
    sha?: unknown;
  } | null;
  if (
    blob?.type !== "file" ||
    blob.path !== defaultCodexRotatingWorkflowPath ||
    blob.encoding !== "base64" ||
    typeof blob.content !== "string" ||
    typeof blob.sha !== "string" ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/iu.test(blob.sha)
  ) {
    throw new Error("hosted_workflow_content_invalid_response");
  }
  const source = Buffer.from(
    blob.content.replace(/\s+/gu, ""),
    "base64",
  ).toString("utf8");
  const blobSha = blob.sha.toLowerCase();
  const computed = createHash(blobSha.length === 40 ? "sha1" : "sha256")
    .update(`blob ${Buffer.byteLength(source, "utf8")}\0`, "utf8")
    .update(source, "utf8")
    .digest("hex");
  if (computed !== blobSha)
    throw new Error("hosted_workflow_blob_sha_mismatch");
  return { source, blobSha };
}

function toSafeNumber(value: bigint): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1)
    throw new Error("hosted_pool_binding_revision_invalid");
  return result;
}
