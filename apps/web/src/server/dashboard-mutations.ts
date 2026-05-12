import { App } from "@octokit/app";
import { getServerSession } from "next-auth";
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
import { getPrisma } from "./prisma";

type DashboardMutationActor = {
  readonly githubUserId: string;
  readonly githubLogin: string;
  readonly actor: string;
};

export type DashboardWorkspaceAdminActor = DashboardMutationActor;

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

  await assertWorkspaceMutationAllowed(
    {
      workspaceId,
      githubUserId,
      githubLogin,
      localAdminGithubLogins: readCsvEnv(
        "REVIEW_ROUTER_LOCAL_ADMIN_GITHUB_LOGINS",
      ),
    },
    {
      workspaceAccess: new PrismaWorkspaceAccessRepository(getPrisma()),
    },
  );

  return { githubUserId, githubLogin, actor: `user:${githubLogin}` };
}

export async function assertDashboardWorkspaceAdminAllowed(
  workspaceId: string,
): Promise<DashboardWorkspaceAdminActor> {
  if (!getAuthEnvironmentStatus().configured) {
    throw new Error("dashboard_auth_misconfigured");
  }

  const session = await getServerSession(authOptions);
  const githubUserId = session?.user?.githubUserId;
  const githubLogin = session?.user?.githubLogin;
  if (!githubUserId || !githubLogin) {
    throw new Error("dashboard_admin_requires_sign_in");
  }

  await assertWorkspaceAdminAllowed(
    {
      workspaceId,
      githubUserId,
      githubLogin,
      localAdminGithubLogins: readCsvEnv(
        "REVIEW_ROUTER_LOCAL_ADMIN_GITHUB_LOGINS",
      ),
    },
    {
      workspaceAccess: new PrismaWorkspaceAccessRepository(getPrisma()),
    },
  );

  return { githubUserId, githubLogin, actor: `user:${githubLogin}` };
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
