import { App } from "@octokit/app";
import type { Session } from "next-auth";
import { getServerSession } from "next-auth";
import { cache } from "react";
import { z } from "zod";
import {
  assertWorkspaceAdminAllowed,
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
import { DashboardMutationRefusedError } from "./dashboard-mutation-errors";

// Both the persistent shell and the section ask for identity during one RSC
// request. React's request-scoped cache avoids repeating the session and
// identity database reads without sharing authorization state across users.
const getDashboardServerSession = cache(() => getServerSession(authOptions));
const findDashboardUserBySource = cache(
  async (sourceProvider: "github" | "gitlab", externalUserId: string) => {
    const identity = await getPrisma().userExternalIdentity.findUnique({
      where: {
        provider_externalUserId: {
          provider: sourceProvider,
          externalUserId,
        },
      },
      select: { userId: true },
    });
    return identity ? { id: identity.userId } : null;
  },
);

export type DashboardMutationActor = {
  readonly userId: string;
  readonly sourceProvider: "github" | "gitlab";
  readonly externalUserId: string;
  readonly sourceLogin: string;
  readonly githubUserId: string | null;
  readonly githubLogin: string | null;
  readonly actor: string;
  readonly accessSource?: DashboardMutationAccessSource;
};

export type DashboardWorkspaceAdminActor = DashboardMutationActor;
export type DashboardGitHubMutationActor = DashboardMutationActor & {
  readonly sourceProvider: "github";
  readonly githubUserId: string;
  readonly githubLogin: string;
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
  readonly sourceProvider: "github" | "gitlab" | null;
  readonly externalUserId: string | null;
  readonly sourceLogin: string | null;
  readonly sourceAvatarUrl: string | null;
  readonly githubUserId: string | null;
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
      sourceProvider: null,
      externalUserId: null,
      sourceLogin: null,
      sourceAvatarUrl: null,
      githubUserId: null,
      githubLogin: null,
      githubAvatarUrl: null,
      reason: "auth_misconfigured",
    };
  }

  const session = await getDashboardServerSession();
  const identity = readSessionSourceIdentity(session);
  const signedIn = Boolean(identity);
  if (!dashboardMutationsEnabled()) {
    return {
      enabled: false,
      signedIn,
      sourceProvider: identity?.sourceProvider ?? null,
      externalUserId: identity?.externalUserId ?? null,
      sourceLogin: identity?.sourceLogin ?? null,
      sourceAvatarUrl: identity?.sourceAvatarUrl ?? null,
      githubUserId: session?.user?.githubUserId ?? null,
      githubLogin: session?.user?.githubLogin ?? null,
      githubAvatarUrl: session?.user?.githubAvatarUrl ?? null,
      reason: "disabled",
    };
  }
  if (!signedIn) {
    return {
      enabled: false,
      signedIn: false,
      sourceProvider: null,
      externalUserId: null,
      sourceLogin: null,
      sourceAvatarUrl: null,
      githubUserId: null,
      githubLogin: null,
      githubAvatarUrl: null,
      reason: "signed_out",
    };
  }

  return {
    enabled: true,
    signedIn: true,
    sourceProvider: identity?.sourceProvider ?? null,
    externalUserId: identity?.externalUserId ?? null,
    sourceLogin: identity?.sourceLogin ?? null,
    sourceAvatarUrl: identity?.sourceAvatarUrl ?? null,
    githubUserId: session?.user?.githubUserId ?? null,
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

/**
 * Authorizes the recovery transport without changing the durable repository
 * permission cache. Recovery must admit the database recovery witness before
 * any durable mutation, so this boundary deliberately uses only the live
 * GitHub permission result.
 */
export async function assertDashboardRepositoryRecoveryAllowed(
  _workspaceId: string,
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

  const repositoryAccess = await assertRepositoryPermissionForActor({
    actor,
    repository,
    capability: "repo_manager",
    permissionCacheMode: "read_only",
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

  const session = await getDashboardServerSession();
  const identity = readSessionSourceIdentity(session);
  if (!identity) {
    return null;
  }

  const user = await findUserForSourceIdentity(identity);
  if (!user) return null;

  return {
    userId: user.id,
    sourceProvider: identity.sourceProvider,
    externalUserId: identity.externalUserId,
    sourceLogin: identity.sourceLogin,
    githubUserId: githubUserIdForIdentity(identity),
    githubLogin: githubLoginForIdentity(identity),
    actor: `user:${identity.sourceProvider}:${identity.sourceLogin}`,
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

export function asDashboardGitHubActor(
  actor: DashboardMutationActor | null,
): DashboardGitHubMutationActor | null {
  if (
    !actor ||
    actor.sourceProvider !== "github" ||
    !actor.githubUserId ||
    !actor.githubLogin
  ) {
    return null;
  }

  return actor as DashboardGitHubMutationActor;
}

async function readDashboardMutationActor(): Promise<DashboardMutationActor> {
  if (!getAuthEnvironmentStatus().configured) {
    throw new Error("dashboard_auth_misconfigured");
  }

  if (!dashboardMutationsEnabled()) {
    throw new DashboardMutationRefusedError("dashboard_mutations_disabled");
  }

  const session = await getDashboardServerSession();
  const identity = readSessionSourceIdentity(session);
  if (!identity) {
    // Only successful session absence proves sign-out. A malformed present
    // session is missing authority facts and remains an uncertain failure.
    if (session === null)
      throw new DashboardMutationRefusedError(
        "dashboard_mutation_requires_sign_in",
      );
    throw new Error("dashboard_mutation_requires_sign_in");
  }

  const user = await findUserForSourceIdentity(identity);
  if (!user) {
    throw new DashboardMutationRefusedError(
      "dashboard_mutation_requires_sign_in",
    );
  }

  return {
    userId: user.id,
    sourceProvider: identity.sourceProvider,
    externalUserId: identity.externalUserId,
    sourceLogin: identity.sourceLogin,
    githubUserId: githubUserIdForIdentity(identity),
    githubLogin: githubLoginForIdentity(identity),
    actor: `user:${identity.sourceProvider}:${identity.sourceLogin}`,
  };
}

async function assertWorkspaceMutationAllowedForActor(
  workspaceId: string,
  actor: DashboardMutationActor,
): Promise<void> {
  await assertWorkspaceMutationAllowed(
    {
      workspaceId,
      userId: actor.userId,
      githubUserId: actor.githubUserId ?? "",
      githubLogin: actor.githubLogin ?? "",
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
  readonly permissionCacheMode?: "write_through" | "read_only";
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
  const githubActor = asDashboardGitHubActor(input.actor);
  if (!githubActor) {
    throw new Error("repository_mutation_forbidden");
  }

  const octokit = await createGitHubAppInstallationOctokit(
    input.repository.installation.githubInstallationId.toString(),
  );

  let response: { data: unknown };
  try {
    response = await octokit.request(
      "GET /repos/{owner}/{repo}/collaborators/{username}/permission",
      {
        owner: input.repository.owner,
        repo: input.repository.name,
        username: githubActor.githubLogin,
      },
    );
  } catch (error) {
    const status = githubApiStatus(error);
    if (status === 401 || status === 403 || status === 404) {
      if (input.repository.id && input.permissionCacheMode !== "read_only") {
        await updateRepositoryPermissionCacheFromLiveCheck({
          prisma: getPrisma(),
          actor: githubActor,
          repositoryId: input.repository.id,
          githubInstallationId:
            input.repository.installation.githubInstallationId,
          permission: "",
          roleName: "",
          canManage: false,
        });
      }
      // Keep the legacy message, but transport status never proves a refusal.
      throw new Error("repository_mutation_forbidden", { cause: error });
    }
    throw error;
  }

  // A successful HTTP response needs explicit permission AND identity facts.
  // An absent, empty or unrecognized permission is not evidence of refusal.
  const facts = z
    .object({
      permission: z.enum([
        "admin",
        "maintain",
        "write",
        "triage",
        "read",
        "none",
      ]),
      role_name: z.string().trim().min(1).optional(),
      user: z.object({
        id: z.union([
          z.number().int().positive().refine(Number.isSafeInteger),
          z.string().regex(/^[1-9][0-9]*$/),
        ]),
        login: z.string().trim().min(1),
      }),
    })
    .safeParse(response.data);
  if (!facts.success) throw new Error("repository_mutation_forbidden");
  const data = facts.data;
  if (
    String(data.user.id) !== githubActor.githubUserId ||
    data.user.login.toLowerCase() !== githubActor.githubLogin.toLowerCase()
  )
    throw new DashboardMutationRefusedError("repository_mutation_forbidden");

  const permission = data.permission;
  const roleName = data.role_name ?? "";
  const canManage = repositoryPermissionAllowsRepoManagement({
    permission,
    roleName,
  });
  const allowsCapability = repositoryPermissionAllowsCapability(
    { permission, roleName },
    input.capability,
  );
  // Both policies can grant access from the role independently of permission.
  // Missing role facts cannot prove a negative decision, but do not invalidate
  // access already established by the explicit permission.
  if ((!canManage || !allowsCapability) && data.role_name === undefined) {
    throw new Error(
      canManage
        ? "repository_config_mutation_forbidden"
        : "repository_mutation_forbidden",
    );
  }
  if (input.repository.id && input.permissionCacheMode !== "read_only") {
    await updateRepositoryPermissionCacheFromLiveCheck({
      prisma: getPrisma(),
      actor: githubActor,
      repositoryId: input.repository.id,
      githubInstallationId: input.repository.installation.githubInstallationId,
      permission,
      roleName,
      canManage,
    });
  }
  if (!canManage)
    throw new DashboardMutationRefusedError("repository_mutation_forbidden");
  if (!allowsCapability)
    throw new DashboardMutationRefusedError(
      "repository_config_mutation_forbidden",
    );

  return {
    source: "repo_manager",
    capability: input.capability,
    permission,
    roleName: roleName || null,
  };
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

export async function assertDashboardWorkspaceAdminAllowed(
  workspaceId: string,
): Promise<DashboardWorkspaceAdminActor> {
  if (!getAuthEnvironmentStatus().configured) {
    throw new Error("dashboard_auth_misconfigured");
  }

  const session = await getDashboardServerSession();
  const identity = readSessionSourceIdentity(session);
  if (!identity) {
    throw new Error("dashboard_admin_requires_sign_in");
  }

  const user = await findUserForSourceIdentity(identity);
  if (!user) {
    throw new Error("dashboard_admin_requires_sign_in");
  }

  await assertWorkspaceAdminAllowed(
    {
      workspaceId,
      userId: user.id,
      githubUserId: githubUserIdForIdentity(identity) ?? "",
      githubLogin: githubLoginForIdentity(identity) ?? "",
      localAdminGithubLogins: readCsvEnv(
        "REVIEW_ROUTER_LOCAL_ADMIN_GITHUB_LOGINS",
      ),
    },
    {
      workspaceAccess: new PrismaWorkspaceAccessRepository(getPrisma()),
    },
  );

  return {
    userId: user.id,
    sourceProvider: identity.sourceProvider,
    externalUserId: identity.externalUserId,
    sourceLogin: identity.sourceLogin,
    githubUserId: githubUserIdForIdentity(identity),
    githubLogin: githubLoginForIdentity(identity),
    actor: `user:${identity.sourceProvider}:${identity.sourceLogin}`,
  };
}

export async function getDashboardWorkspaceScope(): Promise<DashboardWorkspaceScope> {
  if (!getAuthEnvironmentStatus().configured) {
    return { kind: "none", reason: "signed_out" };
  }

  const session = await getDashboardServerSession();
  const identity = readSessionSourceIdentity(session);
  if (!identity) {
    return { kind: "none", reason: "signed_out" };
  }
  const user = await findUserForSourceIdentity(identity);
  if (!user) {
    return { kind: "none", reason: "signed_out" };
  }

  return listVisibleWorkspaceScope(
    {
      userId: user.id,
      githubUserId: githubUserIdForIdentity(identity) ?? "",
      githubLogin: githubLoginForIdentity(identity) ?? "",
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

type GitHubAppInstallationAuthentication = Readonly<{
  token?: unknown;
  permissions?: Readonly<Record<string, unknown>>;
  repositoryIds?: readonly unknown[];
}>;

/**
 * Mints uncached authority for the setup secret write. This is intentionally
 * separate from the broad dashboard installation Octokit factory above: a
 * setup PUT must never inherit all repositories or all installation grants.
 */
export async function mintFreshGitHubAppRepositorySecretWriteToken(input: {
  readonly githubInstallationId: string;
  readonly githubRepositoryId: string;
}): Promise<string> {
  const installationId = parsePositiveSafeGitHubId(
    input.githubInstallationId,
    "github_installation_id_invalid",
  );
  const repositoryId = parsePositiveSafeGitHubId(
    input.githubRepositoryId,
    "github_repository_id_invalid",
  );
  const app = new App({
    appId: requiredEnv("GITHUB_APP_ID"),
    privateKey: requireGitHubAppPrivateKey(),
  });
  const authentication = (await app.octokit.auth({
    type: "installation",
    installationId,
    repositoryIds: [repositoryId],
    permissions: { secrets: "write" },
    refresh: true,
  })) as GitHubAppInstallationAuthentication;

  if (typeof authentication.token !== "string" || !authentication.token) {
    throw new Error("setup_secret_token_invalid_response");
  }
  if (
    authentication.repositoryIds?.length !== 1 ||
    authentication.repositoryIds[0] !== repositoryId
  ) {
    throw new Error("setup_secret_token_repository_scope_mismatch");
  }
  const permissions = authentication.permissions;
  if (
    !permissions ||
    permissions.secrets !== "write" ||
    Object.entries(permissions).some(
      ([name, access]) =>
        name !== "secrets" && !(name === "metadata" && access === "read"),
    )
  ) {
    throw new Error("setup_secret_token_permissions_mismatch");
  }

  return authentication.token;
}

export async function createGitHubUserOctokit(
  actor: DashboardMutationActor,
): Promise<GitHubRequester> {
  const githubActor = asDashboardGitHubActor(actor);
  if (!githubActor) {
    throw new Error("github_user_identity_required");
  }

  const token = await getValidGitHubUserAccessToken({
    prisma: getPrisma(),
    userId: githubActor.userId,
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

type SessionSourceIdentity = {
  readonly sourceProvider: "github" | "gitlab";
  readonly externalUserId: string;
  readonly sourceLogin: string;
  readonly sourceAvatarUrl: string | null;
  readonly githubUserId: string | null;
  readonly githubLogin: string | null;
};

function readSessionSourceIdentity(
  session: Session | null,
): SessionSourceIdentity | null {
  const user = session?.user;
  const sourceProvider = user?.sourceProvider;
  const externalUserId = user?.externalUserId;
  const sourceLogin = user?.sourceLogin;
  // Legacy sessions have no modern source tuple. A present malformed modern
  // tuple must not fall back to another provider's identity.
  if (sourceProvider == null && externalUserId == null && sourceLogin == null) {
    if (
      user &&
      isNonblankSessionIdentityField(user.githubUserId) &&
      isNonblankSessionIdentityField(user.githubLogin)
    ) {
      return {
        sourceProvider: "github",
        externalUserId: user.githubUserId,
        sourceLogin: user.githubLogin,
        sourceAvatarUrl: user?.githubAvatarUrl ?? null,
        githubUserId: user.githubUserId,
        githubLogin: user.githubLogin,
      };
    }
    return null;
  }
  if (
    (sourceProvider !== "github" && sourceProvider !== "gitlab") ||
    !isNonblankSessionIdentityField(externalUserId) ||
    !isNonblankSessionIdentityField(sourceLogin)
  )
    return null;
  if (sourceProvider === "github") {
    if (
      (user?.githubUserId != null &&
        !isNonblankSessionIdentityField(user.githubUserId)) ||
      (user?.githubLogin != null &&
        !isNonblankSessionIdentityField(user.githubLogin))
    )
      return null;
  }
  return {
    sourceProvider,
    externalUserId,
    sourceLogin,
    sourceAvatarUrl:
      user?.sourceAvatarUrl ??
      (sourceProvider === "github"
        ? user?.githubAvatarUrl
        : user?.gitlabAvatarUrl) ??
      null,
    githubUserId: user?.githubUserId ?? null,
    githubLogin: user?.githubLogin ?? null,
  };
}

function isNonblankSessionIdentityField(value: unknown): value is string {
  // Keep the decoded identity unchanged; only validate its primitive contract.
  return typeof value === "string" && value.trim().length > 0;
}

function githubUserIdForIdentity(
  identity: SessionSourceIdentity,
): string | null {
  return identity.sourceProvider === "github"
    ? (identity.githubUserId ?? identity.externalUserId)
    : null;
}

function githubLoginForIdentity(
  identity: SessionSourceIdentity,
): string | null {
  return identity.sourceProvider === "github"
    ? (identity.githubLogin ?? identity.sourceLogin)
    : null;
}

async function findUserForSourceIdentity(input: {
  readonly sourceProvider: "github" | "gitlab";
  readonly externalUserId: string;
}): Promise<{ readonly id: string } | null> {
  return findDashboardUserBySource(input.sourceProvider, input.externalUserId);
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

function parsePositiveSafeGitHubId(value: string, error: string): number {
  if (!/^[1-9][0-9]*$/u.test(value)) throw new Error(error);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(error);
  return parsed;
}
