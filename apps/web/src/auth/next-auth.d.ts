import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session {
    user?: DefaultSession["user"] & {
      githubUserId?: string | null;
      githubLogin?: string | null;
    };
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    githubUserId?: string | null;
    githubLogin?: string | null;
  }
}
