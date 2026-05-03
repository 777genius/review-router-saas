import { installationStatusForAction } from "../../domain/github-installation.js";
import type { GitHubWebhookEnvelope } from "../../domain/github-webhook.js";
import type { GitHubInstallationRepositoryPort } from "../ports/github-installation-repository-port.js";
import type { WebhookDeliveryRepositoryPort } from "../ports/webhook-delivery-repository-port.js";

export type HandleGitHubInstallationWebhookDependencies = {
  readonly installations: GitHubInstallationRepositoryPort;
  readonly deliveries: WebhookDeliveryRepositoryPort;
};

export type HandleGitHubInstallationWebhookResult = {
  readonly processed: boolean;
  readonly status?: string;
};

export async function handleGitHubInstallationWebhook(
  envelope: GitHubWebhookEnvelope,
  dependencies: HandleGitHubInstallationWebhookDependencies,
): Promise<HandleGitHubInstallationWebhookResult> {
  if (await dependencies.deliveries.wasProcessed(envelope.deliveryId)) {
    return { processed: false };
  }

  const status = installationStatusForAction(envelope.payload.action);
  if (envelope.eventName !== "installation" || status === null) {
    await dependencies.deliveries.recordProcessed({
      deliveryId: envelope.deliveryId,
      eventName: envelope.eventName,
      action: envelope.payload.action,
      installationId: String(envelope.payload.installation.id),
    });
    return { processed: true };
  }

  const installationId = String(envelope.payload.installation.id);

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
  }

  await dependencies.deliveries.recordProcessed({
    deliveryId: envelope.deliveryId,
    eventName: envelope.eventName,
    action: envelope.payload.action,
    installationId,
  });

  return { processed: true, status };
}
