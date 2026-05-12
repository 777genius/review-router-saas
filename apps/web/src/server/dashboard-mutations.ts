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
import { updateRepositoryPermissionCacheFromLiveCheck } from "./github-user-repository-access";
import { getPrisma } from "./prisma";

export type DashboardMutationActor = {
  readonly userId: string;
  readonly githubUserId: string;
  readonly githubLogin: string;
  readonly actor: string;
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

  return actor;
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
    return actor;
  } catch (error) {
    if (!isWorkspaceMutationForbidden(error)) {
      throw error;
    }
  }

  await assertRepositoryWritePermissionForActor({
    actor,
    repository,
  });

  return actor;
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
    const canManage = repositoryPermissionAllowsMutation({
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
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "repository_mutation_forbidden"
    ) {
      throw error;
    }

    const status = githubApiStatus(error);
    if (status === 401 || status === 403 || status === 404) {
      throw new Error("repository_mutation_forbidden", { cause: error });
    }

    throw error;
  }
}

function repositoryPermissionAllowsMutation(input: {
  readonly permission: string;
  readonly roleName: string;
}): boolean {
  const permission = input.permission.toLowerCase();
  const roleName = input.roleName.toLowerCase();

  return (
    permission === "admin" ||
    permission === "write" ||
    roleName === "admin" ||
    roleName === "maintain" ||
    roleName === "write"
  );
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
