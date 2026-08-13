import { describe, expect, it } from "vitest";
import {
  computeProgressSnapshot,
  type ReviewSlotProgressInput,
} from "../domain/review-progress";
import {
  formatGithubProgressComment,
  githubProgressCommentMarker,
  parseGithubProgressSourceIdentity,
} from "./github-progress-comment";

describe("formatGithubProgressComment", () => {
  it("renders the accepted ReviewRouter progress UX", () => {
    const slots: ReviewSlotProgressInput[] = Array.from(
      { length: 72 },
      (_, index) => ({
        slotId: `unit-${index}`,
        required: true,
        state:
          index < 42
            ? "accepted"
            : index === 42
              ? "running"
              : index === 43
                ? "exhausted"
                : "pending",
        ...(index === 0 || index === 42 ? { attemptOrdinal: 2 } : {}),
      }),
    );
    const snapshot = computeProgressSnapshot({
      generation: 1,
      sourceIdentity: { sourceRunId: "700001", sourceRunAttempt: "2" },
      phase: "reviewing",
      terminal: "none",
      updatedAt: "2026-08-12T17:04:05.000Z",
      slots,
      assignmentManifest: {
        paths: [
          {
            pathId: "opaque",
            disposition: "renamed",
            requiredCoveringSlotIds: ["unit-0"],
          },
        ],
      },
    });
    const comment = formatGithubProgressComment(snapshot);
    expect(comment.split(githubProgressCommentMarker)).toHaveLength(2);
    expect(comment).toContain(
      "<!-- review-router-live-progress-source run-id=700001 run-attempt=2 -->",
    );
    expect(comment).toContain("## ReviewRouter");
    expect(comment).toContain("**Phase:** Reviewing");
    expect(comment).toContain("Review units: 42 of 72 complete (58%)");
    expect(comment).toContain("[■■■■■□□□□□] 58%");
    expect(comment).toContain("Files in completed units: 1 of 1");
    expect(comment).toContain("Units currently retrying: 1");
    expect(comment).toContain("Units recovered by retry: 1");
    expect(comment).toContain("Units not completed after retries: 1");
    expect(comment).toContain("Last update: 2026-08-12 17:04:05 UTC");
    expect(comment).toContain(
      "A review unit is one planned piece of review work.",
    );
  });

  it("keeps legacy snapshots identity-less and rejects marker injection", () => {
    const legacy = computeProgressSnapshot({
      generation: 1,
      phase: "reviewing",
      terminal: "none",
      updatedAt: "2026-08-12T17:00:00Z",
      slots: [],
    });
    expect(formatGithubProgressComment(legacy)).not.toContain(
      "review-router-live-progress-source",
    );
    expect(() =>
      computeProgressSnapshot({
        generation: 1,
        phase: "reviewing",
        terminal: "none",
        updatedAt: "2026-08-12T17:00:00Z",
        slots: [],
        sourceIdentity: {
          sourceRunId: "7 --> hostile",
          sourceRunAttempt: "1",
        },
      }),
    ).toThrow("progress_source_run_id_invalid");
  });

  it("parses only one exact canonical source marker", () => {
    expect(
      parseGithubProgressSourceIdentity(
        `${githubProgressCommentMarker}\n<!-- review-router-live-progress-source run-id=700001 run-attempt=2 -->`,
      ),
    ).toEqual({ sourceRunId: "700001", sourceRunAttempt: "2" });
    expect(parseGithubProgressSourceIdentity(githubProgressCommentMarker)).toBe(
      null,
    );
    expect(() =>
      parseGithubProgressSourceIdentity(
        "<!-- review-router-live-progress-source run-id=0700001 run-attempt=2 -->",
      ),
    ).toThrow("progress_source_identity_marker_invalid");
    expect(() =>
      parseGithubProgressSourceIdentity(
        "<!-- review-router-live-progress-source run-id=700001 run-attempt=2 -->\n<!-- review-router-live-progress-source run-id=700001 run-attempt=3 -->",
      ),
    ).toThrow("progress_source_identity_marker_invalid");
  });

  it("labels complete-with-gaps honestly and leaks no identities", () => {
    const comment = formatGithubProgressComment(
      computeProgressSnapshot({
        generation: 1,
        phase: "terminal",
        terminal: "complete_with_gaps",
        allowPartial: true,
        updatedAt: "2026-08-12T17:00:00Z",
        slots: [
          {
            slotId: "provider-model-agent",
            required: true,
            state: "exhausted",
          },
        ],
        assignmentManifest: {
          paths: [
            {
              pathId: "private/path.ts",
              disposition: "reviewable",
              requiredCoveringSlotIds: ["unknown"],
            },
          ],
        },
      }),
    );
    expect(comment).toContain("**Phase:** Complete with gaps");
    expect(comment).not.toContain("Files in completed units");
    expect(comment).not.toContain("provider-model-agent");
    expect(comment).not.toContain("private/path.ts");
    expect(comment).not.toMatch(/\bETA\b|raw error/i);
  });

  it("uses required units as the primary numerator and denominator", () => {
    const comment = formatGithubProgressComment(
      computeProgressSnapshot({
        generation: 1,
        phase: "reviewing",
        terminal: "none",
        updatedAt: "2026-08-12T17:00:00Z",
        slots: [
          { slotId: "required", required: true, state: "pending" },
          { slotId: "optional", required: false, state: "accepted" },
        ],
      }),
    );
    expect(comment).toContain("Review units: 0 of 1 complete (0%)");
  });

  it("renders zero progress for an empty required-unit denominator", () => {
    const comment = formatGithubProgressComment(
      computeProgressSnapshot({
        generation: 1,
        phase: "reviewing",
        terminal: "none",
        updatedAt: "2026-08-12T17:00:00Z",
        slots: [{ slotId: "optional", required: false, state: "running" }],
      }),
    );
    expect(comment).toContain("Review units: 0 of 0 complete (0%)");
    expect(comment).toContain("[□□□□□□□□□□] 0%");
  });
});
