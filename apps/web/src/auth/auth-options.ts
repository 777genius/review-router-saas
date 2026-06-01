import type { NextAuthOptions } from "next-auth";
import GitHubProvider from "next-auth/providers/github";
import type { OAuthConfig } from "next-auth/providers/oauth";
import {
  linkExternalIdentity,
  linkGitHubIdentity,
  parseNextAuthGitLabProfile,
  parseNextAuthGitHubProfile,
  PrismaUserRepository,
  PrismaWorkspaceMembershipRepository,
} from "@reviewrouter/features-auth";
import { getPrisma } from "../server/prisma";
import { saveGitHubUserAuthorizationFromAccount } from "../server/github-user-authorization";
import {
  isGitHubAuthConfigured,
  isGitLabAuthConfigured,
  readOptionalAuthEnv,
} from "./auth-env";

export const authOptions: NextAuthOptions = {
  secret: readOptionalAuthEnv("AUTH_SECRET"),
  session: { strategy: "jwt" },
  logger: {
    error(code, metadata) {
      if (code === "JWT_SESSION_ERROR") {
        console.warn(
          "[next-auth][warn][JWT_SESSION_ERROR] Ignoring stale or undecryptable session cookie.",
          metadata,
        );
        return;
      }
      console.error(`[next-auth][error][${code}]`, metadata);
    },
  },
  pages: {
    signIn: "/auth/signin",
    error: "/auth/signin",
  },
  providers: buildAuthProviders(),
  events: {
    async signIn(message) {
      if (
        message.account?.provider !== "github" &&
        message.account?.provider !== "gitlab"
      ) {
        return;
      }
      const prisma = getPrisma();
      const users = new PrismaUserRepository(prisma);
      const memberships = new PrismaWorkspaceMembershipRepository(prisma);

      if (message.account.provider === "github") {
        const principal = await linkGitHubIdentity(
          parseNextAuthGitHubProfile(message.profile),
          { users, memberships },
        );
        await saveGitHubUserAuthorizationFromAccount({
          prisma,
          principal,
          account: message.account,
        });
        return;
      }

      await linkExternalIdentity(parseNextAuthGitLabProfile(message.profile), {
        users,
        memberships,
      });
    },
  },
  callbacks: {
    async jwt({ token, profile, account }) {
      if (account?.provider === "github" && profile) {
        const identity = parseNextAuthGitHubProfile(profile);
        token.sourceProvider = "github";
        token.externalUserId = identity.githubUserId;
        token.sourceLogin = identity.githubLogin;
        token.sourceAvatarUrl = identity.avatarUrl ?? null;
        token.githubUserId = identity.githubUserId;
        token.githubLogin = identity.githubLogin;
        token.githubAvatarUrl = identity.avatarUrl ?? null;
      }
      if (account?.provider === "gitlab" && profile) {
        const identity = parseNextAuthGitLabProfile(profile);
        token.sourceProvider = "gitlab";
        token.externalUserId = identity.externalUserId;
        token.sourceLogin = identity.login;
        token.sourceAvatarUrl = identity.avatarUrl ?? null;
        token.gitlabUserId = identity.externalUserId;
        token.gitlabLogin = identity.login;
        token.gitlabAvatarUrl = identity.avatarUrl ?? null;
      }
      return token;
    },
    async session({ session, token }) {
      session.user = {
        ...session.user,
        sourceProvider:
          token.sourceProvider === "github" || token.sourceProvider === "gitlab"
            ? token.sourceProvider
            : null,
        externalUserId:
          typeof token.externalUserId === "string"
            ? token.externalUserId
            : null,
        sourceLogin:
          typeof token.sourceLogin === "string" ? token.sourceLogin : null,
        sourceAvatarUrl:
          typeof token.sourceAvatarUrl === "string"
            ? token.sourceAvatarUrl
            : null,
        githubUserId:
          typeof token.githubUserId === "string" ? token.githubUserId : null,
        githubLogin:
          typeof token.githubLogin === "string" ? token.githubLogin : null,
        githubAvatarUrl:
          typeof token.githubAvatarUrl === "string"
            ? token.githubAvatarUrl
            : null,
        gitlabUserId:
          typeof token.gitlabUserId === "string" ? token.gitlabUserId : null,
        gitlabLogin:
          typeof token.gitlabLogin === "string" ? token.gitlabLogin : null,
        gitlabAvatarUrl:
          typeof token.gitlabAvatarUrl === "string"
            ? token.gitlabAvatarUrl
            : null,
      };
      return session;
    },
  },
};

function buildAuthProviders(): NextAuthOptions["providers"] {
  const providers: NextAuthOptions["providers"] = [];
  if (isGitHubAuthConfigured()) {
    providers.push(
      GitHubProvider({
        clientId: readOptionalAuthEnv("GITHUB_APP_CLIENT_ID"),
        clientSecret: readOptionalAuthEnv("GITHUB_APP_CLIENT_SECRET"),
        authorization: {
          params: {
            scope: "read:user user:email repo",
          },
        },
      }),
    );
  }
  if (isGitLabAuthConfigured()) {
    providers.push(createGitLabProvider());
  }
  return providers;
}

function createGitLabProvider(): OAuthConfig<Record<string, unknown>> {
  const baseUrl = normalizeGitLabBaseUrl(
    process.env.GITLAB_OAUTH_BASE_URL ?? "https://gitlab.com",
  );
  return {
    id: "gitlab",
    name: "GitLab",
    type: "oauth",
    checks: ["pkce", "state"],
    authorization: {
      url: `${baseUrl}/oauth/authorize`,
      params: { scope: "read_user" },
    },
    token: `${baseUrl}/oauth/token`,
    userinfo: `${baseUrl}/api/v4/user`,
    clientId: readOptionalAuthEnv("GITLAB_OAUTH_CLIENT_ID"),
    clientSecret: readOptionalAuthEnv("GITLAB_OAUTH_CLIENT_SECRET"),
    profile(profile) {
      const identity = parseNextAuthGitLabProfile(profile);
      return {
        id: identity.externalUserId,
        name: identity.login,
        email: identity.primaryEmail ?? null,
        image: identity.avatarUrl ?? null,
      };
    },
  };
}

function normalizeGitLabBaseUrl(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" && parsed.hostname !== "localhost") {
    throw new Error("gitlab_oauth_base_url_invalid");
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}
