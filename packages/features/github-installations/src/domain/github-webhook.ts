import { z } from "zod";

const accountSchema = z.object({
  login: z.string().min(1),
  type: z.string().min(1).default("User"),
});

const installationSchema = z.object({
  id: z.number().int().positive(),
  account: accountSchema,
  repository_selection: z.string().min(1).default("selected"),
});

const installationRepositorySchema = z
  .object({
    id: z.number().int().positive(),
    name: z.string().min(1).optional(),
    full_name: z.string().min(1).optional(),
  })
  .passthrough();

export const githubInstallationWebhookPayloadSchema = z.object({
  action: z.string().min(1),
  installation: installationSchema,
  repository_selection: z.string().min(1).optional(),
  repositories_added: z.array(installationRepositorySchema).default([]),
  repositories_removed: z.array(installationRepositorySchema).default([]),
});

export type GitHubInstallationWebhookPayload = z.infer<
  typeof githubInstallationWebhookPayloadSchema
>;

export type GitHubWebhookEnvelope = {
  readonly deliveryId: string;
  readonly eventName: string;
  readonly payloadHash?: string;
  readonly payload: GitHubInstallationWebhookPayload;
};
