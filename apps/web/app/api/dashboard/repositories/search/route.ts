import { NextResponse, type NextRequest } from "next/server";
import {
  listWorkspaceRepositoryHealth,
  PrismaRepositoryHealthRepository,
} from "@reviewrouter/features-repo-health";
import { resolveReviewRouterActionRef } from "@reviewrouter/platform-config";
import { getDashboardWorkspaceScope } from "../../../../../src/server/dashboard-mutations";
import { getPrisma } from "../../../../../src/server/prisma";
import {
  buildRepositorySearchText,
  repositoryMatchesSearchFilter,
  repositorySetupProgressStep,
  tokenizeRepositorySearch,
  type RepositorySearchFilter,
  workflowSetupAlreadyCurrent,
} from "../../../../../src/server/repository-search";

export const dynamic = "force-dynamic";

type WorkspaceCandidate = {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly installations: readonly { readonly accountLogin: string }[];
};

export async function GET(request: NextRequest): Promise<NextResponse> {
  const scope = await getDashboardWorkspaceScope();
  if (scope.kind === "none") {
    return NextResponse.json({ error: "sign_in_required" }, { status: 401 });
  }

  const workspaceKey = normalizeKey(
    request.nextUrl.searchParams.get("workspace") ?? "",
  );
  const query = normalizeQuery(request.nextUrl.searchParams.get("q") ?? "");
  const filter = readRepositorySearchFilter(request.nextUrl.searchParams);
  const prisma = getPrisma();
  const workspaceWhere =
    scope.kind === "workspace_ids"
      ? { id: { in: [...scope.workspaceIds] } }
      : undefined;
  const candidates = await prisma.workspace.findMany({
    ...(workspaceWhere ? { where: workspaceWhere } : {}),
    orderBy: { createdAt: "desc" },
    take: 50,
    select: {
      id: true,
      slug: true,
      name: true,
      installations: {
        select: { accountLogin: true },
        orderBy: { updatedAt: "desc" },
        take: 5,
      },
    },
  });
  const workspace = selectWorkspace(candidates, workspaceKey);
  if (!workspace) {
    return NextResponse.json({ error: "workspace_not_found" }, { status: 404 });
  }

  const repositories = await prisma.repositoryConnection.findMany({
    where: { workspaceId: workspace.id },
    orderBy: [{ selected: "desc" }, { fullName: "asc" }],
    select: {
      id: true,
      fullName: true,
      owner: true,
      name: true,
      defaultBranch: true,
      visibility: true,
      setupStatus: true,
      selected: true,
      archived: true,
      stargazersCount: true,
    },
  });
  const [health, providerSetup] = await Promise.all([
    listWorkspaceRepositoryHealth(
      {
        workspaceId: workspace.id,
        expectedActionRef: resolveReviewRouterActionRef(),
        workflowProbeMaxRepositories: 0,
      },
      { repositories: new PrismaRepositoryHealthRepository(prisma) },
    ),
    prisma.providerSetupState.findMany({
      where: {
        workspaceId: workspace.id,
        repositoryId: {
          in: repositories.map((repository) => repository.id),
        },
      },
      select: {
        repositoryId: true,
        state: true,
        updatedAt: true,
      },
    }),
  ]);
  const repositoryHealthById = new Map(
    health.map((item) => [item.repositoryId, item] as const),
  );
  const configuredProviderSetupByRepositoryId = new Map<
    string,
    { readonly updatedAt: Date }
  >();
  for (const item of providerSetup) {
    if (!item.repositoryId || item.state !== "configured") continue;

    const existing = configuredProviderSetupByRepositoryId.get(
      item.repositoryId,
    );
    if (!existing || existing.updatedAt < item.updatedAt) {
      configuredProviderSetupByRepositoryId.set(item.repositoryId, {
        updatedAt: item.updatedAt,
      });
    }
  }

  const tokens = tokenizeRepositorySearch(query);
  const repositoryIds = repositories
    .filter((repository) => {
      const repositoryHealth = repositoryHealthById.get(repository.id);
      const workflowCurrent = workflowSetupAlreadyCurrent(
        repositoryHealth?.status,
      );
      const providerSetupConfirmedAt =
        configuredProviderSetupByRepositoryId.get(repository.id)?.updatedAt;
      const providerSetupConfirmed =
        providerSetupConfirmedAt !== undefined &&
        (!repositoryHealth?.latestActionHealthReceivedAt ||
          providerSetupConfirmedAt >=
            repositoryHealth.latestActionHealthReceivedAt);
      const setupProgressStep = repositorySetupProgressStep({
        setupStatus: repository.setupStatus,
        healthStatus: repositoryHealth?.status,
        workflowCurrent,
        providerSetupConfirmed,
      });
      if (
        !repositoryMatchesSearchFilter(
          { repository, setupProgressStep },
          filter,
        )
      ) {
        return false;
      }
      if (tokens.length === 0) return true;
      const searchable = buildRepositorySearchText({
        fullName: repository.fullName,
        owner: repository.owner,
        name: repository.name,
        defaultBranch: repository.defaultBranch,
        visibility: repository.visibility,
        stargazersCount: repository.stargazersCount,
        archived: repository.archived,
        selected: repository.selected,
        setupStatus: repository.setupStatus,
        healthStatus: repositoryHealth?.status,
        healthSummary: repositoryHealth?.summary,
      });
      return tokens.every((token) => searchable.includes(token));
    })
    .map((repository) => repository.id);

  return NextResponse.json({
    repositoryIds,
    total: repositories.length,
    query,
    filter,
  });
}

function readRepositorySearchFilter(
  params: URLSearchParams,
): RepositorySearchFilter {
  const setup = params.get("setup");
  if (setup === "needed") return "needs_setup";
  if (setup === "ready") return "ready";

  const visibility = params.get("visibility");
  if (visibility === "private" || visibility === "public") {
    return visibility;
  }

  return "all";
}

function selectWorkspace(
  candidates: readonly WorkspaceCandidate[],
  workspaceKey: string,
): WorkspaceCandidate | null {
  if (candidates.length === 0) return null;
  if (!workspaceKey) return candidates[0] ?? null;
  return (
    candidates.find((workspace) =>
      workspaceKeys(workspace).includes(workspaceKey),
    ) ?? null
  );
}

function workspaceKeys(workspace: WorkspaceCandidate): string[] {
  return [
    workspace.id,
    workspace.slug,
    workspace.name,
    ...workspace.installations.map((installation) => installation.accountLogin),
  ]
    .filter(Boolean)
    .map(normalizeKey);
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeQuery(value: string): string {
  return value.trim().slice(0, 120);
}
