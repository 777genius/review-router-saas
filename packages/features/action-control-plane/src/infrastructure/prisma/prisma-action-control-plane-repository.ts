import type { PrismaClient } from "@prisma/client";
import {
  parseReviewConfiguration,
  type ReviewProviderConfiguration,
  safeDefaultReviewConfiguration,
} from "@reviewrouter/features-review-config";
import {
  getProviderCatalogEntry,
  providerAuthModeSchema,
  providerKindForAuthMode,
  providerKindSchema,
  type ProviderAuthMode,
} from "@reviewrouter/features-review-providers";
import type {
  ActionHealthReport,
  ActionRepositoryContext,
  ActionSessionClaims,
} from "../../domain/action-control-plane.js";
import type {
  ActionControlPlaneRepositoryPort,
  RuntimeReviewConfigurationRecord,
} from "../../application/ports/action-control-plane-repository-port.js";

export class PrismaActionControlPlaneRepository implements ActionControlPlaneRepositoryPort {
  constructor(private readonly prisma: PrismaClient) {}

  async findSelectedRepositoryByGithubId(
    githubRepositoryId: string,
  ): Promise<ActionRepositoryContext | null> {
    const repository = await this.prisma.repositoryConnection.findUnique({
      where: { githubRepositoryId: BigInt(githubRepositoryId) },
      select: {
        id: true,
        workspaceId: true,
        githubRepositoryId: true,
        fullName: true,
        owner: true,
        selected: true,
        workspace: {
          select: {
            orgRulesets: {
              where: { status: "configured" },
              select: {
                scope: true,
                sourceGithubRepositoryId: true,
                sourceRepositoryFullName: true,
                sourceWorkflowPath: true,
                sourceWorkflowRef: true,
                targetRepositoryIds: true,
              },
            },
          },
        },
        provisioning: {
          where: { workflowStyle: "reusable" },
          orderBy: { updatedAt: "desc" },
          take: 10,
          select: {
            actionVersion: true,
            workflowStyle: true,
          },
        },
        installation: {
          select: { status: true, githubInstallationId: true },
        },
      },
    });

    if (!repository) {
      return null;
    }

    return {
      workspaceId: repository.workspaceId,
      repositoryId: repository.id,
      githubRepositoryId: repository.githubRepositoryId.toString(),
      githubInstallationId:
        repository.installation.githubInstallationId.toString(),
      fullName: repository.fullName,
      owner: repository.owner,
      selected: repository.selected,
      trustedWorkflowRefs: [
        ...repository.workspace.orgRulesets
          .filter((ruleset) => {
            return orgRulesetTargetsRepository({
              scope: ruleset.scope,
              sourceGithubRepositoryId:
                ruleset.sourceGithubRepositoryId?.toString() ?? null,
              targetRepositoryIds: ruleset.targetRepositoryIds,
              githubRepositoryId: repository.githubRepositoryId.toString(),
            });
          })
          .flatMap((ruleset) => {
            if (!ruleset.sourceRepositoryFullName) return [];
            return [
              `${ruleset.sourceRepositoryFullName}/${ruleset.sourceWorkflowPath}@${ruleset.sourceWorkflowRef}`,
            ];
          }),
        ...buildTrustedReusableWorkflowRefs(repository.provisioning),
      ],
      installationStatus: repository.installation.status,
    };
  }

  async findRuntimeReviewConfiguration(input: {
    readonly workspaceId: string;
    readonly repositoryId: string;
  }): Promise<RuntimeReviewConfigurationRecord | null> {
    const repositoryConfig = await this.findLatestConfigVersion({
      workspaceId: input.workspaceId,
      targetKey: `repo:${input.repositoryId}`,
    });
    if (repositoryConfig) {
      return repositoryConfig;
    }

    return this.findLatestConfigVersion({
      workspaceId: input.workspaceId,
      targetKey: "workspace:default",
    });
  }

  async recordHealthReport(input: {
    readonly session: ActionSessionClaims;
    readonly report: ActionHealthReport;
    readonly receivedAt: Date;
  }): Promise<void> {
    const optionalData = {
      ...(input.report.safeErrorSummary
        ? { safeErrorSummary: input.report.safeErrorSummary }
        : {}),
      ...(input.report.startedAt
        ? { startedAt: new Date(input.report.startedAt) }
        : {}),
      ...(input.report.finishedAt
        ? { finishedAt: new Date(input.report.finishedAt) }
        : {}),
    };

    const data = {
      workspaceId: input.session.workspaceId,
      repositoryId: input.session.repositoryId,
      githubRunId: input.session.githubRunId,
      githubRunAttempt: input.session.githubRunAttempt,
      eventName: input.session.eventName,
      actionVersion: input.report.actionVersion,
      configVersion: input.report.configVersion,
      configSource: input.report.configSource ?? null,
      providerSetupState: input.report.providerSetupState,
      providerHealth: input.report.providerHealth,
      safeErrorCategory: input.report.safeErrorCategory,
      findingCriticalCount: input.report.findingCounts?.critical ?? null,
      findingMajorCount: input.report.findingCounts?.major ?? null,
      findingMinorCount: input.report.findingCounts?.minor ?? null,
      findingInfoCount: input.report.findingCounts?.info ?? null,
      inlineCommentCount: input.report.commentCounts?.inline ?? null,
      summaryCommentCount: input.report.commentCounts?.summary ?? null,
      skippedReasonCategory: input.report.skippedReasonCategory ?? null,
      receivedAt: input.receivedAt,
      ...optionalData,
    };

    await this.prisma.actionRunHealthReport.upsert({
      where: {
        repositoryId_githubRunId_githubRunAttempt: {
          repositoryId: input.session.repositoryId,
          githubRunId: input.session.githubRunId,
          githubRunAttempt: input.session.githubRunAttempt,
        },
      },
      update: {
        eventName: data.eventName,
        actionVersion: data.actionVersion,
        configVersion: data.configVersion,
        configSource: data.configSource,
        providerSetupState: data.providerSetupState,
        providerHealth: data.providerHealth,
        safeErrorCategory: data.safeErrorCategory,
        safeErrorSummary: data.safeErrorSummary ?? null,
        findingCriticalCount: data.findingCriticalCount,
        findingMajorCount: data.findingMajorCount,
        findingMinorCount: data.findingMinorCount,
        findingInfoCount: data.findingInfoCount,
        inlineCommentCount: data.inlineCommentCount,
        summaryCommentCount: data.summaryCommentCount,
        skippedReasonCategory: data.skippedReasonCategory,
        startedAt: data.startedAt ?? null,
        finishedAt: data.finishedAt ?? null,
        receivedAt: data.receivedAt,
      },
      create: {
        workspaceId: input.session.workspaceId,
        repositoryId: input.session.repositoryId,
        githubRunId: input.session.githubRunId,
        githubRunAttempt: input.session.githubRunAttempt,
        eventName: input.session.eventName,
        actionVersion: input.report.actionVersion,
        configVersion: input.report.configVersion,
        configSource: data.configSource,
        providerSetupState: input.report.providerSetupState,
        providerHealth: input.report.providerHealth,
        safeErrorCategory: input.report.safeErrorCategory,
        findingCriticalCount: data.findingCriticalCount,
        findingMajorCount: data.findingMajorCount,
        findingMinorCount: data.findingMinorCount,
        findingInfoCount: data.findingInfoCount,
        inlineCommentCount: data.inlineCommentCount,
        summaryCommentCount: data.summaryCommentCount,
        skippedReasonCategory: data.skippedReasonCategory,
        receivedAt: input.receivedAt,
        ...optionalData,
      },
    });
  }

  private async findLatestConfigVersion(input: {
    readonly workspaceId: string;
    readonly targetKey: string;
  }): Promise<RuntimeReviewConfigurationRecord | null> {
    const configuration = await this.prisma.reviewConfiguration.findUnique({
      where: {
        workspaceId_targetKey: {
          workspaceId: input.workspaceId,
          targetKey: input.targetKey,
        },
      },
      select: {
        versions: {
          orderBy: { version: "desc" },
          take: 1,
          select: {
            version: true,
            schemaVersion: true,
            providerKind: true,
            providerAuthMode: true,
            model: true,
            reasoningEffort: true,
            agenticContext: true,
            fastMode: true,
            failOnSeverity: true,
            inlineMaxComments: true,
            providerLimit: true,
            providerMaxParallel: true,
            inlineMinAgreement: true,
            targetTokensPerBatch: true,
            providers: {
              orderBy: { order: "asc" },
              select: {
                providerKind: true,
                providerAuthMode: true,
                model: true,
                reasoningEffort: true,
                agenticContext: true,
                fastMode: true,
              },
            },
          },
        },
      },
    });
    const version = configuration?.versions[0];
    if (!version) {
      return null;
    }

    const providers = version.providers.length
      ? version.providers.map(toReviewProviderConfiguration)
      : [toReviewProviderConfiguration(version)];

    return {
      version: version.version,
      config: parseReviewConfiguration({
        schemaVersion: 2,
        providers,
        provider: providers[0],
        execution: {
          providerLimit: version.providerLimit,
          providerMaxParallel: version.providerMaxParallel,
          inlineMinAgreement: version.inlineMinAgreement,
        },
        blockingPolicy: {
          failOnSeverity: toFailOnSeverity(version.failOnSeverity),
        },
        limits: {
          inlineMaxComments: version.inlineMaxComments,
          targetTokensPerBatch:
            version.targetTokensPerBatch ??
            safeDefaultReviewConfiguration.limits.targetTokensPerBatch,
        },
      }),
    };
  }
}

export function orgRulesetTargetsRepository(input: {
  readonly scope: string;
  readonly sourceGithubRepositoryId: string | null;
  readonly targetRepositoryIds: unknown;
  readonly githubRepositoryId: string;
}): boolean {
  if (input.sourceGithubRepositoryId === input.githubRepositoryId) {
    return false;
  }
  if (input.scope === "all_repositories") return true;
  return parseTargetRepositoryIds(input.targetRepositoryIds).includes(
    input.githubRepositoryId,
  );
}

function parseTargetRepositoryIds(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item : String(item)))
    .filter(Boolean);
}

function buildTrustedReusableWorkflowRefs(
  provisioningRows: readonly {
    readonly actionVersion: string;
    readonly workflowStyle: string;
  }[],
): readonly string[] {
  const refs = new Set<string>();
  for (const row of provisioningRows) {
    if (row.workflowStyle !== "reusable") continue;
    const ref = extractReviewRouterRuntimeGitRef(row.actionVersion);
    if (!ref) continue;
    refs.add(
      `777genius/review-router/.github/workflows/reviewrouter-reusable.yml@${ref}`,
    );
    refs.add(
      `777genius/review-router/.github/workflows/reviewrouter-interaction-reusable.yml@${ref}`,
    );
  }
  return [...refs];
}

function extractReviewRouterRuntimeGitRef(
  actionVersion: string,
): string | null {
  const match = /^777genius\/review-router@(.+)$/.exec(actionVersion);
  if (!match) return null;
  const ref = match[1] ?? "";
  if (ref === "main") {
    return "refs/heads/main";
  }
  if (ref === "v1" || /^v1\.[0-9]+\.[0-9]+$/.test(ref)) {
    return `refs/tags/${ref}`;
  }
  if (/^[a-fA-F0-9]{40}$/.test(ref)) {
    return ref;
  }
  return null;
}

function toReviewProviderConfiguration(input: {
  readonly providerKind: string;
  readonly providerAuthMode: string;
  readonly model: string;
  readonly reasoningEffort: string;
  readonly agenticContext: boolean;
  readonly fastMode: boolean;
}): ReviewProviderConfiguration {
  const authMode = toProviderAuthMode({
    providerAuthMode: input.providerAuthMode,
    providerKind: input.providerKind,
  });
  return {
    kind: providerKindForAuthMode(authMode),
    authMode,
    model: input.model,
    reasoningEffort: toReasoningEffort(input.reasoningEffort),
    agenticContext: input.agenticContext,
    fastMode: input.fastMode,
  };
}

function toProviderAuthMode(input: {
  readonly providerAuthMode: string;
  readonly providerKind: string;
}): ProviderAuthMode {
  const authMode = providerAuthModeSchema.safeParse(input.providerAuthMode);
  if (authMode.success) {
    return authMode.data;
  }

  const kind = providerKindSchema.safeParse(input.providerKind);
  if (kind.success) {
    return getProviderCatalogEntry(kind.data).defaultAuthMode;
  }

  return safeDefaultReviewConfiguration.provider.authMode;
}

function toReasoningEffort(value: string) {
  switch (value) {
    case "low":
    case "medium":
    case "high":
    case "xhigh":
      return value;
    default:
      return "medium";
  }
}

function toFailOnSeverity(value: string) {
  switch (value) {
    case "off":
    case "critical":
    case "major":
      return value;
    default:
      return "critical";
  }
}
