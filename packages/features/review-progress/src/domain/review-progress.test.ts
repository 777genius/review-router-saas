import { describe, expect, it } from "vitest";
import {
  assertProgressTransition,
  computeProgressSnapshot,
  type ComputeProgressSnapshotInput,
  type ReviewSlotProgressInput,
} from "./review-progress";

const now = "2026-08-12T17:00:00.000Z";
const slot = (
  slotId: string,
  state: ReviewSlotProgressInput["state"],
  required = true,
  attemptOrdinal?: number,
): ReviewSlotProgressInput => ({
  slotId,
  state,
  required,
  ...(attemptOrdinal === undefined ? {} : { attemptOrdinal }),
});
const input = (
  slots: readonly ReviewSlotProgressInput[],
  overrides: Partial<ComputeProgressSnapshotInput> = {},
): ComputeProgressSnapshotInput => ({
  generation: 1,
  phase: "reviewing",
  terminal: "none",
  updatedAt: now,
  slots,
  ...overrides,
});

describe("computeProgressSnapshot", () => {
  it.each(["preparing", "reviewing", "assembling", "publishing"] as const)(
    "accepts execution lifecycle phase %s",
    (phase) => {
      expect(
        computeProgressSnapshot(input([slot("a", "running")], { phase })),
      ).toMatchObject({ phase, terminal: "none" });
    },
  );

  it.each(["complete", "failed", "cancelled", "superseded"] as const)(
    "accepts terminal execution outcome %s",
    (terminal) => {
      const slots =
        terminal === "complete"
          ? [slot("a", "accepted")]
          : [slot("a", "cancelled")];
      expect(
        computeProgressSnapshot(input(slots, { phase: "terminal", terminal })),
      ).toMatchObject({ phase: "terminal", terminal });
    },
  );

  it("counts retries as the same unit and exposes retrying and recovered units", () => {
    const result = computeProgressSnapshot(
      input([
        slot("retrying", "running", true, 2),
        slot("recovered", "accepted", true, 3),
        slot("exhausted", "exhausted"),
        slot("cancelled", "cancelled", false),
      ]),
    );
    expect(result.counts).toMatchObject({
      total: 4,
      completed: 1,
      retrying: 1,
      recovered: 1,
      exhausted: 1,
      cancelled: 1,
    });
  });

  it("maps exhausted required work to complete_with_gaps when partial terminal completion is allowed", () => {
    const result = computeProgressSnapshot(
      input([slot("accepted", "accepted"), slot("gap", "exhausted")], {
        phase: "terminal",
        terminal: "complete_with_gaps",
        allowPartial: true,
      }),
    );
    expect(result.terminal).toBe("complete_with_gaps");
    expect(result.counts.requiredExhausted).toBe(1);
    expect(() =>
      computeProgressSnapshot(
        input([slot("gap", "exhausted")], {
          phase: "terminal",
          terminal: "failed",
          allowPartial: true,
        }),
      ),
    ).toThrow("progress_partial_outcome_inconsistent");
  });

  it("rejects inconsistent phase and terminal pairs", () => {
    expect(() =>
      computeProgressSnapshot(
        input([], { phase: "terminal", terminal: "none" }),
      ),
    ).toThrow("progress_lifecycle_inconsistent");
    expect(() =>
      computeProgressSnapshot(
        input([], { phase: "reviewing", terminal: "failed" }),
      ),
    ).toThrow("progress_lifecycle_inconsistent");
  });

  it("requires every overlapping covering slot before a path is covered", () => {
    const manifest = {
      paths: [
        {
          pathId: "stable-a",
          disposition: "reviewable" as const,
          requiredCoveringSlotIds: ["a", "b"],
        },
        {
          pathId: "stable-b",
          disposition: "renamed" as const,
          requiredCoveringSlotIds: ["b"],
        },
        {
          pathId: "stable-c",
          disposition: "deleted" as const,
          requiredCoveringSlotIds: [],
        },
        {
          pathId: "excluded",
          disposition: "excluded" as const,
          requiredCoveringSlotIds: [],
        },
      ],
    };
    const partial = computeProgressSnapshot(
      input([slot("a", "running"), slot("b", "accepted")], {
        assignmentManifest: manifest,
      }),
    );
    expect(partial.fileCoverage).toEqual({
      valid: true,
      total: 3,
      covered: 1,
      uncovered: 0,
      excluded: 0,
    });
    const complete = computeProgressSnapshot(
      input([slot("a", "accepted"), slot("b", "accepted")], {
        assignmentManifest: manifest,
      }),
    );
    expect(complete.fileCoverage).toEqual({
      valid: true,
      total: 3,
      covered: 2,
      uncovered: 0,
      excluded: 0,
    });
  });

  it.each([
    {
      name: "duplicate paths",
      paths: [
        {
          pathId: "same",
          disposition: "reviewable" as const,
          requiredCoveringSlotIds: ["a"],
        },
        {
          pathId: "same",
          disposition: "deleted" as const,
          requiredCoveringSlotIds: ["a"],
        },
      ],
    },
    {
      name: "duplicate assignments",
      paths: [
        {
          pathId: "path",
          disposition: "reviewable" as const,
          requiredCoveringSlotIds: ["a", "a"],
        },
      ],
    },
    {
      name: "unknown assignment",
      paths: [
        {
          pathId: "path",
          disposition: "reviewable" as const,
          requiredCoveringSlotIds: ["missing"],
        },
      ],
    },
    {
      name: "optional assignment",
      paths: [
        {
          pathId: "path",
          disposition: "reviewable" as const,
          requiredCoveringSlotIds: ["optional"],
        },
      ],
    },
  ])("hides file coverage for $name", ({ paths }) => {
    const result = computeProgressSnapshot(
      input([slot("a", "accepted"), slot("optional", "accepted", false)], {
        assignmentManifest: { paths },
      }),
    );
    expect(result.fileCoverage).toEqual({ valid: false });
  });
});

describe("assertProgressTransition", () => {
  it("accepts forward lifecycle and count movement within a generation", () => {
    const previous = computeProgressSnapshot(
      input([slot("a", "running")], { phase: "reviewing" }),
    );
    const next = computeProgressSnapshot(
      input([slot("a", "accepted")], {
        phase: "assembling",
        updatedAt: "2026-08-12T17:01:00Z",
      }),
    );
    expect(() => assertProgressTransition(previous, next)).not.toThrow();
  });

  it("rejects generation, lifecycle, count and timestamp regressions", () => {
    const completed = computeProgressSnapshot(
      input([slot("a", "accepted")], {
        phase: "assembling",
        updatedAt: "2026-08-12T17:02:00Z",
      }),
    );
    const pending = computeProgressSnapshot(
      input([slot("a", "pending")], { phase: "reviewing" }),
    );
    expect(() => assertProgressTransition(completed, pending)).toThrow();
    expect(() =>
      assertProgressTransition(completed, { ...completed, generation: 0 }),
    ).toThrow("progress_generation_regressed");
  });

  it("allows a new generation to restart progress", () => {
    const terminal = computeProgressSnapshot(
      input([slot("a", "accepted")], {
        phase: "terminal",
        terminal: "complete",
      }),
    );
    const restarted = computeProgressSnapshot(
      input([slot("a", "pending")], { generation: 2, phase: "preparing" }),
    );
    expect(() => assertProgressTransition(terminal, restarted)).not.toThrow();
  });
});
