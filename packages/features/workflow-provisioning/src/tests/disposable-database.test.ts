import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assertDisposableWorkflowDatabase } from "./disposable-database";

describe("workflow fixture database boundary", () => {
  it("accepts the actual checked-in CI database and named local fixtures", () => {
    const ci = readFileSync(
      new URL("../../../../../.github/workflows/ci.yml", import.meta.url),
      "utf8",
    );
    const url = /REVIEW_ROUTER_TEST_DATABASE_URL: (\S+)/.exec(ci)![1]!;
    expect(() => assertDisposableWorkflowDatabase(url)).not.toThrow();
    expect(() =>
      assertDisposableWorkflowDatabase(
        "postgresql://test@127.0.0.1:55432/reviewrouter_pr244_disposable_r5",
      ),
    ).not.toThrow();
  });
  it.each([
    "postgresql://test@production.example/review_router_ci_test",
    "postgresql://test@127.0.0.1/production",
    "postgresql://test@127.0.0.1/review_router_ci_test_backup",
    "postgresql://test@127.0.0.1/reviewrouter_pr244_disposableprod",
    "https://127.0.0.1/review_router_ci_test",
    "postgresql://test@127.0.0.1/review_router_ci_test?host=production.example",
    "postgresql://test@127.0.0.1/review_router_ci_test?schema=production",
  ])("rejects a non-disposable or redirected database: %s", (url) => {
    expect(() => assertDisposableWorkflowDatabase(url)).toThrow(
      "disposable_loopback_database_required",
    );
  });
});
