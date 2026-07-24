import type { FastifyInstance } from "fastify";
import { ReviewActionV2OperationId } from "@reviewrouter/protocol-review-action-v2";
import {
  registerReviewActionV2Operation,
  type ReviewActionV2EnabledHandler,
  type ReviewActionV2RouteRuntimeDependencies,
} from "./review-action-v2-route-support.js";

export type RegisterReviewContextAttestationV2RoutesDependencies =
  ReviewActionV2RouteRuntimeDependencies & {
    readonly openGateway?: ReviewActionV2EnabledHandler<ReviewActionV2OperationId.ReviewContextGatewayOpen>;
    readonly sealGateway?: ReviewActionV2EnabledHandler<ReviewActionV2OperationId.ReviewContextGatewaySeal>;
    readonly commitReplay?: ReviewActionV2EnabledHandler<ReviewActionV2OperationId.ReviewContextReplayCommit>;
  };

export async function registerReviewContextAttestationV2Routes(
  app: FastifyInstance,
  dependencies: RegisterReviewContextAttestationV2RoutesDependencies,
): Promise<void> {
  registerReviewActionV2Operation(
    app,
    ReviewActionV2OperationId.ReviewContextGatewayOpen,
    dependencies,
    dependencies.openGateway,
  );
  registerReviewActionV2Operation(
    app,
    ReviewActionV2OperationId.ReviewContextGatewaySeal,
    dependencies,
    dependencies.sealGateway,
  );
  registerReviewActionV2Operation(
    app,
    ReviewActionV2OperationId.ReviewContextReplayCommit,
    dependencies,
    dependencies.commitReplay,
  );
}
