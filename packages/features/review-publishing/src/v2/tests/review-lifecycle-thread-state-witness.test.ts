import { describe, expect, it } from "vitest";
import { reviewLifecycleThreadStateHash } from "../infrastructure/review-lifecycle-thread-state-witness";

describe("review lifecycle thread-state witness", () => {
  it("matches the cross-repository golden vector", () => {
    const threadStateHash = reviewLifecycleThreadStateHash({
      threadId: "PRRT_reviewrouter_golden_1",
      comments: [
        {
          id: "PRRC_2",
          authorLogin: "Human.User",
          body: "Looks fixed.\n",
          createdAt: "2026-08-05T10:00:00.000Z",
          updatedAt: "2026-08-05T10:00:00.000Z",
        },
        {
          id: "PRRC_1",
          authorLogin: "Review-Router-AI[bot]",
          body: "<!-- review-router-finding:aaaaaaaaaaaaaaaaaaaaaaaa -->\nFinding",
          createdAt: "2026-08-05T09:00:00.000Z",
          updatedAt: "2026-08-05T09:05:00.000Z",
        },
      ],
    });

    expect(threadStateHash).toBe(
      "9bab955ad13af6be85a71a3ad9e3d43db8e485f6dcab798ce91e8111a0495245",
    );
  });

  it("rejects an empty comment inventory", () => {
    expect(() =>
      reviewLifecycleThreadStateHash({
        threadId: "PRRT_empty",
        comments: [],
      }),
    ).toThrow("thread_comments_empty");
  });
});
