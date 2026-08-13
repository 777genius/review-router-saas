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
  it("binds source identity within a generation but permits legacy enrichment", () => {
    const legacy = computeProgressSnapshot(input([], { generation: 1 }));
    const bound = computeProgressSnapshot(
      input([], {
        generation: 1,
        sourceIdentity: { sourceRunId: "700001", sourceRunAttempt: "2" },
      }),
    );
    expect(() => assertProgressTransition(legacy, bound)).not.toThrow();
    expect(() => assertProgressTransition(bound, legacy)).toThrow(
      "progress_source_identity_changed",
    );
    expect(() =>
      assertProgressTransition(
        bound,
        computeProgressSnapshot(
          input([], {
            generation: 1,
            sourceIdentity: { sourceRunId: "700001", sourceRunAttempt: "3" },
          }),
        ),
      ),
    ).toThrow("progress_source_identity_changed");
  });
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

  it("tracks a 108-file, 72-unit review without counting six incomplete first attempts", () => {
    const slots = Array.from({ length: 72 }, (_, index) =>
      slot(
        `unit-${index}`,
        index < 6 ? "running" : "accepted",
        true,
        index < 6 ? 2 : 1,
      ),
    );
    const paths = Array.from({ length: 108 }, (_, index) => ({
      pathId: `path-${index}`,
      disposition: "reviewable" as const,
      requiredCoveringSlotIds: [`unit-${index % 72}`],
    }));
    const retrying = computeProgressSnapshot(
      input(slots, { assignmentManifest: { paths } }),
    );

    expect(retrying.counts).toMatchObject({
      requiredTotal: 72,
      requiredCompleted: 66,
      retrying: 6,
      recovered: 0,
    });
    expect(retrying.fileCoverage).toEqual({
      valid: true,
      total: 108,
      covered: 96,
      uncovered: 0,
      excluded: 0,
    });

    const completed = computeProgressSnapshot(
      input(
        slots.map((entry, index) =>
          index < 6 ? { ...entry, state: "accepted" as const } : entry,
        ),
        { assignmentManifest: { paths } },
      ),
    );
    expect(completed.counts).toMatchObject({
      requiredTotal: 72,
      requiredCompleted: 72,
      retrying: 0,
      recovered: 6,
    });
    expect(completed.fileCoverage).toMatchObject({ covered: 108, total: 108 });
  });

  it("rejects duplicate slots and invalid accepted-attempt aliases", () => {
    expect(() =>
      computeProgressSnapshot(
        input([slot("same", "pending"), slot("same", "running")]),
      ),
    ).toThrow("progress_slot_id_duplicate");
    expect(() =>
      computeProgressSnapshot(
        input([
          {
            slotId: "not-accepted",
            required: true,
            state: "running",
            acceptedAttemptOrdinal: 2,
          },
        ]),
      ),
    ).toThrow("progress_attempt_invalid");
    expect(
      computeProgressSnapshot(
        input([
          {
            slotId: "recovered-alias",
            required: true,
            state: "accepted",
            acceptedAttemptOrdinal: 2,
          },
        ]),
      ).counts.recovered,
    ).toBe(1);
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

  it("hides file coverage when uncoveredCount exceeds eligible paths", () => {
    const result = computeProgressSnapshot(
      input([slot("a", "accepted")], {
        assignmentManifest: {
          paths: [
            {
              pathId: "eligible",
              disposition: "reviewable",
              requiredCoveringSlotIds: ["a"],
            },
          ],
          uncoveredCount: 2,
        },
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

  it("rejects schema changes and loss of valid coverage within a generation", () => {
    const previous = computeProgressSnapshot(
      input([slot("a", "running")], {
        assignmentManifest: {
          paths: [
            {
              pathId: "eligible",
              disposition: "reviewable",
              requiredCoveringSlotIds: ["a"],
            },
          ],
        },
      }),
    );
    expect(() =>
      assertProgressTransition(previous, {
        ...previous,
        schemaVersion: 2 as never,
      }),
    ).toThrow("progress_schema_version_changed");
    expect(() =>
      assertProgressTransition(previous, {
        ...previous,
        fileCoverage: { valid: false },
      }),
    ).toThrow("progress_file_coverage_became_invalid");
  });
});
