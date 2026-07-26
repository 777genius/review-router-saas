import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import {
  reviewActionV2GoldenFixtures,
  reviewActionV2Operations,
  reviewRunAuthorizeNegotiationGoldenFixture,
  ReviewActionV2OperationId,
  ReviewActionV2ProtocolErrorCode,
  ReviewExecutionRestoreResultStatus,
} from "@reviewrouter/protocol-review-action-v2";
import {
  registerReviewContextAttestationV2Routes,
  registerReviewEvidenceV2Routes,
  registerReviewExecutionV2Routes,
  registerReviewPublicationRequestV2Routes,
  registerReviewRunControlV2Routes,
  registerReviewSnapshotReadV2Routes,
  ReviewActionV2RouteFailure,
} from "../../v2/interface/index.js";

const serverTime = new Date("2026-01-01T00:00:00.000Z");
const runtime = {
  readServerTime: async () => serverTime,
  createRequestId: () => "generated_request_id",
};

describe("Review Action v2 route registrars", () => {
  it("registers every published route while all v2 capabilities stay disabled", async () => {
    const app = Fastify();
    await registerReviewRunControlV2Routes(app, runtime);
    await registerReviewExecutionV2Routes(app, runtime);
    await registerReviewContextAttestationV2Routes(app, runtime);
    await registerReviewEvidenceV2Routes(app, runtime);
    await registerReviewSnapshotReadV2Routes(app, runtime);
    await registerReviewPublicationRequestV2Routes(app, runtime);

    for (const operation of reviewActionV2Operations) {
      const response = await app.inject({
        method: operation.method,
        url: operation.path,
        payload:
          operation.operationId === ReviewActionV2OperationId.ReviewRunAuthorize
            ? reviewRunAuthorizeNegotiationGoldenFixture.request
            : reviewActionV2GoldenFixtures[operation.operationId].request,
      });
      if (
        operation.operationId === ReviewActionV2OperationId.ReviewRunAuthorize
      ) {
        expect(response.statusCode).toBe(426);
        expect(response.json()).toEqual(
          reviewRunAuthorizeNegotiationGoldenFixture.response,
        );
      } else {
        expect(response.statusCode).toBe(403);
        expect(response.json()).toMatchObject({
          requestId:
            reviewActionV2GoldenFixtures[operation.operationId].request
              .requestId,
          error: {
            errorCode: "capability_disabled",
            retryClass: "never",
            details: { issues: ["capability_disabled"] },
          },
        });
      }
    }
  });

  it("strictly rejects unknown fields before invoking a context handler", async () => {
    const app = Fastify();
    let calls = 0;
    await registerReviewExecutionV2Routes(app, {
      ...runtime,
      restore: {
        capabilityEnabled: true,
        execute: async () => {
          calls += 1;
          return {
            statusCode: 200,
            result: { status: ReviewExecutionRestoreResultStatus.Found },
          };
        },
      },
    });
    const operation = reviewActionV2Operations.find(
      (candidate) =>
        candidate.operationId ===
        ReviewActionV2OperationId.ReviewExecutionRestore,
    );
    if (!operation) throw new Error("fixture_operation_missing");

    const response = await app.inject({
      method: "POST",
      url: operation.path,
      payload: {
        ...reviewActionV2GoldenFixtures.review_execution_restore.request,
        unexpected: true,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        errorCode: "invalid_request",
        details: { issues: ["unknown_field:unexpected"] },
      },
    });
    expect(calls).toBe(0);
  });

  it("wraps one explicitly enabled narrow handler in the generated envelope", async () => {
    const app = Fastify();
    await registerReviewExecutionV2Routes(app, {
      ...runtime,
      restore: {
        capabilityEnabled: true,
        execute: async () => ({
          statusCode: 200,
          result: {
            status: ReviewExecutionRestoreResultStatus.Found,
            executionId: "execution_fixture",
          },
        }),
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/action/v2/review-executions/restore",
      payload: reviewActionV2GoldenFixtures.review_execution_restore.request,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      protocolVersion: "2",
      requestId:
        reviewActionV2GoldenFixtures.review_execution_restore.request.requestId,
      serverTime: serverTime.toISOString(),
      result: {
        status: "found",
        executionId: "execution_fixture",
      },
    });
    await app.close();
  });

  it("maps an expected context rejection into its typed protocol error", async () => {
    const app = Fastify();
    await registerReviewEvidenceV2Routes(app, {
      ...runtime,
      commit: {
        capabilityEnabled: true,
        execute: async () => {
          throw new ReviewActionV2RouteFailure(
            409,
            ReviewActionV2ProtocolErrorCode.IdempotencyConflict,
            ["evidence_payload_conflict"],
          );
        },
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/action/v2/review-evidence/commit",
      payload: reviewActionV2GoldenFixtures.review_evidence_commit.request,
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      protocolVersion: "2",
      requestId:
        reviewActionV2GoldenFixtures.review_evidence_commit.request.requestId,
      error: {
        errorCode: ReviewActionV2ProtocolErrorCode.IdempotencyConflict,
        retryClass: "never",
        details: { issues: ["evidence_payload_conflict"] },
      },
    });
    await app.close();
  });

  it("logs only safe protocol diagnostics for rejected v2 requests", async () => {
    const diagnostics: unknown[] = [];
    const app = Fastify({ logger: false });
    await registerReviewContextAttestationV2Routes(app, {
      ...runtime,
      recordProtocolRejection: (diagnostic) => diagnostics.push(diagnostic),
      openGateway: {
        capabilityEnabled: true,
        execute: async () => {
          throw new ReviewActionV2RouteFailure(
            412,
            ReviewActionV2ProtocolErrorCode.StalePrecondition,
            ["context_checkout_tree_mismatch"],
          );
        },
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/action/v2/review-context/gateway/open",
      payload: reviewActionV2GoldenFixtures.review_context_gateway_open.request,
    });

    expect(response.statusCode).toBe(412);
    expect(diagnostics).toEqual([
      {
        operationId: ReviewActionV2OperationId.ReviewContextGatewayOpen,
        protocolErrorCode: ReviewActionV2ProtocolErrorCode.StalePrecondition,
        protocolIssues: ["context_checkout_tree_mismatch"],
        requestId:
          reviewActionV2GoldenFixtures.review_context_gateway_open.request
            .requestId,
        statusCode: 412,
      },
    ]);
    expect(JSON.stringify(diagnostics)).not.toContain("leaseCapability");
    expect(JSON.stringify(diagnostics)).not.toContain("authorizationToken");
    await app.close();
  });

  it("preserves the protocol response when the diagnostic sink fails", async () => {
    const app = Fastify({ logger: false });
    await registerReviewContextAttestationV2Routes(app, {
      ...runtime,
      recordProtocolRejection: () => {
        throw new Error("diagnostic sink unavailable");
      },
      openGateway: {
        capabilityEnabled: true,
        execute: async () => {
          throw new ReviewActionV2RouteFailure(
            412,
            ReviewActionV2ProtocolErrorCode.StalePrecondition,
            ["context_checkout_tree_mismatch"],
          );
        },
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/action/v2/review-context/gateway/open",
      payload: reviewActionV2GoldenFixtures.review_context_gateway_open.request,
    });

    expect(response.statusCode).toBe(412);
    expect(response.json()).toMatchObject({
      error: {
        errorCode: ReviewActionV2ProtocolErrorCode.StalePrecondition,
        details: { issues: ["context_checkout_tree_mismatch"] },
      },
    });
    await app.close();
  });

  it("maps stale adoption and publication preconditions to HTTP 412", async () => {
    const app = Fastify();
    const stale = (issue: string) => ({
      capabilityEnabled: true as const,
      execute: async () => {
        throw new ReviewActionV2RouteFailure(
          412,
          ReviewActionV2ProtocolErrorCode.StalePrecondition,
          [issue],
        );
      },
    });
    await registerReviewExecutionV2Routes(app, {
      ...runtime,
      adoptObservation: stale("adoption_execution_version_mismatch"),
    });
    await registerReviewPublicationRequestV2Routes(app, {
      ...runtime,
      request: stale("publication_projection_mismatch"),
    });

    const [adoption, publication] = await Promise.all([
      app.inject({
        method: "POST",
        url: "/api/action/v2/review-executions/observations/adopt",
        payload:
          reviewActionV2GoldenFixtures.review_execution_observation_adopt
            .request,
      }),
      app.inject({
        method: "POST",
        url: "/api/action/v2/review-publication/request",
        payload:
          reviewActionV2GoldenFixtures.review_publication_request.request,
      }),
    ]);

    expect(adoption.statusCode).toBe(412);
    expect(adoption.json()).toMatchObject({
      error: {
        errorCode: ReviewActionV2ProtocolErrorCode.StalePrecondition,
        details: { issues: ["adoption_execution_version_mismatch"] },
      },
    });
    expect(publication.statusCode).toBe(412);
    expect(publication.json()).toMatchObject({
      error: {
        errorCode: ReviewActionV2ProtocolErrorCode.StalePrecondition,
        details: { issues: ["publication_projection_mismatch"] },
      },
    });
    await app.close();
  });

  it("returns operation-safe typed fallbacks for unexpected handler failures", async () => {
    const app = Fastify();
    await registerReviewExecutionV2Routes(app, {
      ...runtime,
      restore: {
        capabilityEnabled: true,
        execute: async () => {
          throw new Error("read-handler-secret");
        },
      },
      start: {
        capabilityEnabled: true,
        execute: async () => {
          throw new Error("command-handler-secret");
        },
      },
    });

    const readResponse = await app.inject({
      method: "POST",
      url: "/api/action/v2/review-executions/restore",
      payload: reviewActionV2GoldenFixtures.review_execution_restore.request,
    });
    const commandResponse = await app.inject({
      method: "POST",
      url: "/api/action/v2/review-executions/start",
      payload: reviewActionV2GoldenFixtures.review_execution_start.request,
    });

    expect(readResponse.statusCode).toBe(503);
    expect(readResponse.json()).toMatchObject({
      error: {
        errorCode: ReviewActionV2ProtocolErrorCode.ServiceUnavailable,
        retryClass: "read_only",
        details: { issues: ["handler_failed"] },
      },
    });
    expect(commandResponse.statusCode).toBe(500);
    expect(commandResponse.json()).toMatchObject({
      error: {
        errorCode: ReviewActionV2ProtocolErrorCode.AmbiguousOutcome,
        retryClass: "same_request",
        details: { issues: ["handler_failed"] },
      },
    });
    expect(readResponse.body).not.toContain("read-handler-secret");
    expect(commandResponse.body).not.toContain("command-handler-secret");
    await app.close();
  });

  it("fails closed when a typed failure is incompatible with the operation contract", async () => {
    const app = Fastify();
    await registerReviewExecutionV2Routes(app, {
      ...runtime,
      restore: {
        capabilityEnabled: true,
        execute: async () => {
          throw new ReviewActionV2RouteFailure(
            422,
            ReviewActionV2ProtocolErrorCode.InvariantViolation,
            ["must_not_escape"],
          );
        },
      },
      start: {
        capabilityEnabled: true,
        execute: async () => {
          throw new ReviewActionV2RouteFailure(
            409,
            ReviewActionV2ProtocolErrorCode.ResourceGone,
            ["wrong_status_must_not_escape"],
          );
        },
      },
    });

    const disallowedCode = await app.inject({
      method: "POST",
      url: "/api/action/v2/review-executions/restore",
      payload: reviewActionV2GoldenFixtures.review_execution_restore.request,
    });
    const mismatchedStatus = await app.inject({
      method: "POST",
      url: "/api/action/v2/review-executions/start",
      payload: reviewActionV2GoldenFixtures.review_execution_start.request,
    });

    expect(disallowedCode.statusCode).toBe(503);
    expect(disallowedCode.json()).toMatchObject({
      error: {
        errorCode: ReviewActionV2ProtocolErrorCode.ServiceUnavailable,
        retryClass: "read_only",
        details: { issues: ["handler_failed"] },
      },
    });
    expect(mismatchedStatus.statusCode).toBe(500);
    expect(mismatchedStatus.json()).toMatchObject({
      error: {
        errorCode: ReviewActionV2ProtocolErrorCode.AmbiguousOutcome,
        retryClass: "same_request",
        details: { issues: ["handler_failed"] },
      },
    });
    expect(disallowedCode.body).not.toContain("must_not_escape");
    expect(mismatchedStatus.body).not.toContain("wrong_status_must_not_escape");
    await app.close();
  });
});
