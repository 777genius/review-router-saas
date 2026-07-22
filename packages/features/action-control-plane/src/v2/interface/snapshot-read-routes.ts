import type { FastifyInstance } from "fastify";
import { ReviewActionV2OperationId } from "@reviewrouter/protocol-review-action-v2";
import {
  registerReviewActionV2Operation,
  type ReviewActionV2EnabledHandler,
  type ReviewActionV2RouteRuntimeDependencies,
} from "./review-action-v2-route-support.js";

export type RegisterReviewSnapshotReadV2RoutesDependencies =
  ReviewActionV2RouteRuntimeDependencies & {
    readonly restore?: ReviewActionV2EnabledHandler<ReviewActionV2OperationId.ReviewSnapshotRestore>;
  };

export async function registerReviewSnapshotReadV2Routes(
  app: FastifyInstance,
  dependencies: RegisterReviewSnapshotReadV2RoutesDependencies,
): Promise<void> {
  registerReviewActionV2Operation(
    app,
    ReviewActionV2OperationId.ReviewSnapshotRestore,
    dependencies,
    dependencies.restore,
  );
}
