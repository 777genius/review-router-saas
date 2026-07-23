import { z } from "zod";

export const githubReviewRequestIngressEventType =
  "github.pull_request.review_request_ingress";
export const githubReviewRequestIngressEventVersion = 1;

export enum GitHubReviewRequestIngressCommandKind {
  Request = "request",
  Cancel = "cancel",
}

export enum GitHubReviewRequestTriggerAction {
  Opened = "opened",
  Synchronize = "synchronize",
  Reopened = "reopened",
  ReadyForReview = "ready_for_review",
  ConvertedToDraft = "converted_to_draft",
  Closed = "closed",
  Edited = "edited",
}

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const gitShaSchema = z.string().regex(/^[a-f0-9]{40}$/i);
const baseSchema = z.object({
  protocolVersion: z.literal(1),
  commandKind: z.enum(GitHubReviewRequestIngressCommandKind),
  triggerAction: z.enum(GitHubReviewRequestTriggerAction),
  deliveryIdentityHash: sha256Schema,
  githubInstallationId: z.string().regex(/^[1-9][0-9]*$/),
  githubRepositoryId: z.string().regex(/^[1-9][0-9]*$/),
  repositoryFullName: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
  pullRequestNumber: z.number().int().positive(),
});

const requestSchema = baseSchema.extend({
  commandKind: z.literal(GitHubReviewRequestIngressCommandKind.Request),
  expectedBaseSha: gitShaSchema,
  expectedHeadSha: gitShaSchema,
  draftAtIngress: z.boolean(),
});

const cancelSchema = baseSchema.extend({
  commandKind: z.literal(GitHubReviewRequestIngressCommandKind.Cancel),
});

const payloadSchema = z.discriminatedUnion("commandKind", [
  requestSchema,
  cancelSchema,
]);

export type GitHubReviewRequestIngressPayload = z.infer<typeof payloadSchema>;

export function parseGitHubReviewRequestIngressPayload(
  value: unknown,
): GitHubReviewRequestIngressPayload {
  return payloadSchema.parse(value);
}
