import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ObserveRunnerCleanup } from "./release-witness-application.js";

const authorize = (request: FastifyRequest, expected: string): void => {
  const header = request.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : "";
  const actual = createHash("sha256").update(token).digest();
  const expectedBuffer = Buffer.from(expected, "hex");
  if (
    expectedBuffer.length !== actual.length ||
    !timingSafeEqual(actual, expectedBuffer)
  )
    throw Object.assign(new Error("release_witness_trigger_unauthorized"), {
      statusCode: 401,
    });
};

export async function registerReleaseWitnessRoutes(
  app: FastifyInstance,
  input: {
    observeCleanup: ObserveRunnerCleanup;
    triggerTokenSha256: string;
  },
): Promise<void> {
  app.post<{ Params: { jobId: string } }>(
    "/v1/runner-jobs/:jobId/cleanup-observation",
    {
      preHandler: async (request) =>
        authorize(request, input.triggerTokenSha256),
    },
    async (request, reply) => {
      const body = request.body;
      if (
        !body ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        Object.keys(body).length !== 0
      )
        throw Object.assign(
          new Error("release_witness_trigger_request_invalid"),
          { statusCode: 400 },
        );
      await input.observeCleanup.execute(request.params.jobId);
      return reply.code(204).send();
    },
  );
}
