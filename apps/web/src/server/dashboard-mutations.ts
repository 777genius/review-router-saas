import { App } from "@octokit/app";
import { getServerSession } from "next-auth";
import {
  assertWorkspaceMutationAllowed,
  listVisibleWorkspaceScope,
  PrismaWorkspaceAccessRepository,
  type VisibleWorkspaceScope,
} from "@reviewrouter/features-auth";
import { requireGitHubAppPrivateKey } from "@reviewrouter/platform-config";
import { getAuthEnvironmentStatus } from "../auth/auth-env";
import { authOptions } from "../auth/auth-options";
import {
  repositoryPermissionAllowsCapability,
  repositoryPermissionAllowsRepoManagement,
  type DashboardRepositoryCapability,
} from "./dashboard-access-policy";
import { getValidGitHubUserAccessToken } from "./github-user-authorization";
import { updateRepositoryPermissionCacheFromLiveCheck } from "./github-user-repository-access";
import { getPrisma } from "./prisma";

export type DashboardMutationActor = {
  readonly userId: string;
  readonly githubUserId: string;
  readonly githubLogin: string;
  readonly actor: string;
  readonly accessSource?: DashboardMutationAccessSource;
};

export type DashboardMutationAccessSource =
  | { readonly source: "workspace_admin" }
  | {
      readonly source: "repo_manager";
      readonly capability: DashboardRepositoryCapability;
      readonly permission: string | null;
      readonly roleName: string | null;
    };

export type DashboardMutationStatus = {
  readonly enabled: boolean;
  readonly signedIn: boolean;
  readonly githubLogin: string | null;
  readonly githubAvatarUrl: string | null;
  readonly reason: "ready" | "disabled" | "signed_out" | "auth_misconfigured";
};

export type DashboardWorkspaceScope =
  | { readonly kind: "none"; readonly reason: "signed_out" }
  | VisibleWorkspaceScope;

type GitHubRequester = {
  request: (
    route: string,
    parameters?: Record<string, unknown>,
  ) => Promise<{ data: unknown }>;
};

export async function getDashboardMutationStatus(): Promise<DashboardMutationStatus> {
  if (!getAuthEnvironmentStatus().configured) {
    return {
      enabled: false,
      signedIn: false,
      githubLogin: null,
      githubAvatarUrl: null,
      reason: "auth_misconfigured",
    };
  }

  const session = await getServerSession(authOptions);
  const signedIn = Boolean(
    session?.user?.githubUserId && session.user.githubLogin,
  );
  if (!dashboardMutationsEnabled()) {
    return {
      enabled: false,
      signedIn,
      githubLogin: session?.user?.githubLogin ?? null,
      githubAvatarUrl: session?.user?.githubAvatarUrl ?? null,
      reason: "disabled",
    };
  }
  if (!signedIn) {
    return {
      enabled: false,
      signedIn: false,
      githubLogin: null,
      githubAvatarUrl: null,
      reason: "signed_out",
    };
  }

  return {
    enabled: true,
    signedIn: true,
    githubLogin: session?.user?.githubLogin ?? null,
    githubAvatarUrl: session?.user?.githubAvatarUrl ?? null,
    reason: "ready",
  };
}

export async function assertDashboardMutationAllowed(
  workspaceId: string,
): Promise<DashboardMutationActor> {
  const actor = await readDashboardMutationActor();

  await assertWorkspaceMutationAllowedForActor(workspaceId, actor);

  return withWorkspaceAdminAccess(actor);
}

export async function assertDashboardRepositoryMutationAllowed(
  workspaceId: string,
  repository: {
    readonly id?: string;
    readonly owner: string;
    readonly name: string;
    readonly githubRepositoryId: bigint | string | number;
    readonly installation: {
      readonly githubInstallationId: bigint | string | number;
    };
  },
): Promise<DashboardMutationActor> {
  const actor = await readDashboardMutationActor();

  try {
    await assertWorkspaceMutationAllowedForActor(workspaceId, actor);
    return withWorkspaceAdminAccess(actor);
  } catch (error) {
    if (!isWorkspaceMutationForbidden(error)) {
      throw error;
    }
  }

  const repositoryAccess = await assertRepositoryPermissionForActor({
    actor,
    repository,
    capability: "repo_manager",
  });

  return withRepositoryAccess(actor, repositoryAccess);
}

export async function assertDashboardRepositoryConfigMutationAllowed(
  workspaceId: string,
  repository: {
    readonly id?: string;
    readonly owner: string;
    readonly name: string;
    readonly githubRepositoryId: bigint | string | number;
    readonly installation: {
      readonly githubInstallationId: bigint | string | number;
    };
  },
): Promise<DashboardMutationActor> {
  const actor = await readDashboardMutationActor();

  try {
    await assertWorkspaceMutationAllowedForActor(workspaceId, actor);
    return withWorkspaceAdminAccess(actor);
  } catch (error) {
    if (!isWorkspaceMutationForbidden(error)) {
      throw error;
    }
  }

  const repositoryAccess = await assertRepositoryPermissionForActor({
    actor,
    repository,
    capability: "direct_config",
  });

  return withRepositoryAccess(actor, repositoryAccess);
}

export async function getDashboardSignedInActor(): Promise<DashboardMutationActor | null> {
  if (!getAuthEnvironmentStatus().configured || !dashboardMutationsEnabled()) {
    return null;
  }

  const session = await getServerSession(authOptions);
  const githubUserId = session?.user?.githubUserId;
  const githubLogin = session?.user?.githubLogin;
  if (!githubUserId || !githubLogin) {
    return null;
  }

  const user = await getPrisma().user.findUnique({
    where: { githubUserId: BigInt(githubUserId) },
    select: { id: true },
  });
  if (!user) return null;

  return {
    userId: user.id,
    githubUserId,
    githubLogin,
    actor: `user:${githubLogin}`,
  };
}

export async function canDashboardActorMutateRepository(input: {
  readonly actor: DashboardMutationActor;
  readonly repository: {
    readonly id?: string;
    readonly owner: string;
    readonly name: string;
    readonly githubRepositoryId: bigint | string | number;
    readonly installation: {
      readonly githubInstallationId: bigint | string | number;
    };
  };
}): Promise<boolean> {
  try {
    await assertRepositoryWritePermissionForActor(input);
    return true;
  } catch {
    return false;
  }
}

export function dashboardMutationAccessAuditMetadata(
  actor: DashboardMutationActor,
): Record<string, unknown> {
  const source = actor.accessSource;
  if (!source) return {};
  if (source.source === "workspace_admin") {
    return { accessSource: source.source };
  }

  return {
    accessSource: source.source,
    accessCapability: source.capability,
    ...(source.permission ? { githubPermission: source.permission } : {}),
    ...(source.roleName ? { githubRoleName: source.roleName } : {}),
  };
}

export async function canDashboardActorConfigureRepository(input: {
  readonly actor: DashboardMutationActor;
  readonly repository: {
    readonly id?: string;
    readonly owner: string;
    readonly name: string;
    readonly githubRepositoryId: bigint | string | number;
    readonly installation: {
      readonly githubInstallationId: bigint | string | number;
    };
  };
}): Promise<boolean> {
  try {
    await assertRepositoryPermissionForActor({
      ...input,
      capability: "direct_config",
    });
    return true;
  } catch {
    return false;
  }
}

async function readDashboardMutationActor(): Promise<DashboardMutationActor> {
  if (!getAuthEnvironmentStatus().configured) {
    throw new Error("dashboard_auth_misconfigured");
  }

  if (!dashboardMutationsEnabled()) {
    throw new Error("dashboard_mutations_disabled");
  }

  const session = await getServerSession(authOptions);
  const githubUserId = session?.user?.githubUserId;
  const githubLogin = session?.user?.githubLogin;
  if (!githubUserId || !githubLogin) {
    throw new Error("dashboard_mutation_requires_sign_in");
  }

  const user = await getPrisma().user.findUnique({
    where: { githubUserId: BigInt(githubUserId) },
    select: { id: true },
  });
  if (!user) {
    throw new Error("dashboard_mutation_requires_sign_in");
  }

  return {
    userId: user.id,
    githubUserId,
    githubLogin,
    actor: `user:${githubLogin}`,
  };
}

async function assertWorkspaceMutationAllowedForActor(
  workspaceId: string,
  actor: DashboardMutationActor,
): Promise<void> {
  await assertWorkspaceMutationAllowed(
    {
      workspaceId,
      githubUserId: actor.githubUserId,
      githubLogin: actor.githubLogin,
      localAdminGithubLogins: readCsvEnv(
        "REVIEW_ROUTER_LOCAL_ADMIN_GITHUB_LOGINS",
      ),
    },
    {
      workspaceAccess: new PrismaWorkspaceAccessRepository(getPrisma()),
    },
  );
}

async function assertRepositoryWritePermissionForActor(input: {
  readonly actor: DashboardMutationActor;
  readonly repository: {
    readonly id?: string;
    readonly owner: string;
    readonly name: string;
    readonly githubRepositoryId: bigint | string | number;
    readonly installation: {
      readonly githubInstallationId: bigint | string | number;
    };
  };
}): Promise<void> {
  await assertRepositoryPermissionForActor({
    ...input,
    capability: "repo_manager",
  });
}

async function assertRepositoryPermissionForActor(input: {
  readonly actor: DashboardMutationActor;
  readonly capability: DashboardRepositoryCapability;
  readonly repository: {
    readonly id?: string;
    readonly owner: string;
    readonly name: string;
    readonly githubRepositoryId: bigint | string | number;
    readonly installation: {
      readonly githubInstallationId: bigint | string | number;
    };
  };
}): Promise<
  Extract<DashboardMutationAccessSource, { source: "repo_manager" }>
> {
  const octokit = await createGitHubAppInstallationOctokit(
    input.repository.installation.githubInstallationId.toString(),
  );

  try {
    const response = await octokit.request(
      "GET /repos/{owner}/{repo}/collaborators/{username}/permission",
      {
        owner: input.repository.owner,
        repo: input.repository.name,
        username: input.actor.githubLogin,
      },
    );
    const data = response.data as {
      readonly permission?: unknown;
      readonly role_name?: unknown;
      readonly user?: {
        readonly id?: unknown;
        readonly login?: unknown;
      };
    };

    const responseUserId =
      typeof data.user?.id === "number" || typeof data.user?.id === "string"
        ? String(data.user.id)
        : null;
    if (responseUserId && responseUserId !== input.actor.githubUserId) {
      throw new Error("repository_mutation_forbidden");
    }

    const permission =
      typeof data.permission === "string" ? data.permission : "";
    const roleName = typeof data.role_name === "string" ? data.role_name : "";
    const canManage = repositoryPermissionAllowsRepoManagement({
      permission,
      roleName,
    });
    if (input.repository.id) {
      await updateRepositoryPermissionCacheFromLiveCheck({
        prisma: getPrisma(),
        actor: input.actor,
        repositoryId: input.repository.id,
        githubInstallationId:
          input.repository.installation.githubInstallationId,
        permission,
        roleName,
        canManage,
      });
    }

    if (!canManage) {
      throw new Error("repository_mutation_forbidden");
    }
    if (
      !repositoryPermissionAllowsCapability(
        { permission, roleName },
        input.capability,
      )
    ) {
      throw new Error("repository_config_mutation_forbidden");
    }

    return {
      source: "repo_manager",
      capability: input.capability,
      permission: permission || null,
      roleName: roleName || null,
    };
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message === "repository_mutation_forbidden" ||
        error.message === "repository_config_mutation_forbidden")
    ) {
      throw error;
    }

    const status = githubApiStatus(error);
    if (status === 401 || status === 403 || status === 404) {
      if (input.repository.id) {
        await updateRepositoryPermissionCacheFromLiveCheck({
          prisma: getPrisma(),
          actor: input.actor,
          repositoryId: input.repository.id,
          githubInstallationId:
            input.repository.installation.githubInstallationId,
          permission: "",
          roleName: "",
          canManage: false,
        });
      }
      throw new Error("repository_mutation_forbidden", { cause: error });
    }

    throw error;
  }
}

function withWorkspaceAdminAccess(
  actor: DashboardMutationActor,
): DashboardMutationActor {
  return { ...actor, accessSource: { source: "workspace_admin" } };
}

function withRepositoryAccess(
  actor: DashboardMutationActor,
  accessSource: Extract<
    DashboardMutationAccessSource,
    { source: "repo_manager" }
  >,
): DashboardMutationActor {
  return { ...actor, accessSource };
}

function isWorkspaceMutationForbidden(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.startsWith("workspace_mutation_forbidden:")
  );
}

function githubApiStatus(error: unknown): number | null {
  if (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof error.status === "number"
  ) {
    return error.status;
  }

  return null;
}

export async function getDashboardWorkspaceScope(): Promise<DashboardWorkspaceScope> {
  if (!getAuthEnvironmentStatus().configured) {
    return { kind: "none", reason: "signed_out" };
  }

  const session = await getServerSession(authOptions);
  const githubUserId = session?.user?.githubUserId;
  const githubLogin = session?.user?.githubLogin;
  if (!githubUserId || !githubLogin) {
    return { kind: "none", reason: "signed_out" };
  }

  return listVisibleWorkspaceScope(
    {
      githubUserId,
      githubLogin,
      localAdminGithubLogins: readCsvEnv(
        "REVIEW_ROUTER_LOCAL_ADMIN_GITHUB_LOGINS",
      ),
    },
    { workspaceAccess: new PrismaWorkspaceAccessRepository(getPrisma()) },
  );
}

export async function createGitHubAppInstallationOctokit(
  githubInstallationId: string,
) {
  const appId = requiredEnv("GITHUB_APP_ID");
  const app = new App({
    appId,
    privateKey: requireGitHubAppPrivateKey(),
  });

  return app.getInstallationOctokit(Number(githubInstallationId));
}

export async function createGitHubUserOctokit(
  actor: DashboardMutationActor,
): Promise<GitHubRequester> {
  const token = await getValidGitHubUserAccessToken({
    prisma: getPrisma(),
    userId: actor.userId,
  });
  if (token.status !== "ready") {
    throw new Error(githubUserTokenStatusToDashboardError(token.status));
  }

  return new GitHubUserTokenRequester(token.accessToken);
}

class GitHubUserTokenRequester implements GitHubRequester {
  constructor(private readonly accessToken: string) {}

  async request(
    route: string,
    parameters: Record<string, unknown> = {},
  ): Promise<{ data: unknown }> {
    const request = buildGitHubRequest(route, parameters);
    const response = await fetch(request.url, {
      method: request.method,
      cache: "no-store",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.accessToken}`,
        "User-Agent": "ReviewRouter",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(request.body ? { "Content-Type": "application/json" } : {}),
      },
      ...(request.body ? { body: request.body } : {}),
    });
    const data = await readGitHubResponseBody(response);
    if (!response.ok) {
      throw new GitHubUserTokenRequestError(response.status, data);
    }

    return { data };
  }
}

function buildGitHubRequest(
  route: string,
  parameters: Record<string, unknown>,
): { readonly method: string; readonly url: URL; readonly body?: string } {
  const [method, pathTemplate] = route.split(" ", 2);
  if (!method || !pathTemplate) {
    throw new Error("invalid_github_route");
  }

  const usedPathParameters = new Set<string>();
  const path = pathTemplate.replace(/\{([^}]+)\}/g, (_match, rawName) => {
    const name = String(rawName);
    const value = parameters[name];
    if (value === undefined || value === null) {
      throw new Error(`missing_github_route_parameter:${name}`);
    }
    usedPathParameters.add(name);
    return encodeGitHubRoutePathValue(String(value));
  });
  const url = new URL(path, "https://api.github.com");
  const bodyParameters = Object.fromEntries(
    Object.entries(parameters).filter(
      ([name, value]) =>
        !usedPathParameters.has(name) && value !== undefined && value !== null,
    ),
  );

  if (method.toUpperCase() === "GET") {
    for (const [name, value] of Object.entries(bodyParameters)) {
      url.searchParams.set(name, String(value));
    }
    return { method, url };
  }

  return {
    method,
    url,
    ...(Object.keys(bodyParameters).length > 0
      ? { body: JSON.stringify(bodyParameters) }
      : {}),
  };
}

function encodeGitHubRoutePathValue(value: string): string {
  return value.split("/").map(encodeURIComponent).join("/");
}

async function readGitHubResponseBody(response: Response): Promise<unknown> {
  if (response.status === 204) return null;

  const text = await response.text();
  if (!text) return null;

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("json")) {
    return JSON.parse(text) as unknown;
  }

  return text;
}

function githubUserTokenStatusToDashboardError(
  status: Exclude<
    Awaited<ReturnType<typeof getValidGitHubUserAccessToken>>["status"],
    "ready"
  >,
): string {
  switch (status) {
    case "missing":
      return "repository_access_token_missing";
    case "revoked":
      return "repository_access_token_revoked";
    case "expired":
      return "repository_access_token_expired";
    case "refresh_failed":
      return "repository_access_token_refresh_failed";
    case "token_decryption_failed":
      return "repository_access_token_decryption_failed";
    case "token_encryption_misconfigured":
      return "repository_access_token_encryption_misconfigured";
  }
}

class GitHubUserTokenRequestError extends Error {
  constructor(
    readonly status: number,
    readonly data: unknown,
  ) {
    super(`github_user_token_request_failed:${status}`);
  }
}

function dashboardMutationsEnabled(): boolean {
  return process.env.REVIEW_ROUTER_ENABLE_DASHBOARD_MUTATIONS === "1";
}

function readCsvEnv(name: string): readonly string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`missing_env:${name}`);
  }
  return value;
}
