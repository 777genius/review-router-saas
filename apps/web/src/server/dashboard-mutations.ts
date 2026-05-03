import { readFileSync } from "node:fs";
import { App } from "@octokit/app";
import { getServerSession } from "next-auth";
import {
  assertWorkspaceMutationAllowed,
  PrismaWorkspaceAccessRepository,
} from "@reviewrouter/features-auth";
import { authOptions } from "../auth/auth-options";
import { getPrisma } from "./prisma";

type DashboardMutationActor = {
  readonly githubUserId: string;
  readonly githubLogin: string;
  readonly actor: string;
};

export type DashboardMutationStatus = {
  readonly enabled: boolean;
  readonly signedIn: boolean;
  readonly githubLogin: string | null;
  readonly reason: "ready" | "disabled" | "signed_out";
};

export async function getDashboardMutationStatus(): Promise<DashboardMutationStatus> {
  const session = await getServerSession(authOptions);
  const signedIn = Boolean(
    session?.user?.githubUserId && session.user.githubLogin,
  );
  if (!dashboardMutationsEnabled()) {
    return {
      enabled: false,
      signedIn,
      githubLogin: session?.user?.githubLogin ?? null,
      reason: "disabled",
    };
  }
  if (!signedIn) {
    return {
      enabled: false,
      signedIn: false,
      githubLogin: null,
      reason: "signed_out",
    };
  }

  return {
    enabled: true,
    signedIn: true,
    githubLogin: session?.user?.githubLogin ?? null,
    reason: "ready",
  };
}

export async function assertDashboardMutationAllowed(
  workspaceId: string,
): Promise<DashboardMutationActor> {
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

export async function createGitHubAppInstallationOctokit(
  githubInstallationId: string,
) {
  const appId = requiredEnv("GITHUB_APP_ID");
  const privateKeyFile = requiredEnv("GITHUB_APP_PRIVATE_KEY_FILE");
  const app = new App({
    appId,
    privateKey: readFileSync(privateKeyFile, "utf8"),
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
