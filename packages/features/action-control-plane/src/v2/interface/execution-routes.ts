import type { FastifyInstance } from "fastify";
import { ReviewActionV2OperationId } from "@reviewrouter/protocol-review-action-v2";
import {
  registerReviewActionV2Operation,
  type ReviewActionV2EnabledHandler,
  type ReviewActionV2RouteRuntimeDependencies,
} from "./review-action-v2-route-support.js";

export type RegisterReviewExecutionV2RoutesDependencies =
  ReviewActionV2RouteRuntimeDependencies & {
    readonly restore?: ReviewActionV2EnabledHandler<ReviewActionV2OperationId.ReviewExecutionRestore>;
    readonly start?: ReviewActionV2EnabledHandler<ReviewActionV2OperationId.ReviewExecutionStart>;
    readonly supersede?: ReviewActionV2EnabledHandler<ReviewActionV2OperationId.ReviewExecutionSupersede>;
    readonly attachObservation?: ReviewActionV2EnabledHandler<ReviewActionV2OperationId.ReviewExecutionObservationAttach>;
    readonly adoptObservation?: ReviewActionV2EnabledHandler<ReviewActionV2OperationId.ReviewExecutionObservationAdopt>;
    readonly finalize?: ReviewActionV2EnabledHandler<ReviewActionV2OperationId.ReviewExecutionFinalize>;
    readonly acquireLease?: ReviewActionV2EnabledHandler<ReviewActionV2OperationId.ReviewInvocationLeaseAcquire>;
    readonly renewLease?: ReviewActionV2EnabledHandler<ReviewActionV2OperationId.ReviewInvocationLeaseRenew>;
    readonly releaseLease?: ReviewActionV2EnabledHandler<ReviewActionV2OperationId.ReviewInvocationLeaseRelease>;
  };

export async function registerReviewExecutionV2Routes(
  app: FastifyInstance,
  dependencies: RegisterReviewExecutionV2RoutesDependencies,
): Promise<void> {
  registerReviewActionV2Operation(
    app,
    ReviewActionV2OperationId.ReviewExecutionRestore,
    dependencies,
    dependencies.restore,
  );
  registerReviewActionV2Operation(
    app,
    ReviewActionV2OperationId.ReviewExecutionStart,
    dependencies,
    dependencies.start,
  );
  registerReviewActionV2Operation(
    app,
    ReviewActionV2OperationId.ReviewExecutionSupersede,
    dependencies,
    dependencies.supersede,
  );
  registerReviewActionV2Operation(
    app,
    ReviewActionV2OperationId.ReviewExecutionObservationAttach,
    dependencies,
    dependencies.attachObservation,
  );
  registerReviewActionV2Operation(
    app,
    ReviewActionV2OperationId.ReviewExecutionObservationAdopt,
    dependencies,
    dependencies.adoptObservation,
  );
  registerReviewActionV2Operation(
    app,
    ReviewActionV2OperationId.ReviewExecutionFinalize,
    dependencies,
    dependencies.finalize,
  );
  registerReviewActionV2Operation(
    app,
    ReviewActionV2OperationId.ReviewInvocationLeaseAcquire,
    dependencies,
    dependencies.acquireLease,
  );
  registerReviewActionV2Operation(
    app,
    ReviewActionV2OperationId.ReviewInvocationLeaseRenew,
    dependencies,
    dependencies.renewLease,
  );
  registerReviewActionV2Operation(
    app,
    ReviewActionV2OperationId.ReviewInvocationLeaseRelease,
    dependencies,
    dependencies.releaseLease,
  );
}
