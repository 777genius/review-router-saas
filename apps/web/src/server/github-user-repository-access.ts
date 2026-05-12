import type { PrismaClient } from "@reviewrouter/platform-db";
import {
  getValidGitHubUserAccessToken,
  revokeGitHubUserAuthorization,
} from "./github-user-authorization";

const repositoryAccessCacheTtlMs = 15 * 60 * 1000;
const githubApiBaseUrl = "https://api.github.com";
const githubApiVersion = "2022-11-28";

export type GitHubUserRepositoryAccessStatus =
  | "ready"
  | "token_missing"
  | "token_revoked"
  | "token_expired"
  | "token_refresh_failed"
  | "token_decryption_failed"
  | "token_encryption_misconfigured"
  | "github_error";

export type GitHubUserRepositoryAccessScope = {
  readonly status: GitHubUserRepositoryAccessStatus;
  readonly workspaceIds: readonly string[];
  readonly repositoryIds: ReadonlySet<string>;
  readonly checkedAt: Date | null;
  readonly errorCode?: string;
};

export type GitHubUserRepositoryAccessActor = {
  readonly userId: string;
  readonly githubUserId: string;
  readonly githubLogin: string;
};

type FetchLike = typeof fetch;
type RepositoryAccessEnvironment = {
  readonly [key: string]: string | undefined;
};

type GitHubUserInstallation = {
  readonly id: number | string;
};

type GitHubUserRepository = {
  readonly id: number | string;
  readonly permissions?: {
    readonly admin?: boolean;
    readonly maintain?: boolean;
    readonly push?: boolean;
    readonly pull?: boolean;
  };
};

export async function listGitHubUserRepositoryAccess(input: {
  readonly prisma: PrismaClient;
  readonly actor: GitHubUserRepositoryAccessActor;
  readonly excludedWorkspaceIds?: readonly string[];
  readonly env?: RepositoryAccessEnvironment;
  readonly now?: Date;
  readonly fetch?: FetchLike;
}): Promise<GitHubUserRepositoryAccessScope> {
  const now = input.now ?? new Date();
  const cached = await readFreshRepositoryPermissionCache({
    prisma: input.prisma,
    userId: input.actor.userId,
    excludedWorkspaceIds: input.excludedWorkspaceIds ?? [],
    now,
  });
  if (cached.checkedAt) {
    return {
      status: "ready",
      workspaceIds: cached.workspaceIds,
      repositoryIds: cached.repositoryIds,
      checkedAt: cached.checkedAt,
    };
  }

  const refreshed = await refreshGitHubUserRepositoryAccess(input);
  if (refreshed.status !== "ready") return refreshed;

  return {
    status: "ready",
    ...(await readFreshRepositoryPermissionCache({
      prisma: input.prisma,
      userId: input.actor.userId,
      excludedWorkspaceIds: input.excludedWorkspaceIds ?? [],
      now,
    })),
  };
}

export async function refreshGitHubUserRepositoryAccess(input: {
  readonly prisma: PrismaClient;
  readonly actor: GitHubUserRepositoryAccessActor;
  readonly excludedWorkspaceIds?: readonly string[];
  readonly env?: RepositoryAccessEnvironment;
  readonly now?: Date;
  readonly fetch?: FetchLike;
}): Promise<GitHubUserRepositoryAccessScope> {
  const now = input.now ?? new Date();
  const token = await getValidGitHubUserAccessToken({
    prisma: input.prisma,
    userId: input.actor.userId,
    now,
    ...(input.env ? { env: input.env } : {}),
    ...(input.fetch ? { fetch: input.fetch } : {}),
  });
  if (token.status !== "ready") {
    return emptyGitHubUserRepositoryAccess({
      status: userTokenStatusToRepositoryAccessStatus(token.status),
      ...(token.errorCode ? { errorCode: token.errorCode } : {}),
    });
  }

  try {
    const userInstallations = await listUserInstallations({
      accessToken: token.accessToken,
      fetch: input.fetch ?? fetch,
    });
    const installationIds = userInstallations.map((installation) =>
      BigInt(installation.id),
    );
    const activeInstallations =
      installationIds.length > 0
        ? await input.prisma.gitHubInstallation.findMany({
            where: {
              githubInstallationId: { in: installationIds },
              status: "active",
              ...(input.excludedWorkspaceIds &&
              input.excludedWorkspaceIds.length > 0
                ? { workspaceId: { notIn: [...input.excludedWorkspaceIds] } }
                : {}),
            },
            select: {
              githubInstallationId: true,
            },
          })
        : [];
    const activeInstallationIds = new Set(
      activeInstallations.map((installation) =>
        installation.githubInstallationId.toString(),
      ),
    );
    const repositoryEntries: {
      readonly githubInstallationId: bigint;
      readonly githubRepositoryId: bigint;
      readonly permission: string | null;
      readonly canManage: boolean;
    }[] = [];

    for (const installation of userInstallations) {
      const installationId = installation.id.toString();
      if (!activeInstallationIds.has(installationId)) continue;

      const repositories = await listUserInstallationRepositories({
        installationId,
        accessToken: token.accessToken,
        fetch: input.fetch ?? fetch,
      });
      for (const repository of repositories) {
        const permission = repositoryPermissionFromGitHub(repository);
        repositoryEntries.push({
          githubInstallationId: BigInt(installationId),
          githubRepositoryId: BigInt(repository.id),
          permission,
          canManage: repositoryPermissionAllowsDashboardMutation(permission),
        });
      }
    }

    const connectedRepositories =
      repositoryEntries.length > 0
        ? await input.prisma.repositoryConnection.findMany({
            where: {
              githubRepositoryId: {
                in: repositoryEntries.map((entry) => entry.githubRepositoryId),
              },
              selected: true,
              archived: false,
              installation: {
                status: "active",
              },
            },
            select: {
              id: true,
              githubRepositoryId: true,
              installation: {
                select: {
                  githubInstallationId: true,
                },
              },
            },
          })
        : [];
    const connectedByKey = new Map(
      connectedRepositories.map((repository) => [
        repositoryAccessEntryKey({
          githubInstallationId: repository.installation.githubInstallationId,
          githubRepositoryId: repository.githubRepositoryId,
        }),
        repository,
      ]),
    );
    const checkedAt = now;
    const expiresAt = new Date(now.getTime() + repositoryAccessCacheTtlMs);
    const cacheRows = repositoryEntries.flatMap((entry) => {
      const repository = connectedByKey.get(repositoryAccessEntryKey(entry));
      if (!repository) return [];

      return [
        {
          userId: input.actor.userId,
          repositoryId: repository.id,
          githubInstallationId: entry.githubInstallationId,
          permission: entry.permission,
          roleName: null,
          canManage: entry.canManage,
          checkedAt,
          expiresAt,
        },
      ];
    });

    await input.prisma.$transaction([
      input.prisma.repositoryPermissionCache.deleteMany({
        where: { userId: input.actor.userId },
      }),
      ...(cacheRows.length > 0
        ? [
            input.prisma.repositoryPermissionCache.createMany({
              data: cacheRows,
              skipDuplicates: true,
            }),
          ]
        : []),
    ]);

    return {
      status: "ready",
      ...(await readFreshRepositoryPermissionCache({
        prisma: input.prisma,
        userId: input.actor.userId,
        excludedWorkspaceIds: input.excludedWorkspaceIds ?? [],
        now,
      })),
    };
  } catch (error) {
    const status = githubUserApiStatus(error);
    if (status === 401) {
      await revokeGitHubUserAuthorization({
        prisma: input.prisma,
        githubUserId: input.actor.githubUserId,
        errorCode: "github_user_token_bad_credentials",
        ...(input.env ? { env: input.env } : {}),
      });
      return emptyGitHubUserRepositoryAccess({
        status: "token_revoked",
        errorCode: "github_user_token_bad_credentials",
      });
    }

    return emptyGitHubUserRepositoryAccess({
      status: "github_error",
      errorCode: status ? `github_user_api_${status}` : "github_user_api_error",
    });
  }
}

export async function updateRepositoryPermissionCacheFromLiveCheck(input: {
  readonly prisma: PrismaClient;
  readonly actor: GitHubUserRepositoryAccessActor;
  readonly repositoryId: string;
  readonly githubInstallationId: string | bigint | number;
  readonly permission: string;
  readonly roleName: string;
  readonly canManage: boolean;
  readonly now?: Date;
}): Promise<void> {
  const now = input.now ?? new Date();
  await input.prisma.repositoryPermissionCache.upsert({
    where: {
      userId_repositoryId: {
        userId: input.actor.userId,
        repositoryId: input.repositoryId,
      },
    },
    update: {
      githubInstallationId: BigInt(input.githubInstallationId),
      permission: input.permission || null,
      roleName: input.roleName || null,
      canManage: input.canManage,
      checkedAt: now,
      expiresAt: new Date(now.getTime() + repositoryAccessCacheTtlMs),
    },
    create: {
      userId: input.actor.userId,
      repositoryId: input.repositoryId,
      githubInstallationId: BigInt(input.githubInstallationId),
      permission: input.permission || null,
      roleName: input.roleName || null,
      canManage: input.canManage,
      checkedAt: now,
      expiresAt: new Date(now.getTime() + repositoryAccessCacheTtlMs),
    },
  });
}

export function repositoryPermissionAllowsDashboardMutation(
  permission: string | null,
): boolean {
  return (
    permission === "admin" ||
    permission === "maintain" ||
    permission === "write"
  );
}

function repositoryPermissionFromGitHub(
  repository: GitHubUserRepository,
): string | null {
  if (repository.permissions?.admin) return "admin";
  if (repository.permissions?.maintain) return "maintain";
  if (repository.permissions?.push) return "write";
  if (repository.permissions?.pull) return "read";
  return null;
}

async function readFreshRepositoryPermissionCache(input: {
  readonly prisma: PrismaClient;
  readonly userId: string;
  readonly excludedWorkspaceIds: readonly string[];
  readonly now: Date;
}): Promise<{
  readonly workspaceIds: readonly string[];
  readonly repositoryIds: ReadonlySet<string>;
  readonly checkedAt: Date | null;
}> {
  const freshRows = await input.prisma.repositoryPermissionCache.findMany({
    where: {
      userId: input.userId,
      expiresAt: { gt: input.now },
      repository: {
        selected: true,
        archived: false,
        installation: { status: "active" },
        ...(input.excludedWorkspaceIds.length > 0
          ? { workspaceId: { notIn: [...input.excludedWorkspaceIds] } }
          : {}),
      },
    },
    orderBy: { checkedAt: "desc" },
    select: {
      checkedAt: true,
      canManage: true,
      repositoryId: true,
      repository: {
        select: {
          workspaceId: true,
        },
      },
    },
  });
  const checkedAt = freshRows[0]?.checkedAt ?? null;
  const manageableRows = freshRows.filter((row) => row.canManage);
  const repositoryIds = new Set(manageableRows.map((row) => row.repositoryId));
  const workspaceIds = [
    ...new Set(manageableRows.map((row) => row.repository.workspaceId)),
  ];

  return { workspaceIds, repositoryIds, checkedAt };
}

async function listUserInstallations(input: {
  readonly accessToken: string;
  readonly fetch: FetchLike;
}): Promise<readonly GitHubUserInstallation[]> {
  const installations: GitHubUserInstallation[] = [];
  for (let page = 1; ; page += 1) {
    const payload = await fetchGitHubUserJson<{
      readonly installations?: readonly GitHubUserInstallation[];
    }>({
      path: "/user/installations",
      page,
      accessToken: input.accessToken,
      fetch: input.fetch,
    });
    const pageItems = payload.installations ?? [];
    installations.push(...pageItems);
    if (pageItems.length < 100) break;
  }

  return installations;
}

async function listUserInstallationRepositories(input: {
  readonly installationId: string;
  readonly accessToken: string;
  readonly fetch: FetchLike;
}): Promise<readonly GitHubUserRepository[]> {
  const repositories: GitHubUserRepository[] = [];
  for (let page = 1; ; page += 1) {
    const payload = await fetchGitHubUserJson<{
      readonly repositories?: readonly GitHubUserRepository[];
    }>({
      path: `/user/installations/${input.installationId}/repositories`,
      page,
      accessToken: input.accessToken,
      fetch: input.fetch,
    });
    const pageItems = payload.repositories ?? [];
    repositories.push(...pageItems);
    if (pageItems.length < 100) break;
  }

  return repositories;
}

async function fetchGitHubUserJson<T>(input: {
  readonly path: string;
  readonly page: number;
  readonly accessToken: string;
  readonly fetch: FetchLike;
}): Promise<T> {
  const url = new URL(input.path, githubApiBaseUrl);
  url.searchParams.set("per_page", "100");
  url.searchParams.set("page", String(input.page));

  const response = await input.fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${input.accessToken}`,
      "X-GitHub-Api-Version": githubApiVersion,
    },
  });
  if (!response.ok) {
    throw new GitHubUserApiError(response.status);
  }

  return (await response.json()) as T;
}

function userTokenStatusToRepositoryAccessStatus(
  status: Exclude<
    Awaited<ReturnType<typeof getValidGitHubUserAccessToken>>["status"],
    "ready"
  >,
): GitHubUserRepositoryAccessStatus {
  if (status === "missing") return "token_missing";
  if (status === "revoked") return "token_revoked";
  if (status === "expired") return "token_expired";
  if (status === "refresh_failed") return "token_refresh_failed";
  if (status === "token_decryption_failed") return "token_decryption_failed";
  return "token_encryption_misconfigured";
}

function emptyGitHubUserRepositoryAccess(input: {
  readonly status: GitHubUserRepositoryAccessStatus;
  readonly errorCode?: string;
}): GitHubUserRepositoryAccessScope {
  return {
    status: input.status,
    workspaceIds: [],
    repositoryIds: new Set<string>(),
    checkedAt: null,
    ...(input.errorCode ? { errorCode: input.errorCode } : {}),
  };
}

function repositoryAccessEntryKey(input: {
  readonly githubInstallationId: bigint;
  readonly githubRepositoryId: bigint;
}): string {
  return `${input.githubInstallationId.toString()}:${input.githubRepositoryId.toString()}`;
}

function githubUserApiStatus(error: unknown): number | null {
  if (error instanceof GitHubUserApiError) return error.status;
  return null;
}

class GitHubUserApiError extends Error {
  constructor(readonly status: number) {
    super(`github_user_api_error:${status}`);
  }
}
