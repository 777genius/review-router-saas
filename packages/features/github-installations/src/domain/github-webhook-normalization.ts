import { createHash } from "node:crypto";
import type { GitHubWebhookEnvelope } from "./github-webhook.js";

export type NormalizedGitHubWebhookEvent =
  | {
      readonly type: "github.installation";
      readonly version: 1;
      readonly action: string;
      readonly installationId: string;
      readonly accountLogin: string;
      readonly accountType: string;
      readonly repositorySelection: string;
    }
  | {
      readonly type: "github.installation_repositories";
      readonly version: 1;
      readonly action: string;
      readonly installationId: string;
      readonly repositorySelection: string;
      readonly repositoriesAdded: number;
      readonly repositoriesRemoved: number;
      readonly repositoryIdsAdded: readonly string[];
      readonly repositoryIdsRemoved: readonly string[];
    };

export function hashGitHubWebhookPayload(rawPayload: Buffer): string {
  return createHash("sha256").update(rawPayload).digest("hex");
}

export function normalizeGitHubWebhookEvent(
  envelope: GitHubWebhookEnvelope,
): NormalizedGitHubWebhookEvent | null {
  if (envelope.eventName === "installation") {
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

  if (envelope.eventName === "installation_repositories") {
    return {
      type: "github.installation_repositories",
      version: 1,
      action: envelope.payload.action,
      installationId: String(envelope.payload.installation.id),
      repositorySelection:
        envelope.payload.repository_selection ??
        envelope.payload.installation.repository_selection,
      repositoriesAdded: envelope.payload.repositories_added.length,
      repositoriesRemoved: envelope.payload.repositories_removed.length,
      repositoryIdsAdded: envelope.payload.repositories_added.map(
        (repository) => String(repository.id),
      ),
      repositoryIdsRemoved: envelope.payload.repositories_removed.map(
        (repository) => String(repository.id),
      ),
    };
  }

  return null;
}
