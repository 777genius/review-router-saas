import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session {
    user?: DefaultSession["user"] & {
      sourceProvider?: "github" | "gitlab" | null;
      externalUserId?: string | null;
      sourceLogin?: string | null;
      sourceAvatarUrl?: string | null;
      githubUserId?: string | null;
      githubLogin?: string | null;
      githubAvatarUrl?: string | null;
      gitlabUserId?: string | null;
      gitlabLogin?: string | null;
      gitlabAvatarUrl?: string | null;
    };
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    sourceProvider?: "github" | "gitlab" | null;
    externalUserId?: string | null;
    sourceLogin?: string | null;
    sourceAvatarUrl?: string | null;
    githubUserId?: string | null;
    githubLogin?: string | null;
    githubAvatarUrl?: string | null;
    gitlabUserId?: string | null;
    gitlabLogin?: string | null;
    gitlabAvatarUrl?: string | null;
  }
}
