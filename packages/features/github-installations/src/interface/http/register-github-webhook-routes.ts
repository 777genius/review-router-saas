import type { FastifyInstance, FastifyRequest } from "fastify";
import rawBody from "fastify-raw-body";
import {
  githubInstallationWebhookPayloadSchema,
  githubPullRequestWebhookPayloadSchema,
  githubRepositoryWebhookPayloadSchema,
  isSupportedGitHubInstallationWebhookEvent,
  type GitHubPullRequestWebhookHandlerPort,
  type GitHubRepositoryWebhookHandlerPort,
} from "../../domain/github-webhook";
import { hashGitHubWebhookPayload } from "../../domain/github-webhook-normalization";
import { handleGitHubInstallationWebhook } from "../../application/use-cases/handle-github-installation-webhook";
import type { GitHubInstallationRepositoryPort } from "../../application/ports/github-installation-repository-port";
import type { WebhookDeliveryRepositoryPort } from "../../application/ports/webhook-delivery-repository-port";
import type { InstallationWorkspaceOwnerGrantPort } from "../../application/ports/installation-workspace-owner-grant-port";
import type { InstallationSyncRequestPort } from "../../application/ports/installation-sync-request-port";
import { verifyGitHubWebhookSignature } from "../../infrastructure/crypto/github-webhook-signature";
import type { Clock } from "@reviewrouter/shared";

export type RegisterGitHubWebhookRoutesDependencies = {
  readonly webhookSecret: string;
  readonly installations: GitHubInstallationRepositoryPort;
  readonly deliveries: WebhookDeliveryRepositoryPort;
  readonly ownerGrants?: InstallationWorkspaceOwnerGrantPort;
  readonly syncRequests?: InstallationSyncRequestPort;
  readonly pullRequests?: GitHubPullRequestWebhookHandlerPort;
  readonly repositories?: GitHubRepositoryWebhookHandlerPort;
  readonly clock: Clock;
};

type RawBodyRequest = FastifyRequest & { readonly rawBody?: Buffer };

export async function registerGitHubWebhookRoutes(
  app: FastifyInstance,
  dependencies: RegisterGitHubWebhookRoutesDependencies,
): Promise<void> {
  await app.register(rawBody, {
    field: "rawBody",
    global: false,
    encoding: false,
    runFirst: true,
    routes: ["/webhooks/github"],
  });

  app.post("/webhooks/github", async (request, reply) => {
    const rawPayload = (request as RawBodyRequest).rawBody;
    const deliveryId = request.headers["x-github-delivery"];
    const eventName = request.headers["x-github-event"];
    const signature = request.headers["x-hub-signature-256"];

    if (!rawPayload || Buffer.isBuffer(rawPayload) === false) {
      return reply.code(400).send({ error: "missing_raw_body" });
    }
    if (typeof deliveryId !== "string" || typeof eventName !== "string") {
      return reply.code(400).send({ error: "missing_github_headers" });
    }
    if (
      verifyGitHubWebhookSignature({
        payload: rawPayload,
        signatureHeader: typeof signature === "string" ? signature : undefined,
        secret: dependencies.webhookSecret,
      }) === false
    ) {
      return reply.code(401).send({ error: "invalid_signature" });
    }
    if (!isSupportedGitHubInstallationWebhookEvent(eventName)) {
      return reply
        .code(202)
        .send({ processed: false, ignored: true, eventName });
    }

    if (eventName === "pull_request") {
      const parsedPullRequestPayload =
        githubPullRequestWebhookPayloadSchema.safeParse(request.body);
      if (!parsedPullRequestPayload.success) {
        return reply.code(400).send({ error: "invalid_webhook_payload" });
      }
      if (!dependencies.pullRequests) {
        return reply
          .code(202)
          .send({ processed: false, ignored: true, eventName });
      }

      const started = await dependencies.deliveries.tryStartProcessing({
        deliveryId,
        eventName,
        action: parsedPullRequestPayload.data.action,
        installationId: String(parsedPullRequestPayload.data.installation.id),
        ...(rawPayload
          ? { payloadHash: hashGitHubWebhookPayload(rawPayload) }
          : {}),
        normalizedEvent: {
          type: "github.pull_request",
          version: 1,
          action: parsedPullRequestPayload.data.action,
          installationId: String(parsedPullRequestPayload.data.installation.id),
          repositoryId: String(parsedPullRequestPayload.data.repository.id),
          repositoryFullName:
            parsedPullRequestPayload.data.repository.full_name,
          pullRequestNumber: parsedPullRequestPayload.data.pull_request.number,
          merged: parsedPullRequestPayload.data.pull_request.merged,
        },
      });
      if (!started) {
        return reply.send({ processed: false });
      }

      try {
        const result =
          await dependencies.pullRequests.handleGitHubPullRequestWebhook({
            deliveryId,
            eventName,
            payloadHash: hashGitHubWebhookPayload(rawPayload),
            payload: parsedPullRequestPayload.data,
          });
        await dependencies.deliveries.markProcessed(deliveryId);
        return reply.send(result);
      } catch (error) {
        await dependencies.deliveries.markFailed({
          deliveryId,
          errorSummary: safeErrorSummary(error),
        });
        throw error;
      }
    }

    if (eventName === "repository") {
      const parsedRepositoryPayload =
        githubRepositoryWebhookPayloadSchema.safeParse(request.body);
      if (!parsedRepositoryPayload.success) {
        return reply.code(400).send({ error: "invalid_webhook_payload" });
      }
      if (!dependencies.repositories) {
        return reply
          .code(202)
          .send({ processed: false, ignored: true, eventName });
      }

      const started = await dependencies.deliveries.tryStartProcessing({
        deliveryId,
        eventName,
        action: parsedRepositoryPayload.data.action,
        installationId: String(parsedRepositoryPayload.data.installation.id),
        ...(rawPayload
          ? { payloadHash: hashGitHubWebhookPayload(rawPayload) }
          : {}),
        normalizedEvent: {
          type: "github.repository",
          version: 1,
          action: parsedRepositoryPayload.data.action,
          installationId: String(parsedRepositoryPayload.data.installation.id),
          repositoryId: String(parsedRepositoryPayload.data.repository.id),
          repositoryFullName:
            parsedRepositoryPayload.data.repository.full_name,
          defaultBranch:
            parsedRepositoryPayload.data.repository.default_branch ?? null,
          visibility: normalizeRepositoryWebhookVisibility(
            parsedRepositoryPayload.data.repository,
          ),
          archived: parsedRepositoryPayload.data.repository.archived,
        },
      });
      if (!started) {
        return reply.send({ processed: false });
      }

      try {
        const result =
          await dependencies.repositories.handleGitHubRepositoryWebhook({
            deliveryId,
            eventName,
            payloadHash: hashGitHubWebhookPayload(rawPayload),
            payload: parsedRepositoryPayload.data,
          });
        await dependencies.deliveries.markProcessed(deliveryId);
        return reply.send(result);
      } catch (error) {
        await dependencies.deliveries.markFailed({
          deliveryId,
          errorSummary: safeErrorSummary(error),
        });
        throw error;
      }
    }

    const parsedPayload = githubInstallationWebhookPayloadSchema.safeParse(
      request.body,
    );
    if (!parsedPayload.success) {
      return reply.code(400).send({ error: "invalid_webhook_payload" });
    }

    const result = await handleGitHubInstallationWebhook(
      {
        deliveryId,
        eventName,
        payloadHash: hashGitHubWebhookPayload(rawPayload),
        payload: parsedPayload.data,
      },
      dependencies,
    );

    return reply.send(result);
  });
}

function safeErrorSummary(error: unknown): string {
  const message = error instanceof Error ? error.message : "unknown_error";
  return message.slice(0, 500);
}

function normalizeRepositoryWebhookVisibility(repository: {
  readonly visibility?: string | undefined;
  readonly private?: boolean | undefined;
}): "public" | "private" | "internal" {
  if (repository.visibility === "internal") return "internal";
  if (repository.private) return "private";
  return "public";
}
