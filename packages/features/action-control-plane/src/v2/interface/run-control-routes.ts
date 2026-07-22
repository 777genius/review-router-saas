import type { FastifyInstance } from "fastify";
import {
  createReviewActionV2InvalidRequestResponse,
  createReviewActionV2UnsupportedProtocolResponse,
  parseReviewRunAuthorizeNegotiationRequest,
  reviewRunAuthorizeNegotiationBodyLimitBytes,
  reviewRunAuthorizeNegotiationPath,
  ReviewActionV2OperationId,
} from "@reviewrouter/protocol-review-action-v2";
import {
  registerReviewActionV2Operation,
  type ReviewActionV2EnabledHandler,
  type ReviewActionV2RouteRuntimeDependencies,
} from "./review-action-v2-route-support.js";

export type RegisterReviewRunControlV2RoutesDependencies =
  ReviewActionV2RouteRuntimeDependencies & {
    readonly authorize?: ReviewActionV2EnabledHandler<ReviewActionV2OperationId.ReviewRunAuthorize>;
    readonly renew?: ReviewActionV2EnabledHandler<ReviewActionV2OperationId.ReviewRunRenew>;
  };

export async function registerReviewRunControlV2Routes(
  app: FastifyInstance,
  dependencies: RegisterReviewRunControlV2RoutesDependencies,
): Promise<void> {
  if (dependencies.authorize) {
    registerReviewActionV2Operation(
      app,
      ReviewActionV2OperationId.ReviewRunAuthorize,
      dependencies,
      dependencies.authorize,
    );
  } else {
    registerAuthorizeNegotiationBridge(app, dependencies);
  }
  registerReviewActionV2Operation(
    app,
    ReviewActionV2OperationId.ReviewRunRenew,
    dependencies,
    dependencies.renew,
  );
}

function registerAuthorizeNegotiationBridge(
  app: FastifyInstance,
  dependencies: RegisterReviewRunControlV2RoutesDependencies,
): void {
  app.post(
    reviewRunAuthorizeNegotiationPath,
    { bodyLimit: reviewRunAuthorizeNegotiationBodyLimitBytes },
    async (request, reply) => {
      const parsed = parseReviewRunAuthorizeNegotiationRequest(request.body);
      const serverTime = (await dependencies.readServerTime()).toISOString();

      if (!parsed.ok) {
        return reply.code(400).send(
          createReviewActionV2InvalidRequestResponse({
            requestId: parsed.requestId ?? dependencies.createRequestId(),
            serverTime,
            issues: parsed.issues,
          }),
        );
      }

      return reply.code(426).send(
        createReviewActionV2UnsupportedProtocolResponse({
          requestId: parsed.value.requestId,
          serverTime,
        }),
      );
    },
  );
}
