import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import {
  reviewActionV2GoldenFixtures,
  reviewRunAuthorizeNegotiationGoldenFixture,
  ReviewActionV2ProtocolErrorCode,
  ReviewRunAuthorizationResultStatus,
} from "@reviewrouter/protocol-review-action-v2";
import {
  registerReviewRunControlV2Routes,
  ReviewActionV2RouteFailure,
} from "../../v2/interface/index.js";

const serverTime = new Date("2026-07-22T12:00:00.000Z");
const runtime = {
  readServerTime: async () => serverTime,
  createRequestId: () => "generated_request_id",
};

describe("Review Action v2 run-control routes", () => {
  it("preserves the disabled authorize negotiation bridge", async () => {
    const app = Fastify();
    await registerReviewRunControlV2Routes(app, runtime);

    const response = await app.inject({
      method: "POST",
      url: "/api/action/v2/review-runs/authorize",
      payload: reviewRunAuthorizeNegotiationGoldenFixture.request,
    });

    expect(response.statusCode).toBe(426);
    expect(response.json()).toEqual({
      ...reviewRunAuthorizeNegotiationGoldenFixture.response,
      serverTime: serverTime.toISOString(),
    });
    await app.close();
  });

  it("rejects invalid authorize input before invoking the enabled handler", async () => {
    const execute = vi.fn();
    const app = Fastify();
    await registerReviewRunControlV2Routes(app, {
      ...runtime,
      authorize: { capabilityEnabled: true, execute },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/action/v2/review-runs/authorize",
      payload: {
        ...reviewActionV2GoldenFixtures.review_run_authorize.request,
        unexpected: "never_forwarded",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        errorCode: ReviewActionV2ProtocolErrorCode.InvalidRequest,
        details: { issues: ["unknown_field:unexpected"] },
      },
    });
    expect(execute).not.toHaveBeenCalled();
    await app.close();
  });

  it.each([
    [ReviewRunAuthorizationResultStatus.Authorized, 201],
    [ReviewRunAuthorizationResultStatus.Restored, 200],
  ] as const)("returns %s authorize outcomes", async (status, statusCode) => {
    const app = Fastify();
    await registerReviewRunControlV2Routes(app, {
      ...runtime,
      authorize: {
        capabilityEnabled: true,
        execute: async () => ({ statusCode, result: { status } }),
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/action/v2/review-runs/authorize",
      payload: reviewActionV2GoldenFixtures.review_run_authorize.request,
    });

    expect(response.statusCode).toBe(statusCode);
    expect(response.json()).toMatchObject({ result: { status } });
    await app.close();
  });

  it("returns a renewed result from the enabled renewal handler", async () => {
    const app = Fastify();
    await registerReviewRunControlV2Routes(app, {
      ...runtime,
      renew: {
        capabilityEnabled: true,
        execute: async () => ({
          statusCode: 200,
          result: { status: ReviewRunAuthorizationResultStatus.Renewed },
        }),
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/action/v2/review-runs/renew",
      payload: reviewActionV2GoldenFixtures.review_run_renew.request,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      result: { status: ReviewRunAuthorizationResultStatus.Renewed },
    });
    await app.close();
  });

  it("maps typed and unknown handler failures without leaking exception text", async () => {
    const app = Fastify();
    const typedRequest = {
      ...reviewActionV2GoldenFixtures.review_run_renew.request,
      requestId: "typed_failure",
    };
    const unknownRequest = {
      ...reviewActionV2GoldenFixtures.review_run_renew.request,
      requestId: "unknown_failure",
    };
    await registerReviewRunControlV2Routes(app, {
      ...runtime,
      renew: {
        capabilityEnabled: true,
        execute: async (request) => {
          if (request.requestId === typedRequest.requestId) {
            throw new ReviewActionV2RouteFailure(
              410,
              ReviewActionV2ProtocolErrorCode.ResourceGone,
              ["authorization_expired"],
            );
          }
          throw new Error("raw-secret-bearing-handler-error");
        },
      },
    });

    const typed = await app.inject({
      method: "POST",
      url: "/api/action/v2/review-runs/renew",
      payload: typedRequest,
    });
    const unknown = await app.inject({
      method: "POST",
      url: "/api/action/v2/review-runs/renew",
      payload: unknownRequest,
    });

    expect(typed.statusCode).toBe(410);
    expect(typed.json()).toMatchObject({
      error: {
        errorCode: ReviewActionV2ProtocolErrorCode.ResourceGone,
        details: { issues: ["authorization_expired"] },
      },
    });
    expect(unknown.statusCode).toBe(500);
    expect(unknown.json()).toMatchObject({
      error: {
        errorCode: ReviewActionV2ProtocolErrorCode.AmbiguousOutcome,
        details: { issues: ["handler_failed"] },
      },
    });
    expect(unknown.body).not.toContain("raw-secret-bearing-handler-error");
    await app.close();
  });
});
