import type { FastifyInstance } from "fastify";
import {
  createReviewActionV2ErrorResponse,
  createReviewActionV2ResultResponse,
  parseReviewActionV2Request,
  reviewActionV2Operations,
  ReviewActionV2OperationId,
  ReviewActionV2ProtocolErrorCode,
  type ReviewActionV2RequestMap,
  type ReviewActionV2ResultMap,
} from "@reviewrouter/protocol-review-action-v2";
import { toSafeReviewActionV2RouteFailure } from "./review-action-v2-route-failure.js";

export type ReviewActionV2RouteRuntimeDependencies = {
  readonly readServerTime: () => Promise<Date>;
  readonly createRequestId: () => string;
};

export type ReviewActionV2EnabledHandler<
  Operation extends ReviewActionV2OperationId,
> = {
  readonly capabilityEnabled: true;
  readonly execute: (request: ReviewActionV2RequestMap[Operation]) => Promise<{
    readonly statusCode: number;
    readonly result: ReviewActionV2ResultMap[Operation];
  }>;
};

export function registerReviewActionV2Operation<
  Operation extends ReviewActionV2OperationId,
>(
  app: FastifyInstance,
  operationId: Operation,
  dependencies: ReviewActionV2RouteRuntimeDependencies,
  handler?: ReviewActionV2EnabledHandler<Operation>,
): void {
  const descriptor = reviewActionV2Operations.find(
    (candidate) => candidate.operationId === operationId,
  );
  if (!descriptor) {
    throw new Error(`review_action_v2_route_descriptor_missing:${operationId}`);
  }

  app.post(
    descriptor.path,
    { bodyLimit: descriptor.bodyLimitBytes },
    async (request, reply) => {
      const parsed = parseReviewActionV2Request(operationId, request.body);
      const serverTime = (await dependencies.readServerTime()).toISOString();
      const requestId = parsed.ok
        ? parsed.value.requestId
        : (parsed.requestId ?? dependencies.createRequestId());

      if (!parsed.ok) {
        return reply.code(400).send(
          createReviewActionV2ErrorResponse({
            operationId,
            requestId,
            serverTime,
            errorCode: ReviewActionV2ProtocolErrorCode.InvalidRequest,
            issues: parsed.issues,
          }),
        );
      }

      if (!handler || handler.capabilityEnabled !== true) {
        return reply.code(403).send(
          createReviewActionV2ErrorResponse({
            operationId,
            requestId,
            serverTime,
            errorCode: ReviewActionV2ProtocolErrorCode.CapabilityDisabled,
            issues: ["capability_disabled"],
          }),
        );
      }

      try {
        const outcome = await handler.execute(parsed.value);
        if (!descriptor.successStatuses.includes(outcome.statusCode as never)) {
          throw new Error(
            `review_action_v2_success_status_invalid:${operationId}:${outcome.statusCode}`,
          );
        }
        return reply.code(outcome.statusCode).send(
          createReviewActionV2ResultResponse({
            operationId,
            requestId,
            serverTime,
            result: outcome.result,
          }),
        );
      } catch (error) {
        const failure = toSafeReviewActionV2RouteFailure(error, operationId);
        return reply.code(failure.statusCode).send(
          createReviewActionV2ErrorResponse({
            operationId,
            requestId,
            serverTime,
            errorCode: failure.errorCode,
            issues: failure.issues,
          }),
        );
      }
    },
  );
}
