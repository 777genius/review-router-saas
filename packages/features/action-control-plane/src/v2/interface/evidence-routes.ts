import type { FastifyInstance } from "fastify";
import { ReviewActionV2OperationId } from "@reviewrouter/protocol-review-action-v2";
import {
  registerReviewActionV2Operation,
  type ReviewActionV2EnabledHandler,
  type ReviewActionV2RouteRuntimeDependencies,
} from "./review-action-v2-route-support.js";

export type RegisterReviewEvidenceV2RoutesDependencies =
  ReviewActionV2RouteRuntimeDependencies & {
    readonly lookup?: ReviewActionV2EnabledHandler<ReviewActionV2OperationId.ReviewEvidenceLookup>;
    readonly commit?: ReviewActionV2EnabledHandler<ReviewActionV2OperationId.ReviewEvidenceCommit>;
  };

export async function registerReviewEvidenceV2Routes(
  app: FastifyInstance,
  dependencies: RegisterReviewEvidenceV2RoutesDependencies,
): Promise<void> {
  registerReviewActionV2Operation(
    app,
    ReviewActionV2OperationId.ReviewEvidenceLookup,
    dependencies,
    dependencies.lookup,
  );
  registerReviewActionV2Operation(
    app,
    ReviewActionV2OperationId.ReviewEvidenceCommit,
    dependencies,
    dependencies.commit,
  );
}
