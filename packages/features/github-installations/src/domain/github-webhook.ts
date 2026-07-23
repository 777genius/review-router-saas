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

const installationReferenceSchema = z
  .object({
    id: z.number().int().positive(),
    account: accountSchema.optional(),
    repository_selection: z.string().min(1).optional(),
  })
  .passthrough();

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
    sha: z
      .string()
      .regex(/^[a-f0-9]{40}$/i)
      .optional(),
    repo: z
      .object({ full_name: z.string().min(1) })
      .passthrough()
      .optional(),
  })
  .passthrough();

const pullRequestSchema = z
  .object({
    number: z.number().int().positive(),
    html_url: z.string().url(),
    state: z.string().min(1),
    merged: z.boolean().default(false),
    draft: z.boolean().default(false),
    user: z
      .object({ type: z.string().min(1).default("User") })
      .passthrough()
      .optional(),
    base: pullRequestRefSchema,
    head: pullRequestRefSchema,
  })
  .passthrough();

const pullRequestChangesSchema = z
  .object({
    base: z
      .object({ ref: z.object({ from: z.string().min(1) }).passthrough() })
      .passthrough()
      .optional(),
  })
  .passthrough()
  .optional();

const pullRequestRepositorySchema = z
  .object({
    id: z.number().int().positive(),
    name: z.string().min(1),
    full_name: z.string().min(1),
  })
  .passthrough();

const pushRepositorySchema = z
  .object({
    id: z.number().int().positive(),
    name: z.string().min(1),
    full_name: z.string().min(1),
  })
  .passthrough();

const repositoryOwnerSchema = z
  .object({
    login: z.string().min(1),
  })
  .passthrough();

const repositoryWebhookRepositorySchema = z
  .object({
    id: z.number().int().positive(),
    name: z.string().min(1),
    full_name: z.string().min(1),
    owner: repositoryOwnerSchema,
    default_branch: z.string().min(1).nullable().optional(),
    visibility: z.string().min(1).optional(),
    private: z.boolean().optional(),
    archived: z.boolean().default(false),
    stargazers_count: z.number().int().nonnegative().nullable().optional(),
    watchers_count: z.number().int().nonnegative().nullable().optional(),
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
  installation: installationReferenceSchema,
  repository: pullRequestRepositorySchema,
  pull_request: pullRequestSchema,
  changes: pullRequestChangesSchema,
  sender: senderSchema.optional(),
});

export type GitHubPullRequestWebhookPayload = z.infer<
  typeof githubPullRequestWebhookPayloadSchema
>;

export const githubPushWebhookPayloadSchema = z.object({
  ref: z.string().min(1),
  deleted: z.boolean().default(false),
  installation: installationReferenceSchema,
  repository: pushRepositorySchema,
  sender: senderSchema.optional(),
});

export type GitHubPushWebhookPayload = z.infer<
  typeof githubPushWebhookPayloadSchema
>;

export const githubRepositoryWebhookPayloadSchema = z.object({
  action: z.string().min(1),
  installation: installationReferenceSchema,
  repository: repositoryWebhookRepositorySchema,
  sender: senderSchema.optional(),
});

export type GitHubRepositoryWebhookPayload = z.infer<
  typeof githubRepositoryWebhookPayloadSchema
>;

export const githubAppAuthorizationWebhookPayloadSchema = z.object({
  action: z.literal("revoked"),
  sender: senderSchema,
});

export type GitHubAppAuthorizationWebhookPayload = z.infer<
  typeof githubAppAuthorizationWebhookPayloadSchema
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

export type GitHubPushWebhookEnvelope = {
  readonly deliveryId: string;
  readonly eventName: "push";
  readonly payloadHash?: string;
  readonly payload: GitHubPushWebhookPayload;
};

export type GitHubRepositoryWebhookEnvelope = {
  readonly deliveryId: string;
  readonly eventName: "repository";
  readonly payloadHash?: string;
  readonly payload: GitHubRepositoryWebhookPayload;
};

export type GitHubAppAuthorizationWebhookEnvelope = {
  readonly deliveryId: string;
  readonly eventName: "github_app_authorization";
  readonly payloadHash?: string;
  readonly payload: GitHubAppAuthorizationWebhookPayload;
};

export type GitHubPullRequestWebhookHandlerPort = {
  handleGitHubPullRequestWebhook(
    envelope: GitHubPullRequestWebhookEnvelope,
  ): Promise<Record<string, unknown>>;
};

export type GitHubPushWebhookHandlerPort = {
  handleGitHubPushWebhook(
    envelope: GitHubPushWebhookEnvelope,
  ): Promise<Record<string, unknown>>;
};

export type GitHubRepositoryWebhookHandlerPort = {
  handleGitHubRepositoryWebhook(
    envelope: GitHubRepositoryWebhookEnvelope,
  ): Promise<Record<string, unknown>>;
};

export type GitHubAppAuthorizationWebhookHandlerPort = {
  handleGitHubAppAuthorizationWebhook(
    envelope: GitHubAppAuthorizationWebhookEnvelope,
  ): Promise<Record<string, unknown>>;
};

export const supportedGitHubInstallationWebhookEvents = [
  "github_app_authorization",
  "installation",
  "installation_repositories",
  "pull_request",
  "push",
  "repository",
] as const;

export function isSupportedGitHubInstallationWebhookEvent(
  eventName: string,
): eventName is (typeof supportedGitHubInstallationWebhookEvents)[number] {
  return supportedGitHubInstallationWebhookEvents.includes(
    eventName as (typeof supportedGitHubInstallationWebhookEvents)[number],
  );
}
