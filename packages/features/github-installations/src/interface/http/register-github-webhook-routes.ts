import type { FastifyInstance, FastifyRequest } from "fastify";
import rawBody from "fastify-raw-body";
import {
  githubInstallationWebhookPayloadSchema,
  githubPullRequestWebhookPayloadSchema,
  isSupportedGitHubInstallationWebhookEvent,
  type GitHubPullRequestWebhookHandlerPort,
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

      const result =
        await dependencies.pullRequests.handleGitHubPullRequestWebhook({
          deliveryId,
          eventName,
          payloadHash: hashGitHubWebhookPayload(rawPayload),
          payload: parsedPullRequestPayload.data,
        });

      return reply.send(result);
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
