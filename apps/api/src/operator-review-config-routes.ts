import type { FastifyInstance, FastifyReply } from "fastify";
import {
  getOperatorReviewConfiguration,
  ReviewConfigurationOperatorError,
  ReviewConfigurationOperatorErrorCode,
  ReviewReasoningEffort,
  setOperatorReviewReasoningEffort,
  type OperatorReviewConfigurationDependencies,
} from "@reviewrouter/features-review-config";
import { scmProviders } from "@reviewrouter/shared";
import { z } from "zod";

const repositoryQuerySchema = z
  .object({
    repo: z.string().trim().min(3).max(255),
    provider: z.enum(scmProviders).default("github"),
    workspace: z.string().trim().min(1).max(120).optional(),
  })
  .strict();

const setReasoningEffortBodySchema = z
  .object({
    repository: z.string().trim().min(3).max(255),
    provider: z.enum(scmProviders).default("github"),
    workspace: z.string().trim().min(1).max(120).optional(),
    effort: z.enum(ReviewReasoningEffort),
  })
  .strict();

export async function registerOperatorReviewConfigRoutes(
  app: FastifyInstance,
  dependencies: OperatorReviewConfigurationDependencies,
): Promise<void> {
  app.get("/api/operator/v1/review-config", async (request, reply) => {
    const query = repositoryQuerySchema.safeParse(request.query);
    if (!query.success) {
      return sendOperatorError(reply, 400, "invalid_request");
    }
    try {
      const result = await getOperatorReviewConfiguration(
        {
          credential: readBearerCredential(request.headers.authorization),
          repositoryFullName: query.data.repo,
          provider: query.data.provider,
          ...(query.data.workspace ? { workspace: query.data.workspace } : {}),
        },
        dependencies,
      );
      return reply
        .header("Cache-Control", "no-store")
        .code(200)
        .send({ result });
    } catch (error) {
      return handleOperatorError(error, reply);
    }
  });

  app.patch(
    "/api/operator/v1/review-config",
    { bodyLimit: 4_096 },
    async (request, reply) => {
      const body = setReasoningEffortBodySchema.safeParse(request.body);
      if (!body.success) {
        return sendOperatorError(reply, 400, "invalid_request");
      }
      try {
        const result = await setOperatorReviewReasoningEffort(
          {
            credential: readBearerCredential(request.headers.authorization),
            repositoryFullName: body.data.repository,
            provider: body.data.provider,
            effort: body.data.effort,
            ...(body.data.workspace ? { workspace: body.data.workspace } : {}),
          },
          dependencies,
        );
        return reply
          .header("Cache-Control", "no-store")
          .code(200)
          .send({ result });
      } catch (error) {
        return handleOperatorError(error, reply);
      }
    },
  );
}

function readBearerCredential(authorization: string | undefined): string {
  if (!authorization) return "";
  const match = authorization.match(/^Bearer ([^\s]+)$/);
  return match?.[1] ?? "";
}

function handleOperatorError(error: unknown, reply: FastifyReply) {
  if (!(error instanceof ReviewConfigurationOperatorError)) {
    throw error;
  }
  switch (error.code) {
    case ReviewConfigurationOperatorErrorCode.Unauthorized:
      return sendOperatorError(reply, 401, error.code);
    case ReviewConfigurationOperatorErrorCode.RepositoryNotFound:
      return sendOperatorError(reply, 404, error.code);
    case ReviewConfigurationOperatorErrorCode.RepositoryAmbiguous:
      return sendOperatorError(reply, 409, error.code);
    case ReviewConfigurationOperatorErrorCode.InvalidRepository:
      return sendOperatorError(reply, 400, error.code);
    case ReviewConfigurationOperatorErrorCode.RateLimited:
      return sendOperatorError(reply, 429, error.code);
    case ReviewConfigurationOperatorErrorCode.ReviewProviderNotFound:
      return sendOperatorError(reply, 409, error.code);
    case ReviewConfigurationOperatorErrorCode.ConfigurationChanged:
      return sendOperatorError(reply, 409, error.code);
    default: {
      const exhaustiveCode: never = error.code;
      return exhaustiveCode;
    }
  }
}

function sendOperatorError(
  reply: FastifyReply,
  statusCode: 400 | 401 | 404 | 409 | 429,
  code: string,
) {
  return reply
    .header("Cache-Control", "no-store")
    .code(statusCode)
    .send({ error: { code } });
}
