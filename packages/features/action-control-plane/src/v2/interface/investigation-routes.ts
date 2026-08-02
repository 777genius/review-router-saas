import type { FastifyInstance } from "fastify";
import { ReviewActionV2OperationId } from "@reviewrouter/protocol-review-action-v2";
import {
  registerReviewActionV2Operation,
  type ReviewActionV2EnabledHandler,
  type ReviewActionV2RouteRuntimeDependencies,
} from "./review-action-v2-route-support.js";

export type RegisterReviewInvestigationV2RoutesDependencies =
  ReviewActionV2RouteRuntimeDependencies & {
    readonly open?: ReviewActionV2EnabledHandler<ReviewActionV2OperationId.ReviewInvestigationOpen>;
    readonly restore?: ReviewActionV2EnabledHandler<ReviewActionV2OperationId.ReviewInvestigationRestore>;
    readonly planTurn?: ReviewActionV2EnabledHandler<ReviewActionV2OperationId.ReviewInvestigationTurnPlan>;
    readonly commitTurn?: ReviewActionV2EnabledHandler<ReviewActionV2OperationId.ReviewInvestigationTurnCommit>;
    readonly abortTurn?: ReviewActionV2EnabledHandler<ReviewActionV2OperationId.ReviewInvestigationTurnAbort>;
    readonly conclude?: ReviewActionV2EnabledHandler<ReviewActionV2OperationId.ReviewInvestigationConclude>;
  };

export async function registerReviewInvestigationV2Routes(
  app: FastifyInstance,
  dependencies: RegisterReviewInvestigationV2RoutesDependencies,
): Promise<void> {
  registerReviewActionV2Operation(
    app,
    ReviewActionV2OperationId.ReviewInvestigationOpen,
    dependencies,
    dependencies.open,
  );
  registerReviewActionV2Operation(
    app,
    ReviewActionV2OperationId.ReviewInvestigationRestore,
    dependencies,
    dependencies.restore,
  );
  registerReviewActionV2Operation(
    app,
    ReviewActionV2OperationId.ReviewInvestigationTurnPlan,
    dependencies,
    dependencies.planTurn,
  );
  registerReviewActionV2Operation(
    app,
    ReviewActionV2OperationId.ReviewInvestigationTurnCommit,
    dependencies,
    dependencies.commitTurn,
  );
  registerReviewActionV2Operation(
    app,
    ReviewActionV2OperationId.ReviewInvestigationTurnAbort,
    dependencies,
    dependencies.abortTurn,
  );
  registerReviewActionV2Operation(
    app,
    ReviewActionV2OperationId.ReviewInvestigationConclude,
    dependencies,
    dependencies.conclude,
  );
}
