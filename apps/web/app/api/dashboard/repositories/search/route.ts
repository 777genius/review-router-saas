import { NextResponse, type NextRequest } from "next/server";
import { getDashboardWorkspaceScope } from "../../../../../src/server/dashboard-mutations";
import { getPrisma } from "../../../../../src/server/prisma";

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

  const tokens = tokenize(query);
  const repositoryIds = repositories
    .filter((repository) => {
      if (tokens.length === 0) return true;
      const searchable = [
        repository.fullName,
        repository.owner,
        repository.name,
        repository.defaultBranch,
        repository.visibility,
        repository.setupStatus,
        `${repository.stargazersCount} stars`,
        repository.selected ? "selected" : "not selected unselected",
        repository.archived ? "archived" : "active",
      ]
        .join(" ")
        .toLowerCase();
      return tokens.every((token) => searchable.includes(token));
    })
    .map((repository) => repository.id);

  return NextResponse.json({
    repositoryIds,
    total: repositories.length,
    query,
  });
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

function tokenize(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}
