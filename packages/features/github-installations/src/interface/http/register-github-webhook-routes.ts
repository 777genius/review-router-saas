import type { FastifyInstance, FastifyRequest } from "fastify";
import rawBody from "fastify-raw-body";
import { githubInstallationWebhookPayloadSchema } from "../../domain/github-webhook.js";
import { handleGitHubInstallationWebhook } from "../../application/use-cases/handle-github-installation-webhook.js";
import type { GitHubInstallationRepositoryPort } from "../../application/ports/github-installation-repository-port.js";
import type { WebhookDeliveryRepositoryPort } from "../../application/ports/webhook-delivery-repository-port.js";
import { verifyGitHubWebhookSignature } from "../../infrastructure/crypto/github-webhook-signature.js";

export type RegisterGitHubWebhookRoutesDependencies = {
  readonly webhookSecret: string;
  readonly installations: GitHubInstallationRepositoryPort;
  readonly deliveries: WebhookDeliveryRepositoryPort;
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

    const payload = githubInstallationWebhookPayloadSchema.parse(request.body);
    const result = await handleGitHubInstallationWebhook(
      { deliveryId, eventName, payload },
      dependencies,
    );

    return reply.send(result);
  });
}
