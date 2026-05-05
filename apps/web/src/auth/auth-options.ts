import type { NextAuthOptions } from "next-auth";
import GitHubProvider from "next-auth/providers/github";
import {
  linkGitHubIdentity,
  parseNextAuthGitHubProfile,
  PrismaUserRepository,
  PrismaWorkspaceMembershipRepository,
} from "@reviewrouter/features-auth";
import { getPrisma } from "../server/prisma";
import { readOptionalAuthEnv } from "./auth-env";

export const authOptions: NextAuthOptions = {
  secret: readOptionalAuthEnv("AUTH_SECRET"),
  session: { strategy: "jwt" },
  pages: {
    signIn: "/auth/signin",
    error: "/auth/signin",
  },
  providers: [
    GitHubProvider({
      clientId: readOptionalAuthEnv("GITHUB_APP_CLIENT_ID"),
      clientSecret: readOptionalAuthEnv("GITHUB_APP_CLIENT_SECRET"),
      authorization: {
        params: {
          scope: "read:user user:email",
        },
      },
    }),
  ],
  events: {
    async signIn(message) {
      if (message.account?.provider !== "github") return;
      const prisma = getPrisma();

      await linkGitHubIdentity(parseNextAuthGitHubProfile(message.profile), {
        users: new PrismaUserRepository(prisma),
        memberships: new PrismaWorkspaceMembershipRepository(prisma),
      });
    },
  },
  callbacks: {
    async jwt({ token, profile, account }) {
      if (account?.provider === "github" && profile) {
        const identity = parseNextAuthGitHubProfile(profile);
        token.githubUserId = identity.githubUserId;
        token.githubLogin = identity.githubLogin;
      }
      return token;
    },
    async session({ session, token }) {
      session.user = {
        ...session.user,
        githubUserId:
          typeof token.githubUserId === "string" ? token.githubUserId : null,
        githubLogin:
          typeof token.githubLogin === "string" ? token.githubLogin : null,
      };
      return session;
    },
  },
};
