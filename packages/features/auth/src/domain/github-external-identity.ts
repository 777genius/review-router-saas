import { z } from "zod";
import type { ExternalIdentity } from "./external-identity";

export const githubExternalIdentitySchema = z.object({
  githubUserId: z.string().regex(/^\d+$/),
  githubLogin: z.string().min(1),
  primaryEmail: z.string().email().nullable().optional(),
  avatarUrl: z.string().url().nullable().optional(),
});

export type GitHubExternalIdentity = z.infer<
  typeof githubExternalIdentitySchema
>;

export function parseGitHubExternalIdentity(
  input: unknown,
): GitHubExternalIdentity {
  return githubExternalIdentitySchema.parse(input);
}

export function gitHubIdentityToExternalIdentity(
  identity: GitHubExternalIdentity,
): ExternalIdentity {
  return {
    provider: "github",
    externalUserId: identity.githubUserId,
    login: identity.githubLogin,
    primaryEmail: identity.primaryEmail ?? null,
    avatarUrl: identity.avatarUrl ?? null,
  };
}
