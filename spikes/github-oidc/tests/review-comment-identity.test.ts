import { describe, expect, it } from "vitest";
import {
  assertGitHubAppCommentAuthor,
  expectedGitHubAppBotLogin,
} from "../src/review-comment-identity";

describe("ReviewRouter GitHub App comment identity", () => {
  it("derives the exact App bot login from the configured slug", () => {
    expect(expectedGitHubAppBotLogin("review-router-ai")).toBe(
      "review-router-ai[bot]",
    );
  });

  it("fails closed when the App slug is missing", () => {
    expect(() => expectedGitHubAppBotLogin(undefined)).toThrow(
      "github_app_slug_required_for_comment_identity_e2e",
    );
  });

  it("rejects github-actions as a ReviewRouter publication identity", () => {
    expect(() =>
      assertGitHubAppCommentAuthor({
        actualLogin: "github-actions[bot]",
        expectedLogin: "review-router-ai[bot]",
        surface: "advisory",
      }),
    ).toThrow(
      "ReviewRouter advisory comment author mismatch: expected=review-router-ai[bot] actual=github-actions[bot]",
    );
  });
});
