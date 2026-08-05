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
    readonly openV2?: ReviewActionV2EnabledHandler<ReviewActionV2OperationId.ReviewInvestigationOpenV2>;
    readonly restore?: ReviewActionV2EnabledHandler<ReviewActionV2OperationId.ReviewInvestigationRestore>;
    readonly planTurn?: ReviewActionV2EnabledHandler<ReviewActionV2OperationId.ReviewInvestigationTurnPlan>;
    readonly acquireLease?: ReviewActionV2EnabledHandler<ReviewActionV2OperationId.ReviewInvestigationLeaseAcquire>;
    readonly renewLease?: ReviewActionV2EnabledHandler<ReviewActionV2OperationId.ReviewInvestigationLeaseRenew>;
    readonly releaseLease?: ReviewActionV2EnabledHandler<ReviewActionV2OperationId.ReviewInvestigationLeaseRelease>;
    readonly commitTurn?: ReviewActionV2EnabledHandler<ReviewActionV2OperationId.ReviewInvestigationTurnCommit>;
    readonly abortTurn?: ReviewActionV2EnabledHandler<ReviewActionV2OperationId.ReviewInvestigationTurnAbort>;
    readonly conclude?: ReviewActionV2EnabledHandler<ReviewActionV2OperationId.ReviewInvestigationConclude>;
    readonly replay?: ReviewActionV2EnabledHandler<ReviewActionV2OperationId.ReviewInvestigationReplay>;
    readonly replayV2?: ReviewActionV2EnabledHandler<ReviewActionV2OperationId.ReviewInvestigationReplayV2>;
    readonly prepareReplay?: ReviewActionV2EnabledHandler<ReviewActionV2OperationId.ReviewInvestigationReplayPrepare>;
  };

export async function registerReviewInvestigationV2Routes(
  app: FastifyInstance,
  dependencies: RegisterReviewInvestigationV2RoutesDependencies,
): Promise<void> {
  registerReviewActionV2Operation(
    app,
    ReviewActionV2OperationId.ReviewInvestigationReplayPrepare,
    dependencies,
    dependencies.prepareReplay,
  );
  registerReviewActionV2Operation(
    app,
    ReviewActionV2OperationId.ReviewInvestigationReplay,
    dependencies,
    dependencies.replay,
  );
  registerReviewActionV2Operation(
    app,
    ReviewActionV2OperationId.ReviewInvestigationReplayV2,
    dependencies,
    dependencies.replayV2,
  );
  registerReviewActionV2Operation(
    app,
    ReviewActionV2OperationId.ReviewInvestigationOpen,
    dependencies,
    dependencies.open,
  );
  registerReviewActionV2Operation(
    app,
    ReviewActionV2OperationId.ReviewInvestigationOpenV2,
    dependencies,
    dependencies.openV2,
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
    ReviewActionV2OperationId.ReviewInvestigationLeaseAcquire,
    dependencies,
    dependencies.acquireLease,
  );
  registerReviewActionV2Operation(
    app,
    ReviewActionV2OperationId.ReviewInvestigationLeaseRenew,
    dependencies,
    dependencies.renewLease,
  );
  registerReviewActionV2Operation(
    app,
    ReviewActionV2OperationId.ReviewInvestigationLeaseRelease,
    dependencies,
    dependencies.releaseLease,
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
