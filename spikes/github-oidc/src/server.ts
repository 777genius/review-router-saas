import Fastify from "fastify";
import { z } from "zod";
import { loadEnvFiles } from "./config.js";
import {
  createActionSessionToken,
  verifyActionSessionToken,
  verifyGitHubOidcToken,
} from "./oidc.js";
import { parseHealthReport } from "./privacy.js";

loadEnvFiles();

const exchangeBodySchema = z.object({ token: z.string().min(20) });
const port = Number(process.env.REVIEW_ROUTER_SPIKE_PORT || 8787);
const audience =
  process.env.REVIEW_ROUTER_OIDC_AUDIENCE || "review-router-spike";
const allowedRepositoryId =
  process.env.REVIEW_ROUTER_ALLOWED_REPOSITORY_ID || undefined;
const sessionSecret =
  process.env.REVIEW_ROUTER_ACTION_SESSION_SECRET ||
  "dev-only-review-router-spike-secret-at-least-32-bytes";

export function buildServer() {
  const app = Fastify({ logger: true, bodyLimit: 128 * 1024 });

  app.get("/healthz", async () => ({ ok: true }));

  app.post("/api/action/v1/session/exchange", async (request, reply) => {
    const { token } = exchangeBodySchema.parse(request.body);
    const claims = await verifyGitHubOidcToken(
      token,
      audience,
      allowedRepositoryId,
    );
    const sessionToken = await createActionSessionToken(claims, sessionSecret);
    return reply.send({
      actionSessionToken: sessionToken,
      expiresInSeconds: 900,
      repository: claims.repository,
      repositoryId: claims.repository_id,
      eventName: claims.event_name,
      runId: claims.run_id,
      runAttempt: claims.run_attempt,
    });
  });

  app.get("/api/action/v1/config", async (request, reply) => {
    const authorization = request.headers.authorization;
    const token = authorization?.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length)
      : "";
    if (!token)
      return reply
        .code(401)
        .send({ error: { code: "ACTION_SESSION_REQUIRED" } });
    await verifyActionSessionToken(token, sessionSecret);
    return {
      protocolVersion: "v1",
      configSchemaVersion: 1,
      configVersion: 1,
      providers: ["codex/gpt-5.5"],
      modelEffort: "medium",
      preset: "safe-default",
      limits: { inlineMaxComments: 5, maxDiffBytes: 200_000 },
    };
  });

  app.post("/api/action/v1/health-report", async (request, reply) => {
    const authorization = request.headers.authorization;
    const token = authorization?.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length)
      : "";
    if (!token)
      return reply
        .code(401)
        .send({ error: { code: "ACTION_SESSION_REQUIRED" } });
    await verifyActionSessionToken(token, sessionSecret);
    const report = parseHealthReport(request.body);
    return reply.send({ ok: true, accepted: report.status });
  });

  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = buildServer();
  await server.listen({ port, host: "0.0.0.0" });
}
