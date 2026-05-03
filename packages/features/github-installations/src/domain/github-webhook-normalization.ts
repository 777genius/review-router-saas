import { createHash } from "node:crypto";
import type { GitHubWebhookEnvelope } from "./github-webhook.js";

export type NormalizedGitHubWebhookEvent = {
  readonly type: "github.installation";
  readonly version: 1;
  readonly action: string;
  readonly installationId: string;
  readonly accountLogin: string;
  readonly accountType: string;
  readonly repositorySelection: string;
};

export function hashGitHubWebhookPayload(rawPayload: Buffer): string {
  return createHash("sha256").update(rawPayload).digest("hex");
}

export function normalizeGitHubWebhookEvent(
  envelope: GitHubWebhookEnvelope,
): NormalizedGitHubWebhookEvent | null {
  if (envelope.eventName !== "installation") {
    return null;
  }

  return {
    type: "github.installation",
    version: 1,
    action: envelope.payload.action,
    installationId: String(envelope.payload.installation.id),
    accountLogin: envelope.payload.installation.account.login,
    accountType: envelope.payload.installation.account.type,
    repositorySelection: envelope.payload.installation.repository_selection,
  };
}
