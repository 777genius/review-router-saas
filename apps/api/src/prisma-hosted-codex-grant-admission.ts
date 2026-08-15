import { createHash } from "node:crypto";
import type { PrismaClient } from "@reviewrouter/platform-db";
import { PrismaActionControlPlaneRepository } from "@reviewrouter/features-action-control-plane";
import {
  mapConfigToRuntimeEnv,
  safeDefaultReviewConfiguration,
} from "@reviewrouter/features-review-config";
import {
  canonicalHostedPoolProviderInstanceId,
  type HostedPoolWorkflowSourceAttestation,
} from "@reviewrouter/features-workflow-provisioning";
import type {
  HostedCodexGrantAdmission,
  HostedCodexGrantAdmissionPort,
} from "./hosted-codex-grant-composition.js";

export interface HostedWorkflowSourceReaderPort {
  readCurrentDefaultBranchWorkflow(input: {
    readonly githubInstallationId: string;
    readonly owner: string;
    readonly repository: string;
    readonly defaultBranch: string;
    readonly workflowPath: string;
  }): Promise<{
    readonly commitSha: string;
    readonly blobSha: string;
    readonly contents: string;
  }>;
}

/**
 * Prisma-backed authority resolver. The caller supplies only opaque identifiers;
 * repository, provider strategy, policy, request and workflow facts come from
 * current server state and the live default-branch source reader.
 */
export class PrismaHostedCodexGrantAdmission implements HostedCodexGrantAdmissionPort {
  private readonly actionRepositories: PrismaActionControlPlaneRepository;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly workflowSources: HostedWorkflowSourceReaderPort,
    private readonly requiredWorkflowSchemaVersion: number,
  ) {
    this.actionRepositories = new PrismaActionControlPlaneRepository(prisma);
  }

  async resolve(
    input: Parameters<HostedCodexGrantAdmissionPort["resolve"]>[0],
  ) {
    if (input.workflowSchemaVersion !== this.requiredWorkflowSchemaVersion) {
      throw new Error("hosted_workflow_schema_version_mismatch");
    }
    const repository = await this.prisma.repositoryConnection.findFirst({
      where: {
        provider: "github",
        githubRepositoryId: BigInt(input.claims.repository_id),
      },
      select: {
        id: true,
        workspaceId: true,
        githubRepositoryId: true,
        owner: true,
        name: true,
        fullName: true,
        defaultBranch: true,
        visibility: true,
        selected: true,
        archived: true,
        installation: {
          select: { githubInstallationId: true, status: true },
        },
        hostedCodexBindings: {
          where: { id: input.bindingId },
          take: 1,
          select: {
            id: true,
            status: true,
            revision: true,
            workflowPath: true,
            workflowActionRef: true,
            workflowSourceCommitSha: true,
            workflowSourceBlobSha: true,
            workflowSourceSha256: true,
            workflowSemanticSha256: true,
            workflowSourceTrust: true,
            attestedGithubRepositoryId: true,
            attestedBindingRevision: true,
            pool: { select: { authzEpoch: true, status: true } },
          },
        },
      },
    });
    const binding = repository?.hostedCodexBindings[0];
    if (
      !repository ||
      !repository.githubRepositoryId ||
      !repository.installation ||
      repository.archived ||
      !binding ||
      binding.status !== "active" ||
      binding.pool.status !== "active"
    ) {
      throw new Error("hosted_repository_not_eligible");
    }
    const bindingRevision = toPositiveSafeNumber(
      binding.revision,
      "hosted_binding_revision_invalid",
    );
    if (
      bindingRevision !== input.bindingVersion ||
      binding.attestedBindingRevision !== binding.revision ||
      binding.attestedGithubRepositoryId !== repository.githubRepositoryId
    ) {
      throw new Error("hosted_grant_binding_mismatch");
    }
    const expectedProviderInstanceId = canonicalHostedPoolProviderInstanceId(
      repository.githubRepositoryId.toString(),
    );
    if (input.providerInstanceId !== expectedProviderInstanceId) {
      throw new Error("hosted_provider_instance_mismatch");
    }
    const attestation = parseAttestation(
      binding,
      repository.githubRepositoryId,
    );
    const liveSource =
      await this.workflowSources.readCurrentDefaultBranchWorkflow({
        githubInstallationId:
          repository.installation.githubInstallationId.toString(),
        owner: repository.owner,
        repository: repository.name,
        defaultBranch: repository.defaultBranch,
        workflowPath: attestation.workflowPath,
      });
    const reviewRequest = await this.prisma.reviewRequestedIntent.findFirst({
      where: {
        workspaceId: repository.workspaceId,
        repositoryConnectionId: repository.id,
        sourceRunId: input.claims.run_id,
        sourceRunAttempt: input.claims.run_attempt,
        admissionState: "admitted",
        state: { in: ["awaiting_authorization", "dispatched"] },
      },
      orderBy: { updatedAt: "desc" },
      select: { requestId: true, reviewRevisionHash: true },
    });
    if (!reviewRequest) throw new Error("hosted_review_request_not_admitted");
    const runtime =
      await this.actionRepositories.findRuntimeReviewConfiguration({
        workspaceId: repository.workspaceId,
        repositoryId: repository.id,
      });
    const config = runtime?.config ?? safeDefaultReviewConfiguration;
    const hostedProviders = config.providers.filter(
      (provider) =>
        provider.kind === "codex" &&
        provider.authMode === "codex_subscription_oauth_hosted_pool",
    );
    if (hostedProviders.length !== 1 || config.providers.length !== 1) {
      throw new Error("hosted_provider_strategy_not_configured");
    }
    const provider = hostedProviders[0]!;
    const runtimeConfigVersion = runtime?.version ?? 1;
    const authorityFacts = {
      workspaceId: repository.workspaceId,
      repositoryId: repository.id,
      reviewRequestId: reviewRequest.requestId,
      reviewRevisionHash: reviewRequest.reviewRevisionHash,
      runtimeConfigVersion,
      provider,
      bindingId: binding.id,
      bindingRevision,
      authzEpoch: binding.pool.authzEpoch.toString(),
      workflowSourceSha256: attestation.workflowSourceSha256,
    };
    const workflowSource = `${repository.fullName}/${attestation.workflowPath}@refs/heads/${repository.defaultBranch}`;
    const workflowJob = hostedJobWorkflowIdentity(binding.workflowActionRef!);

    return {
      workspaceId: repository.workspaceId,
      repositoryId: repository.id,
      githubRepositoryId: repository.githubRepositoryId.toString(),
      githubInstallationId:
        repository.installation.githubInstallationId.toString(),
      repository: repository.fullName,
      owner: repository.owner,
      selected: repository.selected,
      visibility: parseEligibleVisibility(repository.visibility),
      installationStatus: repository.installation.status,
      bindingId: binding.id,
      bindingRevision,
      authzEpoch: binding.pool.authzEpoch,
      workflowSchemaVersion: this.requiredWorkflowSchemaVersion,
      workflowSource,
      workflowJobSource: workflowJob.ref,
      workflowJobSha: workflowJob.sha,
      workflowAttestation: attestation,
      workflowPath: attestation.workflowPath,
      workflowSourceCommitSha: liveSource.commitSha,
      workflowSourceBlobSha: liveSource.blobSha,
      workflowContents: liveSource.contents,
      reviewRequestId: reviewRequest.requestId,
      providerInvocationKey: digest(authorityFacts),
      runtimeConfigVersion,
      runtimeEnv: mapConfigToRuntimeEnv(config),
      model: provider.model,
      policyFingerprint: digest({
        version: "hosted-codex-v1",
        ...authorityFacts,
      }),
    } satisfies HostedCodexGrantAdmission;
  }
}

function parseAttestation(
  binding: {
    readonly id: string;
    readonly revision: bigint;
    readonly workflowPath: string | null;
    readonly workflowActionRef: string | null;
    readonly workflowSourceCommitSha: string | null;
    readonly workflowSourceBlobSha: string | null;
    readonly workflowSourceSha256: string | null;
    readonly workflowSemanticSha256: string | null;
    readonly workflowSourceTrust: string | null;
  },
  githubRepositoryId: bigint,
): HostedPoolWorkflowSourceAttestation {
  if (
    !binding.workflowPath ||
    !binding.workflowActionRef ||
    !binding.workflowSourceCommitSha ||
    !binding.workflowSourceBlobSha ||
    !binding.workflowSourceSha256 ||
    !binding.workflowSemanticSha256 ||
    binding.workflowSourceTrust !== "trusted_default_branch_revision"
  ) {
    throw new Error("hosted_workflow_attestation_missing");
  }
  return {
    repositoryId: githubRepositoryId.toString(),
    workflowPath: binding.workflowPath,
    workflowSourceCommitSha: binding.workflowSourceCommitSha,
    workflowSourceBlobSha: binding.workflowSourceBlobSha,
    workflowSourceSha256: binding.workflowSourceSha256,
    workflowSemanticSha256: binding.workflowSemanticSha256,
    sourceTrust: "trusted_default_branch_revision",
    bindingId: binding.id,
    bindingRevision: toPositiveSafeNumber(
      binding.revision,
      "hosted_binding_revision_invalid",
    ),
  };
}

function hostedJobWorkflowIdentity(actionRef: string): {
  readonly ref: string;
  readonly sha: string;
} {
  const match = /^([^/]+\/[^@]+)@([a-f0-9]{40})$/iu.exec(actionRef);
  if (!match) throw new Error("hosted_workflow_action_ref_invalid");
  return {
    ref: `${match[1]}/.github/workflows/reviewrouter-execution-reusable.yml@${match[2]}`,
    sha: match[2]!.toLowerCase(),
  };
}

function parseEligibleVisibility(value: string): "private" | "internal" {
  if (value !== "private" && value !== "internal") {
    throw new Error("hosted_repository_visibility_ineligible");
  }
  return value;
}

function toPositiveSafeNumber(value: bigint, code: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(code);
  return number;
}

function digest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("hex");
}
