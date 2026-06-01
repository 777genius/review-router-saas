import { z } from "zod";

export const externalIdentityProviderSchema = z.enum(["github", "gitlab"]);

export type ExternalIdentityProvider = z.infer<
  typeof externalIdentityProviderSchema
>;

export const externalIdentitySchema = z.object({
  provider: externalIdentityProviderSchema,
  externalUserId: z.string().min(1),
  login: z.string().min(1),
  primaryEmail: z.string().email().nullable().optional(),
  avatarUrl: z.string().url().nullable().optional(),
});

export type ExternalIdentity = z.infer<typeof externalIdentitySchema>;

export function parseExternalIdentity(input: unknown): ExternalIdentity {
  return externalIdentitySchema.parse(input);
}
