import { z } from "zod";

const accountSchema = z.object({
  login: z.string().min(1),
  type: z.string().min(1).default("User"),
  avatar_url: z.string().url().nullable().optional(),
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

const senderSchema = z
  .object({
    id: z.number().int().positive(),
    login: z.string().min(1),
    avatar_url: z.string().url().nullable().optional(),
  })
  .passthrough();

const pullRequestRefSchema = z
  .object({
    ref: z.string().min(1),
  })
  .passthrough();

const pullRequestSchema = z
  .object({
    number: z.number().int().positive(),
    html_url: z.string().url(),
    state: z.string().min(1),
    merged: z.boolean().default(false),
    base: pullRequestRefSchema,
    head: pullRequestRefSchema,
  })
  .passthrough();

const pullRequestRepositorySchema = z
  .object({
    id: z.number().int().positive(),
    name: z.string().min(1),
    full_name: z.string().min(1),
  })
  .passthrough();

export const githubInstallationWebhookPayloadSchema = z.object({
  action: z.string().min(1),
  installation: installationSchema,
  sender: senderSchema.optional(),
  repository_selection: z.string().min(1).optional(),
  repositories_added: z.array(installationRepositorySchema).default([]),
  repositories_removed: z.array(installationRepositorySchema).default([]),
});

export type GitHubInstallationWebhookPayload = z.infer<
  typeof githubInstallationWebhookPayloadSchema
>;

export const githubPullRequestWebhookPayloadSchema = z.object({
  action: z.string().min(1),
  installation: installationSchema,
  repository: pullRequestRepositorySchema,
  pull_request: pullRequestSchema,
  sender: senderSchema.optional(),
});

export type GitHubPullRequestWebhookPayload = z.infer<
  typeof githubPullRequestWebhookPayloadSchema
>;

export type GitHubWebhookEnvelope = {
  readonly deliveryId: string;
  readonly eventName: string;
  readonly payloadHash?: string;
  readonly payload: GitHubInstallationWebhookPayload;
};

export type GitHubPullRequestWebhookEnvelope = {
  readonly deliveryId: string;
  readonly eventName: "pull_request";
  readonly payloadHash?: string;
  readonly payload: GitHubPullRequestWebhookPayload;
};

export type GitHubPullRequestWebhookHandlerPort = {
  handleGitHubPullRequestWebhook(
    envelope: GitHubPullRequestWebhookEnvelope,
  ): Promise<Record<string, unknown>>;
};

export const supportedGitHubInstallationWebhookEvents = [
  "installation",
  "installation_repositories",
  "pull_request",
] as const;

export function isSupportedGitHubInstallationWebhookEvent(
  eventName: string,
): eventName is (typeof supportedGitHubInstallationWebhookEvents)[number] {
  return supportedGitHubInstallationWebhookEvents.includes(
    eventName as (typeof supportedGitHubInstallationWebhookEvents)[number],
  );
}
