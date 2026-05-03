import type { Clock } from "@reviewrouter/shared";
import { installationStatusForAction } from "../../domain/github-installation";
import type { GitHubWebhookEnvelope } from "../../domain/github-webhook";
import { normalizeGitHubWebhookEvent } from "../../domain/github-webhook-normalization";
import type { GitHubInstallationRepositoryPort } from "../ports/github-installation-repository-port";
import type { InstallationSyncRequestPort } from "../ports/installation-sync-request-port";
import type { WebhookDeliveryRepositoryPort } from "../ports/webhook-delivery-repository-port";

export type HandleGitHubInstallationWebhookDependencies = {
  readonly installations: GitHubInstallationRepositoryPort;
  readonly deliveries: WebhookDeliveryRepositoryPort;
  readonly syncRequests?: InstallationSyncRequestPort;
  readonly clock: Clock;
};

export type HandleGitHubInstallationWebhookResult = {
  readonly processed: boolean;
  readonly status?: string;
};

export async function handleGitHubInstallationWebhook(
  envelope: GitHubWebhookEnvelope,
  dependencies: HandleGitHubInstallationWebhookDependencies,
): Promise<HandleGitHubInstallationWebhookResult> {
  const installationId = String(envelope.payload.installation.id);
  const normalizedEvent = normalizeGitHubWebhookEvent(envelope);
  const started = await dependencies.deliveries.tryStartProcessing({
    deliveryId: envelope.deliveryId,
    eventName: envelope.eventName,
    action: envelope.payload.action,
    installationId,
    ...(envelope.payloadHash ? { payloadHash: envelope.payloadHash } : {}),
    ...(normalizedEvent ? { normalizedEvent } : {}),
  });
  if (!started) {
    return { processed: false };
  }

  try {
    if (envelope.eventName === "installation_repositories") {
      await dependencies.installations.upsertInstallation({
        githubInstallationId: installationId,
        accountLogin: envelope.payload.installation.account.login,
        accountType: envelope.payload.installation.account.type,
        repositorySelection:
          envelope.payload.repository_selection ??
          envelope.payload.installation.repository_selection,
        status: "active",
      });
      await dependencies.syncRequests?.requestInstallationSync({
        githubInstallationId: installationId,
        deliveryId: envelope.deliveryId,
        reason: "installation_repositories_changed",
        occurredAt: dependencies.clock.now(),
      });
      await dependencies.deliveries.markProcessed(envelope.deliveryId);
      return { processed: true, status: "active" };
    }

    const status = installationStatusForAction(envelope.payload.action);
    if (envelope.eventName !== "installation" || status === null) {
      await dependencies.deliveries.markProcessed(envelope.deliveryId);
      return { processed: true };
    }

    if (status === "removed") {
      await dependencies.installations.markInstallationRemoved(installationId);
    } else {
      await dependencies.installations.upsertInstallation({
        githubInstallationId: installationId,
        accountLogin: envelope.payload.installation.account.login,
        accountType: envelope.payload.installation.account.type,
        repositorySelection: envelope.payload.installation.repository_selection,
        status,
      });
      if (status === "active") {
        await dependencies.syncRequests?.requestInstallationSync({
          githubInstallationId: installationId,
          deliveryId: envelope.deliveryId,
          reason: "installation_access_changed",
          occurredAt: dependencies.clock.now(),
        });
      }
    }

    await dependencies.deliveries.markProcessed(envelope.deliveryId);
    return { processed: true, status };
  } catch (error) {
    await dependencies.deliveries.markFailed({
      deliveryId: envelope.deliveryId,
      errorSummary: safeErrorSummary(error),
    });
    throw error;
  }
}

function safeErrorSummary(error: unknown): string {
  const message = error instanceof Error ? error.message : "unknown_error";
  return message.slice(0, 500);
}
