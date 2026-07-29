import { afterEach, describe, expect, it } from "vitest";
import { assertDisposableDatabaseUrl } from "./review-action-v2-e2e-harness";

const optInName = "REVIEW_ROUTER_REVIEW_V2_E2E_ALLOW_DOCKER_DATABASE";
const originalOptIn = process.env[optInName];

afterEach(() => {
  if (originalOptIn === undefined) delete process.env[optInName];
  else process.env[optInName] = originalOptIn;
});

describe("Review v2 disposable database guard", () => {
  it("allows an explicitly opted-in Compose test database", () => {
    process.env[optInName] = "1";

    expect(() =>
      assertDisposableDatabaseUrl(
        "postgresql://reviewrouter:secret@postgres:5432/review_router_test_run",
      ),
    ).not.toThrow();
  });

  it("rejects the Compose hostname without the explicit opt-in", () => {
    delete process.env[optInName];

    expect(() =>
      assertDisposableDatabaseUrl(
        "postgresql://reviewrouter:secret@postgres:5432/review_router_test_run",
      ),
    ).toThrow("review_v2_e2e_requires_disposable_database");
  });

  it("rejects a non-test database even with the Docker opt-in", () => {
    process.env[optInName] = "1";

    expect(() =>
      assertDisposableDatabaseUrl(
        "postgresql://reviewrouter:secret@postgres:5432/review_router",
      ),
    ).toThrow("review_v2_e2e_requires_disposable_database");
  });
});
