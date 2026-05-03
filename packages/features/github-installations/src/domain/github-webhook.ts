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

export const githubInstallationWebhookPayloadSchema = z.object({
  action: z.string().min(1),
  installation: installationSchema,
});

export type GitHubInstallationWebhookPayload = z.infer<
  typeof githubInstallationWebhookPayloadSchema
>;

export type GitHubWebhookEnvelope = {
  readonly deliveryId: string;
  readonly eventName: string;
  readonly payload: GitHubInstallationWebhookPayload;
};
