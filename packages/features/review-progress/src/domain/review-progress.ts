export const reviewProgressSchemaVersion = 1;

export type ReviewSlotState =
  | "pending"
  | "running"
  | "accepted"
  | "exhausted"
  | "cancelled";

export type ReviewSlotProgressInput = {
  readonly slotId: string;
  readonly required: boolean;
  readonly state: ReviewSlotState;
  /** One-based attempt currently running, or accepted for an accepted slot. */
  readonly attemptOrdinal?: number | undefined;
  /** Compatibility alias for producers that only retain accepted-attempt data. */
  readonly acceptedAttemptOrdinal?: number | undefined;
};

export type ReviewPathDisposition =
  | "reviewable"
  | "renamed"
  | "deleted"
  | "excluded";

/** Opaque, generation-stable identity; never format this value for a user. */
export type ReviewPathAssignment = {
  readonly pathId: string;
  readonly disposition: ReviewPathDisposition;
  readonly requiredCoveringSlotIds: readonly string[];
};

export type ReviewAssignmentManifest = {
  readonly paths: readonly ReviewPathAssignment[];
  readonly uncoveredCount?: number;
  readonly excludedCount?: number;
};

export type ProgressCounts = {
  readonly total: number;
  readonly completed: number;
  readonly exhausted: number;
  readonly cancelled: number;
  readonly running: number;
  readonly pending: number;
  readonly retrying: number;
  readonly recovered: number;
  readonly requiredTotal: number;
  readonly requiredCompleted: number;
  readonly requiredExhausted: number;
  readonly requiredCancelled: number;
  readonly optionalTotal: number;
  readonly optionalCompleted: number;
};

export type FileCoverage =
  | { readonly valid: false }
  | {
      readonly valid: true;
      readonly total: number;
      readonly covered: number;
      readonly uncovered: number;
      readonly excluded: number;
    };

export type ProgressPhase =
  | "preparing"
  | "reviewing"
  | "assembling"
  | "publishing"
  | "terminal";

export type ProgressTerminal =
  | "none"
  | "complete"
  | "complete_with_gaps"
  | "failed"
  | "cancelled"
  | "superseded";

export type ProgressSnapshot = {
  readonly schemaVersion: 1;
  readonly generation: number;
  readonly phase: ProgressPhase;
  readonly terminal: ProgressTerminal;
  readonly updatedAt: string;
  readonly counts: ProgressCounts;
  readonly fileCoverage: FileCoverage;
};

export type ComputeProgressSnapshotInput = {
  readonly generation: number;
  readonly phase: ProgressPhase;
  readonly terminal: ProgressTerminal;
  readonly updatedAt: Date | string;
  readonly slots: readonly ReviewSlotProgressInput[];
  readonly assignmentManifest?: ReviewAssignmentManifest | undefined;
  /** Allows a terminal execution to complete after required retries exhaust. */
  readonly allowPartial?: boolean | undefined;
};

export function computeProgressSnapshot(
  input: ComputeProgressSnapshotInput,
): ProgressSnapshot {
  assertNonNegativeInteger(input.generation, "progress_generation_invalid");
  assertLifecycle(input.phase, input.terminal);
  const updatedAt = normalizeInstant(input.updatedAt);
  const slots = new Map<string, ReviewSlotProgressInput>();

  for (const slot of input.slots) {
    assertIdentifier(slot.slotId, "progress_slot_id_invalid");
    if (slots.has(slot.slotId)) throw new Error("progress_slot_id_duplicate");
    validateAttempt(slot);
    slots.set(slot.slotId, slot);
  }

  const required = input.slots.filter((slot) => slot.required);
  const optional = input.slots.filter((slot) => !slot.required);
  const accepted = input.slots.filter((slot) => slot.state === "accepted");
  const counts: ProgressCounts = {
    total: input.slots.length,
    completed: accepted.length,
    exhausted: countState(input.slots, "exhausted"),
    cancelled: countState(input.slots, "cancelled"),
    running: countState(input.slots, "running"),
    pending: countState(input.slots, "pending"),
    retrying: input.slots.filter(
      (slot) => slot.state === "running" && attemptOrdinal(slot) > 1,
    ).length,
    recovered: accepted.filter((slot) => attemptOrdinal(slot) > 1).length,
    requiredTotal: required.length,
    requiredCompleted: countState(required, "accepted"),
    requiredExhausted: countState(required, "exhausted"),
    requiredCancelled: countState(required, "cancelled"),
    optionalTotal: optional.length,
    optionalCompleted: countState(optional, "accepted"),
  };

  assertOutcomeCounts(input, counts);
  return {
    schemaVersion: reviewProgressSchemaVersion,
    generation: input.generation,
    phase: input.phase,
    terminal: input.terminal,
    updatedAt,
    counts,
    fileCoverage: computeFileCoverage(input.assignmentManifest, slots),
  };
}

export function assertProgressTransition(
  previous: ProgressSnapshot,
  next: ProgressSnapshot,
): void {
  if (next.generation < previous.generation) {
    throw new Error("progress_generation_regressed");
  }
  if (next.generation > previous.generation) return;
  if (Date.parse(next.updatedAt) < Date.parse(previous.updatedAt)) {
    throw new Error("progress_update_time_regressed");
  }

  const stableKeys: readonly (keyof ProgressCounts)[] = [
    "total",
    "requiredTotal",
    "optionalTotal",
  ];
  for (const key of stableKeys) {
    if (next.counts[key] !== previous.counts[key]) {
      throw new Error("progress_manifest_changed_within_generation");
    }
  }
  const monotonicKeys: readonly (keyof ProgressCounts)[] = [
    "completed",
    "exhausted",
    "cancelled",
    "recovered",
    "requiredCompleted",
    "requiredExhausted",
    "requiredCancelled",
    "optionalCompleted",
  ];
  for (const key of monotonicKeys) {
    if (next.counts[key] < previous.counts[key]) {
      throw new Error("progress_count_regressed");
    }
  }
  if (previous.terminal !== "none" && next.terminal !== previous.terminal) {
    throw new Error("progress_terminal_changed");
  }
  if (phaseRank(next.phase) < phaseRank(previous.phase)) {
    throw new Error("progress_phase_regressed");
  }
  if (previous.fileCoverage.valid && next.fileCoverage.valid) {
    if (next.fileCoverage.total !== previous.fileCoverage.total) {
      throw new Error("progress_manifest_changed_within_generation");
    }
    if (next.fileCoverage.covered < previous.fileCoverage.covered) {
      throw new Error("progress_file_coverage_regressed");
    }
  }
}

function assertLifecycle(
  phase: ProgressPhase,
  terminal: ProgressTerminal,
): void {
  if ((phase === "terminal") !== (terminal !== "none")) {
    throw new Error("progress_lifecycle_inconsistent");
  }
}

function assertOutcomeCounts(
  input: ComputeProgressSnapshotInput,
  counts: ProgressCounts,
): void {
  if (input.phase !== "terminal") return;
  if (
    counts.requiredExhausted > 0 &&
    input.allowPartial === true &&
    input.terminal !== "complete_with_gaps"
  ) {
    throw new Error("progress_partial_outcome_inconsistent");
  }
  if (
    input.terminal === "complete" &&
    (counts.requiredCompleted !== counts.requiredTotal ||
      counts.requiredExhausted > 0 ||
      counts.requiredCancelled > 0)
  ) {
    throw new Error("progress_complete_outcome_inconsistent");
  }
  if (
    input.terminal === "complete_with_gaps" &&
    (counts.requiredExhausted + counts.requiredCancelled === 0 ||
      counts.requiredCompleted === counts.requiredTotal)
  ) {
    throw new Error("progress_gap_outcome_inconsistent");
  }
}

function validateAttempt(slot: ReviewSlotProgressInput): void {
  const ordinals = [slot.attemptOrdinal, slot.acceptedAttemptOrdinal].filter(
    (value): value is number => value !== undefined,
  );
  if (
    ordinals.some((value) => !Number.isInteger(value) || value < 1) ||
    (slot.acceptedAttemptOrdinal !== undefined && slot.state !== "accepted") ||
    (ordinals.length === 2 && ordinals[0] !== ordinals[1])
  ) {
    throw new Error("progress_attempt_invalid");
  }
}

function attemptOrdinal(slot: ReviewSlotProgressInput): number {
  return slot.attemptOrdinal ?? slot.acceptedAttemptOrdinal ?? 1;
}

function computeFileCoverage(
  manifest: ReviewAssignmentManifest | undefined,
  slots: ReadonlyMap<string, ReviewSlotProgressInput>,
): FileCoverage {
  if (!manifest) return { valid: false };
  const seenPaths = new Set<string>();
  let total = 0;
  let covered = 0;
  for (const path of manifest.paths) {
    if (
      !isIdentifier(path.pathId) ||
      seenPaths.has(path.pathId) ||
      !isPathDisposition(path.disposition)
    ) {
      return { valid: false };
    }
    seenPaths.add(path.pathId);
    const coveringIds = new Set(path.requiredCoveringSlotIds);
    if (coveringIds.size !== path.requiredCoveringSlotIds.length) {
      return { valid: false };
    }
    if (
      [...coveringIds].some(
        (slotId) =>
          !isIdentifier(slotId) ||
          !slots.has(slotId) ||
          slots.get(slotId)?.required !== true,
      )
    ) {
      return { valid: false };
    }
    if (path.disposition === "excluded") continue;
    total += 1;
    if (
      coveringIds.size > 0 &&
      [...coveringIds].every(
        (slotId) => slots.get(slotId)?.state === "accepted",
      )
    ) {
      covered += 1;
    }
  }
  const uncovered = manifest.uncoveredCount ?? 0;
  const excluded = manifest.excludedCount ?? 0;
  if (
    !Number.isInteger(uncovered) ||
    uncovered < 0 ||
    !Number.isInteger(excluded) ||
    excluded < 0 ||
    uncovered > total
  ) {
    return { valid: false };
  }
  return { valid: true, total, covered, uncovered, excluded };
}

function countState(
  slots: readonly ReviewSlotProgressInput[],
  state: ReviewSlotState,
): number {
  return slots.filter((slot) => slot.state === state).length;
}

function phaseRank(phase: ProgressPhase): number {
  return {
    preparing: 0,
    reviewing: 1,
    assembling: 2,
    publishing: 3,
    terminal: 4,
  }[phase];
}

function normalizeInstant(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime()))
    throw new Error("progress_updated_at_invalid");
  return date.toISOString();
}

function assertNonNegativeInteger(value: number, code: string): void {
  if (!Number.isInteger(value) || value < 0) throw new Error(code);
}

function assertIdentifier(value: string, code: string): void {
  if (!isIdentifier(value)) throw new Error(code);
}

function isIdentifier(value: string): boolean {
  return value.length > 0 && value.length <= 256 && value.trim() === value;
}

function isPathDisposition(value: string): value is ReviewPathDisposition {
  return ["reviewable", "renamed", "deleted", "excluded"].includes(value);
}
