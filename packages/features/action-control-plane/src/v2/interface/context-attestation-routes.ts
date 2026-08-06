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
    readonly openInvestigationGateway?: ReviewActionV2EnabledHandler<ReviewActionV2OperationId.ReviewInvestigationContextGatewayOpen>;
    readonly sealInvestigationGateway?: ReviewActionV2EnabledHandler<ReviewActionV2OperationId.ReviewInvestigationContextGatewaySeal>;
    readonly commitReplay?: ReviewActionV2EnabledHandler<ReviewActionV2OperationId.ReviewContextReplayCommit>;
    readonly commitReceiptReplay?: ReviewActionV2EnabledHandler<ReviewActionV2OperationId.ReviewContextReceiptReplayCommit>;
  };

export async function registerReviewContextAttestationV2Routes(
  app: FastifyInstance,
  dependencies: RegisterReviewContextAttestationV2RoutesDependencies,
): Promise<void> {
  registerReviewActionV2Operation(
    app,
    ReviewActionV2OperationId.ReviewInvestigationContextGatewayOpen,
    dependencies,
    dependencies.openInvestigationGateway,
  );
  registerReviewActionV2Operation(
    app,
    ReviewActionV2OperationId.ReviewInvestigationContextGatewaySeal,
    dependencies,
    dependencies.sealInvestigationGateway,
  );
  registerReviewActionV2Operation(
    app,
    ReviewActionV2OperationId.ReviewContextReceiptReplayCommit,
    dependencies,
    dependencies.commitReceiptReplay,
  );
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
