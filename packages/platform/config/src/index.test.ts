import { describe, expect, it } from "vitest";
import { loadRuntimeEnv, resolveReviewRouterActionRef } from "./index";

describe("platform config", () => {
  it("defaults beta workflow provisioning to live ReviewRouter main", () => {
    expect(resolveReviewRouterActionRef({})).toBe(
      "777genius/review-router@main",
    );
  });

  it("allows pinning a release version without changing callers", () => {
    expect(
      resolveReviewRouterActionRef({
        REVIEW_ROUTER_ACTION_VERSION: "v1.0.4",
      }),
    ).toBe("777genius/review-router@v1.0.4");
  });

  it("allows overriding the full action ref for smoke tests", () => {
    expect(
      resolveReviewRouterActionRef({
        REVIEW_ROUTER_ACTION_REF: "777genius/review-router@feature/test",
        REVIEW_ROUTER_ACTION_VERSION: "v1.0.4",
      }),
    ).toBe("777genius/review-router@feature/test");
  });

  it("keeps runtime env default aligned with the resolver", () => {
    const env = loadRuntimeEnv({
      DATABASE_URL: "postgres://user:pass@localhost:5432/reviewrouter",
      AUTH_SECRET: "0123456789abcdef",
    } as NodeJS.ProcessEnv);

    expect(env.REVIEW_ROUTER_ACTION_VERSION).toBe("main");
    expect(resolveReviewRouterActionRef(env)).toBe(
      "777genius/review-router@main",
    );
  });
});
