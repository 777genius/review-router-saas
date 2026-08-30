import { createHash } from "node:crypto";
import {
  canonicalCodexRotatingProviderId,
  codexRotatingAuthMode,
  inspectCodexRotatingWorkflowNamespace,
} from "@reviewrouter/features-provider-setup";
import {
  assertTrustedCanonicalVersionedWorkflow,
  CodexRotatingT0WorkflowSchemaVersion,
  createVersionedProviderSecretNamespace,
  createVersionedSecretWorkflowSourceAttestation,
  defaultCodexRotatingWorkflowPath,
  readCanonicalCodexRotatingT0WorkflowSourceMetadata,
  workflowDocumentSemanticSha256,
  WorkflowSourceTrust,
} from "@reviewrouter/features-workflow-provisioning";
import type { PrismaClient } from "@reviewrouter/platform-db";
import {
  isCodexForkReviewV5AllowedForRepository,
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

type ZeroLoginRolloverActivationRecord = Readonly<{
  operationId: string;
  repositoryFullName: string;
  providerInstanceId: string;
  state:
    | "provider_confirmed"
    | "setup_pr_open"
    | "activated"
    | "prepared"
    | "put_authorized"
    | "aborted"
    | "provider_outcome_unknown";
  targetActionRef: string;
  candidateNamespaceId: string;
  candidateNamespaceEpoch: bigint;
  candidateNamespaceName: string;
  setupPullRequestNumber?: number | undefined;
  setupPullRequestHeadSha?: string | undefined;
  setupPullRequestBaseBranch?: string | undefined;
}>;

export type CodexZeroLoginRolloverActivationLedger = Readonly<{
  status(operationId: string): Promise<ZeroLoginRolloverActivationRecord | null>;
  activateAfterAttestation(input: {
    operationId: string;
    expectedNamespaceEpoch: bigint;
    attestation: ReturnType<typeof createVersionedSecretWorkflowSourceAttestation>;
  }): Promise<ZeroLoginRolloverActivationRecord>;
}>;

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
  readonly zeroLoginRollover?: Readonly<{
    operationId: string;
    expectedNamespaceEpoch: bigint;
    expectedDefaultHeadSha: string;
    ledger: CodexZeroLoginRolloverActivationLedger;
  }>;
}): Promise<CodexRotatingWorkflowActivationResult> {
  const rotatingProvider =
    await input.prisma.codexOAuthProviderInstance.findUnique({
      where: {
        repositoryId_authMode: {
          repositoryId: input.repositoryId,
          authMode: codexRotatingAuthMode,
        },
      },
      select: { id: true },
  });
  if (!rotatingProvider) return { status: "not_configured" };

  if (input.zeroLoginRollover) {
    return activateZeroLoginRolloverAfterWorkflowMerge({
      ...input,
      zeroLoginRollover: input.zeroLoginRollover,
    });
  }

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
    ...(inspection.source === "confirmed_setup_candidate"
      ? {
          expectedWorkflowSchemaVersion:
            isCodexForkReviewV5AllowedForRepository(
              input.expectedRepositoryFullName,
            )
              ? CodexRotatingT0WorkflowSchemaVersion.CertifiedForkReviewV5
              : CodexRotatingT0WorkflowSchemaVersion.VersionedSecretNamespaceV4,
        }
      : {}),
  });
  const attestation = createVersionedSecretWorkflowSourceAttestation({
    repositoryId: input.githubRepositoryId,
    workflowPath,
    workflowSourceCommitSha,
    workflowSourceBlobSha: blobSha,
    workflowSourceSha256: createHash("sha256").update(source).digest("hex"),
    workflowSemanticSha256: workflowDocumentSemanticSha256(source),
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
    return {
      status: "already_active",
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
  });
  return {
    status: "activated",
    namespaceEpoch: namespace.epoch.toString(),
    workflowSourceCommitSha,
  };
}

async function activateZeroLoginRolloverAfterWorkflowMerge(
  input: Parameters<
    typeof activateConfirmedCodexNamespaceAfterWorkflowMerge
  >[0] & {
    readonly zeroLoginRollover: NonNullable<
      Parameters<typeof activateConfirmedCodexNamespaceAfterWorkflowMerge>[0]["zeroLoginRollover"]
    >;
  },
): Promise<CodexRotatingWorkflowActivationResult> {
  const requested = input.zeroLoginRollover;
  if (
    !/^[A-Za-z0-9:_./-]{1,256}$/u.test(requested.operationId) ||
    requested.expectedNamespaceEpoch <= 0n ||
    !/^[a-f0-9]{40}$/u.test(requested.expectedDefaultHeadSha)
  ) {
    throw new Error("zero_login_rollover_activation_request_invalid");
  }
  const rollover = await requested.ledger.status(requested.operationId);
  if (!rollover) throw new Error("zero_login_rollover_not_found");
  if (
    rollover.repositoryFullName.toLowerCase() !==
      input.expectedRepositoryFullName.toLowerCase() ||
    rollover.providerInstanceId !==
      canonicalCodexRotatingProviderId(input.githubRepositoryId)
  ) {
    throw new Error("zero_login_rollover_repository_mismatch");
  }
  if (rollover.candidateNamespaceEpoch !== requested.expectedNamespaceEpoch) {
    throw new Error("zero_login_rollover_namespace_epoch_mismatch");
  }
  if (
    rollover.state !== "setup_pr_open" &&
    rollover.state !== "activated"
  ) {
    throw new Error("zero_login_rollover_activation_not_ready");
  }
  if (
    !rollover.setupPullRequestNumber ||
    !rollover.setupPullRequestHeadSha ||
    !rollover.setupPullRequestBaseBranch
  ) {
    throw new Error("zero_login_rollover_setup_pr_evidence_missing");
  }

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
  const pullRequestResponse = await input.octokit.request(
    "GET /repos/{owner}/{repo}/pulls/{pull_number}",
    {
      owner: input.owner,
      repo: input.name,
      pull_number: rollover.setupPullRequestNumber,
    },
  );
  assertMergedRolloverPullRequest({
    data: pullRequestResponse.data,
    expectedHeadSha: rollover.setupPullRequestHeadSha,
    expectedBaseBranch: rollover.setupPullRequestBaseBranch,
    expectedDefaultBranch: input.defaultBranch,
    expectedRepositoryId: input.githubRepositoryId,
  });

  const refParameters = {
    owner: input.owner,
    repo: input.name,
    ref: `heads/${input.defaultBranch}`,
  };
  const firstRefResponse = await input.octokit.request(
    "GET /repos/{owner}/{repo}/git/ref/{ref}",
    refParameters,
  );
  const workflowSourceCommitSha = readGitHubCommitSha(firstRefResponse.data);
  if (workflowSourceCommitSha !== requested.expectedDefaultHeadSha) {
    throw new Error("zero_login_rollover_expected_default_head_mismatch");
  }
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
  if (metadata.actionRef !== rollover.targetActionRef) {
    throw new Error("zero_login_rollover_target_action_mismatch");
  }
  if (!isCodexForkReviewV5AllowedForRepository(input.expectedRepositoryFullName)) {
    throw new Error("zero_login_rollover_v5_disabled_for_repository");
  }
  const namespace = createVersionedProviderSecretNamespace({
    scope: {
      repositoryId: input.githubRepositoryId,
      providerInstanceId: rollover.providerInstanceId,
    },
    namespaceId: rollover.candidateNamespaceId,
    name: rollover.candidateNamespaceName,
    epoch: rollover.candidateNamespaceEpoch,
  });
  assertTrustedCanonicalVersionedWorkflow({
    metadata,
    observedRepositoryId: observedRepository.id,
    observedRepositoryFullName: observedRepository.fullName,
    expectedRepositoryId: input.githubRepositoryId,
    expectedRepositoryFullName: input.expectedRepositoryFullName,
    trustedActionRefs: [rollover.targetActionRef],
    expectedApiUrl: input.expectedApiUrl,
    expectedProviderInstanceId: rollover.providerInstanceId,
    expectedSecretNamespace: namespace,
    expectedWorkflowSchemaVersion:
      CodexRotatingT0WorkflowSchemaVersion.CertifiedForkReviewV5,
  });
  const attestation = createVersionedSecretWorkflowSourceAttestation({
    repositoryId: input.githubRepositoryId,
    workflowPath,
    workflowSourceCommitSha,
    workflowSourceBlobSha: blobSha,
    workflowSourceSha256: createHash("sha256").update(source).digest("hex"),
    workflowSemanticSha256: workflowDocumentSemanticSha256(source),
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
  const wasAlreadyActive = rollover.state === "activated";
  const activated = await requested.ledger.activateAfterAttestation({
    operationId: requested.operationId,
    expectedNamespaceEpoch: requested.expectedNamespaceEpoch,
    attestation,
  });
  if (activated.state !== "activated") {
    throw new Error("zero_login_rollover_activation_stale_epoch");
  }
  return {
    status: wasAlreadyActive ? "already_active" : "activated",
    namespaceEpoch: requested.expectedNamespaceEpoch.toString(),
    workflowSourceCommitSha,
  };
}

function assertMergedRolloverPullRequest(input: {
  data: unknown;
  expectedHeadSha: string;
  expectedBaseBranch: string;
  expectedDefaultBranch: string;
  expectedRepositoryId: string;
}): void {
  const pullRequest = input.data as {
    merged?: unknown;
    merged_at?: unknown;
    head?: { sha?: unknown };
    base?: { ref?: unknown; repo?: { id?: unknown } };
  } | null;
  if (
    pullRequest?.merged !== true ||
    typeof pullRequest.merged_at !== "string" ||
    !Number.isFinite(Date.parse(pullRequest.merged_at)) ||
    pullRequest.head?.sha !== input.expectedHeadSha ||
    pullRequest.base?.ref !== input.expectedBaseBranch ||
    pullRequest.base.ref !== input.expectedDefaultBranch ||
    String(pullRequest.base.repo?.id) !== input.expectedRepositoryId
  ) {
    throw new Error("zero_login_rollover_setup_pr_not_exactly_merged");
  }
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
