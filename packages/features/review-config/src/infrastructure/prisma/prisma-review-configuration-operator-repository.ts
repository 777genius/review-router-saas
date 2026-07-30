import type { PrismaClient } from "@prisma/client";
import type { ScmProvider } from "@reviewrouter/shared";
import type {
  ReviewConfigurationOperatorRepository,
  ReviewConfigurationOperatorRepositoryPort,
} from "../../application/ports/review-configuration-operator-ports";

export class PrismaReviewConfigurationOperatorRepository implements ReviewConfigurationOperatorRepositoryPort {
  constructor(private readonly prisma: PrismaClient) {}

  async findActiveCandidates(
    input: Parameters<
      ReviewConfigurationOperatorRepositoryPort["findActiveCandidates"]
    >[0],
  ): Promise<readonly ReviewConfigurationOperatorRepository[]> {
    const records = await this.prisma.repositoryConnection.findMany({
      where: {
        provider: input.provider,
        fullName: { equals: input.repositoryFullName, mode: "insensitive" },
        ...(input.sourceBaseUrl
          ? {
              sourceBaseUrl: {
                equals: input.sourceBaseUrl,
                mode: "insensitive",
              },
            }
          : {}),
        selected: true,
        archived: false,
        ...activeInstallationFilter(input.provider),
        ...(input.workspace
          ? {
              workspace: {
                OR: [
                  { id: { equals: input.workspace, mode: "insensitive" } },
                  { slug: { equals: input.workspace, mode: "insensitive" } },
                ],
              },
            }
          : {}),
      },
      select: {
        id: true,
        workspaceId: true,
        provider: true,
        sourceBaseUrl: true,
        fullName: true,
        workspace: {
          select: {
            id: true,
            slug: true,
          },
        },
      },
      take: 2,
    });
    return records.map((record) => ({
      id: record.id,
      workspaceId: record.workspaceId,
      workspaceSlug: record.workspace.slug,
      provider: record.provider,
      sourceBaseUrl: record.sourceBaseUrl,
      fullName: record.fullName,
    }));
  }
}

function activeInstallationFilter(provider: ScmProvider) {
  switch (provider) {
    case "github":
      return { installation: { status: "active" as const } };
    case "gitlab":
      return { gitlabInstallation: { status: "active" as const } };
    default:
      return assertNever(provider);
  }
}

function assertNever(value: never): never {
  throw new Error(`unsupported_scm_provider:${String(value)}`);
}
