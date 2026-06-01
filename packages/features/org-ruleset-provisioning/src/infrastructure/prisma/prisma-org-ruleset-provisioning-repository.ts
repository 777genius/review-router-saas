import type { PrismaClient } from "@prisma/client";
import { buildSourceWorkflowRef } from "../../domain/org-ruleset-provisioning";
import type {
  OrgRulesetProvisioningRecord,
  OrgRulesetProvisioningRepositoryPort,
} from "../../application/ports/org-ruleset-provisioning-repository-port";
import type {
  OrgRulesetProvisioningRequest,
  OrgRulesetProvisioningTarget,
} from "../../domain/org-ruleset-provisioning";

export class PrismaOrgRulesetProvisioningRepository implements OrgRulesetProvisioningRepositoryPort {
  constructor(private readonly prisma: PrismaClient) {}

  async findTargetByInstallation(input: {
    readonly workspaceId: string;
    readonly githubInstallationId: string;
  }): Promise<OrgRulesetProvisioningTarget | null> {
    const installation = await this.prisma.gitHubInstallation.findUnique({
      where: { githubInstallationId: BigInt(input.githubInstallationId) },
      select: {
        id: true,
        workspaceId: true,
        githubInstallationId: true,
        accountLogin: true,
        accountType: true,
        repositorySelection: true,
        status: true,
        repositories: {
          where: {
            provider: "github",
            githubRepositoryId: { not: null },
          },
          orderBy: { fullName: "asc" },
          select: {
            id: true,
            githubRepositoryId: true,
            owner: true,
            name: true,
            fullName: true,
            defaultBranch: true,
            selected: true,
            archived: true,
            visibility: true,
          },
        },
      },
    });

    if (!installation || installation.workspaceId !== input.workspaceId) {
      return null;
    }

    return {
      workspaceId: installation.workspaceId,
      installationId: installation.id,
      githubInstallationId: installation.githubInstallationId.toString(),
      organizationLogin: installation.accountLogin,
      accountType: installation.accountType,
      installationStatus: installation.status,
      repositorySelection: installation.repositorySelection,
      repositories: installation.repositories.flatMap((repository) =>
        repository.githubRepositoryId
          ? [
              {
                ...repository,
                githubRepositoryId: repository.githubRepositoryId.toString(),
              },
            ]
          : [],
      ),
    };
  }

  async findById(id: string): Promise<OrgRulesetProvisioningRecord | null> {
    const record = await this.prisma.orgRulesetProvisioning.findUnique({
      where: { id },
    });
    return record ? toRecord(record) : null;
  }

  async findByWorkspaceId(
    workspaceId: string,
  ): Promise<OrgRulesetProvisioningRecord | null> {
    const record = await this.prisma.orgRulesetProvisioning.findUnique({
      where: { workspaceId },
    });
    return record ? toRecord(record) : null;
  }

  async listConfiguredTrustedWorkflows(input: {
    readonly workspaceId: string;
    readonly githubRepositoryId: string;
  }): Promise<readonly string[]> {
    const rows = await this.prisma.orgRulesetProvisioning.findMany({
      where: { workspaceId: input.workspaceId, status: "configured" },
      select: {
        scope: true,
        sourceGithubRepositoryId: true,
        sourceRepositoryFullName: true,
        sourceWorkflowPath: true,
        sourceWorkflowRef: true,
        targetRepositoryIds: true,
      },
    });

    return rows
      .filter((row) => {
        if (
          row.sourceGithubRepositoryId?.toString() === input.githubRepositoryId
        ) {
          return false;
        }
        if (row.scope === "all_repositories") return true;
        return parseTargetRepositoryIds(row.targetRepositoryIds).includes(
          input.githubRepositoryId,
        );
      })
      .flatMap((row) => {
        if (!row.sourceRepositoryFullName) return [];
        return [
          buildSourceWorkflowRef({
            repositoryFullName: row.sourceRepositoryFullName,
            path: row.sourceWorkflowPath,
            ref: row.sourceWorkflowRef,
          }),
        ];
      });
  }

  async upsertRequested(
    request: OrgRulesetProvisioningRequest,
  ): Promise<OrgRulesetProvisioningRecord> {
    const data = {
      installationId: request.installationId,
      githubInstallationId: BigInt(request.githubInstallationId),
      organizationLogin: request.organizationLogin,
      status: "requested" as const,
      scope: request.scope,
      enforcement: request.enforcement,
      sourceRepositoryId: request.sourceRepositoryId ?? null,
      sourceGithubRepositoryId: request.sourceGithubRepositoryId
        ? BigInt(request.sourceGithubRepositoryId)
        : null,
      sourceRepositoryFullName: request.sourceRepositoryFullName ?? null,
      sourceWorkflowPath: request.sourceWorkflowPath,
      sourceWorkflowRef: request.sourceWorkflowRef,
      sourceWorkflowSha: null,
      rulesetId: null,
      rulesetUrl: null,
      targetRepositoryIds: [...request.targetRepositoryIds],
      safeErrorCode: null,
      safeErrorSummary: null,
      requestedBy: request.requestedBy,
      requestedAt: request.requestedAt,
      lastAttemptAt: null,
      configuredAt: null,
    };
    const record = await this.prisma.orgRulesetProvisioning.upsert({
      where: { workspaceId: request.workspaceId },
      create: { workspaceId: request.workspaceId, ...data },
      update: data,
    });
    return toRecord(record);
  }

  async markProcessing(input: {
    readonly id: string;
    readonly attemptedAt: Date;
  }): Promise<void> {
    await this.prisma.orgRulesetProvisioning.update({
      where: { id: input.id },
      data: {
        status: "processing",
        lastAttemptAt: input.attemptedAt,
        safeErrorCode: null,
        safeErrorSummary: null,
      },
    });
  }

  async markConfigured(input: {
    readonly id: string;
    readonly sourceWorkflowSha: string | null;
    readonly rulesetId: string;
    readonly rulesetUrl: string | null;
    readonly configuredAt: Date;
  }): Promise<void> {
    await this.prisma.orgRulesetProvisioning.update({
      where: { id: input.id },
      data: {
        status: "configured",
        sourceWorkflowSha: input.sourceWorkflowSha,
        rulesetId: BigInt(input.rulesetId),
        rulesetUrl: input.rulesetUrl,
        configuredAt: input.configuredAt,
        safeErrorCode: null,
        safeErrorSummary: null,
      },
    });
  }

  async markFailed(input: {
    readonly id: string;
    readonly safeErrorCode: string;
    readonly safeErrorSummary: string;
  }): Promise<void> {
    await this.prisma.orgRulesetProvisioning.update({
      where: { id: input.id },
      data: {
        status: "failed",
        safeErrorCode: input.safeErrorCode,
        safeErrorSummary: input.safeErrorSummary,
      },
    });
  }
}

type OrgRulesetProvisioningRow = Awaited<
  ReturnType<PrismaClient["orgRulesetProvisioning"]["findUnique"]>
>;

function toRecord(
  record: NonNullable<OrgRulesetProvisioningRow>,
): OrgRulesetProvisioningRecord {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    installationId: record.installationId,
    githubInstallationId: record.githubInstallationId.toString(),
    organizationLogin: record.organizationLogin,
    status: record.status,
    scope: record.scope,
    enforcement: record.enforcement,
    sourceRepositoryId: record.sourceRepositoryId,
    sourceGithubRepositoryId:
      record.sourceGithubRepositoryId?.toString() ?? null,
    sourceRepositoryFullName: record.sourceRepositoryFullName,
    sourceWorkflowPath: record.sourceWorkflowPath,
    sourceWorkflowRef: record.sourceWorkflowRef,
    sourceWorkflowSha: record.sourceWorkflowSha,
    rulesetId: record.rulesetId?.toString() ?? null,
    rulesetUrl: record.rulesetUrl,
    targetRepositoryIds: parseTargetRepositoryIds(record.targetRepositoryIds),
    safeErrorCode: record.safeErrorCode,
    safeErrorSummary: record.safeErrorSummary,
    requestedBy: record.requestedBy,
    requestedAt: record.requestedAt,
    lastAttemptAt: record.lastAttemptAt,
    configuredAt: record.configuredAt,
    updatedAt: record.updatedAt,
  };
}

function parseTargetRepositoryIds(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item : String(item)))
    .filter(Boolean);
}
