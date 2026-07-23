import type { FastifyInstance } from "fastify";
import { ReviewActionV2OperationId } from "@reviewrouter/protocol-review-action-v2";
import {
  registerReviewActionV2Operation,
  type ReviewActionV2EnabledHandler,
  type ReviewActionV2RouteRuntimeDependencies,
} from "./review-action-v2-route-support.js";

export type RegisterReviewPublicationRequestV2RoutesDependencies =
  ReviewActionV2RouteRuntimeDependencies & {
    readonly request?: ReviewActionV2EnabledHandler<ReviewActionV2OperationId.ReviewPublicationRequest>;
    readonly status?: ReviewActionV2EnabledHandler<ReviewActionV2OperationId.ReviewPublicationStatus>;
  };

export async function registerReviewPublicationRequestV2Routes(
  app: FastifyInstance,
  dependencies: RegisterReviewPublicationRequestV2RoutesDependencies,
): Promise<void> {
  registerReviewActionV2Operation(
    app,
    ReviewActionV2OperationId.ReviewPublicationRequest,
    dependencies,
    dependencies.request,
  );
  registerReviewActionV2Operation(
    app,
    ReviewActionV2OperationId.ReviewPublicationStatus,
    dependencies,
    dependencies.status,
  );
}
