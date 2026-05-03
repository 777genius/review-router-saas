import { z } from "zod";

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
