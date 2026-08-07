import {
  CurrentPublicationLifecycleStatus,
  LiveReviewPublicationLifecycleStatus,
  ReviewPublicationLifecycleExpectationStatus,
  type CurrentPublicationLifecycleDecision,
  type CurrentPublicationLifecyclePort,
  type LiveReviewPublicationLifecycleTargetIdentity,
  type LiveReviewPublicationLifecyclePort,
  type ReviewPublicationLifecycleExpectationDecision,
  type ReviewPublicationLifecycleExpectationPort,
  type ReviewPublicationLifecycleTargetIdentity,
} from "../ports/review-publication-ports";
import type { ReviewPublicationScope } from "../../domain/review-publication-attempt";
import {
  extractUniqueReviewFindingFingerprint,
  isReviewFindingFingerprint,
} from "../../domain/review-finding-marker";
import { ReviewPublicationLifecycleObservationVersion } from "../../domain/review-lifecycle-thread-state-witness";

export class ResolveCurrentPublicationLifecycle implements CurrentPublicationLifecyclePort {
  constructor(
    private readonly dependencies: {
      readonly expectations: ReviewPublicationLifecycleExpectationPort;
      readonly live: LiveReviewPublicationLifecyclePort;
    },
  ) {}

  async resolve(
    scope: ReviewPublicationScope,
  ): Promise<CurrentPublicationLifecycleDecision> {
    let expectation: ReviewPublicationLifecycleExpectationDecision;
    try {
      expectation = await this.dependencies.expectations.resolve(scope);
    } catch {
      return unavailable();
    }
    if (
      expectation.status === ReviewPublicationLifecycleExpectationStatus.Missing
    ) {
      return missing();
    }
    if (
      expectation.status === ReviewPublicationLifecycleExpectationStatus.Invalid
    ) {
      return invalid();
    }
    if (
      expectation.status !==
      ReviewPublicationLifecycleExpectationStatus.Available
    ) {
      return unavailable();
    }

    try {
      assertExpectation(expectation);
      const live = await this.dependencies.live.resolve(scope);
      if (live.status === LiveReviewPublicationLifecycleStatus.Missing) {
        return missing();
      }
      if (live.status !== LiveReviewPublicationLifecycleStatus.Available) {
        return unavailable();
      }
      assertLiveLifecycle(live);
      if (
        live.reviewedHeadSha !== expectation.reviewedHeadSha ||
        live.commandLedgerWatermark !== expectation.commandLedgerWatermark ||
        lifecycleChangedAfterBoundary(
          expectation.targets,
          live.targets,
          expectation.observedNotAfter,
          expectation.createdTargetFingerprints,
          expectation.lifecycleObservationVersion,
        )
      ) {
        return changed();
      }
      return {
        status: CurrentPublicationLifecycleStatus.Current,
        lifecycleStateHash: expectation.lifecycleStateHash,
        commandLedgerWatermark: expectation.commandLedgerWatermark,
      };
    } catch {
      return unavailable();
    }
  }
}

export function reviewPublicationLifecycleExpectationFromProjection(input: {
  readonly reviewedHeadSha: string;
  readonly lifecycleStateHash: string;
  readonly commandLedgerWatermark: bigint;
  readonly projectionEnvelopeJson: string;
  readonly legacyObservationBoundary: Date;
}): ReviewPublicationLifecycleExpectationDecision {
  const envelope = JSON.parse(input.projectionEnvelopeJson) as unknown;
  const publishing = requiredRecord(
    requiredRecord(envelope, "projection_envelope").publishing,
    "projection_publishing",
  );
  if (!Array.isArray(publishing.lifecycle)) {
    throw new Error("projection_lifecycle_invalid");
  }
  const lifecycleObservationVersion = observationVersion(publishing);
  const targets = publishing.lifecycle.map((candidate, index) => {
    const target = requiredRecord(candidate, `projection_lifecycle_${index}`);
    return Object.freeze({
      targetId: requiredIdentifier(target.targetId, "lifecycle_target_id"),
      threadId: requiredIdentifier(target.threadId, "lifecycle_thread_id"),
      mutationEligible: requiredBoolean(
        target.mutationEligible,
        "lifecycle_mutation_eligible",
      ),
      ...targetObservation(target, lifecycleObservationVersion),
    });
  });
  const createdTargetFingerprints = inlineFindingFingerprints(publishing);
  assertUniqueTargets(targets);
  const decision: ReviewPublicationLifecycleExpectationDecision = {
    status: ReviewPublicationLifecycleExpectationStatus.Available,
    reviewedHeadSha: requiredCommitSha(input.reviewedHeadSha),
    lifecycleStateHash: requiredNonEmpty(
      input.lifecycleStateHash,
      "lifecycle_state_hash",
    ),
    commandLedgerWatermark: input.commandLedgerWatermark,
    observedNotAfter: requiredDate(
      input.legacyObservationBoundary,
      "authorization_created_at",
    ),
    lifecycleObservationVersion,
    targets: Object.freeze([...targets].sort(compareTargets)),
    createdTargetFingerprints,
  };
  assertExpectation(decision);
  return Object.freeze(decision);
}

function assertExpectation(
  expectation: Extract<
    ReviewPublicationLifecycleExpectationDecision,
    { status: ReviewPublicationLifecycleExpectationStatus.Available }
  >,
): void {
  requiredCommitSha(expectation.reviewedHeadSha);
  requiredNonEmpty(expectation.lifecycleStateHash, "lifecycle_state_hash");
  if (expectation.commandLedgerWatermark < 0n) {
    throw new Error("command_ledger_watermark_invalid");
  }
  requiredDate(expectation.observedNotAfter, "observed_not_after");
  if (
    expectation.lifecycleObservationVersion !== null &&
    expectation.lifecycleObservationVersion !==
      ReviewPublicationLifecycleObservationVersion.ThreadStateV1
  ) {
    throw new Error("lifecycle_observation_version_unsupported");
  }
  assertUniqueTargets(expectation.targets);
  for (const target of expectation.targets) {
    const observation = target.observation;
    if (
      expectation.lifecycleObservationVersion === null &&
      observation !== undefined
    ) {
      throw new Error("lifecycle_observation_unexpected");
    }
    if (
      expectation.lifecycleObservationVersion ===
        ReviewPublicationLifecycleObservationVersion.ThreadStateV1 &&
      observation === undefined
    ) {
      throw new Error("lifecycle_observation_incomplete");
    }
    if (!observation) continue;
    requiredFingerprint(
      observation.markerFingerprint,
      "lifecycle_marker_fingerprint",
    );
    requiredSha256(observation.threadStateHash, "lifecycle_thread_state_hash");
  }
  assertUniqueFingerprints(expectation.createdTargetFingerprints);
}

function assertLiveLifecycle(input: {
  readonly reviewedHeadSha: string;
  readonly commandLedgerWatermark: bigint;
  readonly targets: readonly LiveReviewPublicationLifecycleTargetIdentity[];
}): void {
  requiredCommitSha(input.reviewedHeadSha);
  if (input.commandLedgerWatermark < 0n) {
    throw new Error("command_ledger_watermark_invalid");
  }
  for (const target of input.targets) {
    requiredFingerprint(target.markerFingerprint, "marker_fingerprint");
    requiredSha256(target.threadStateHash, "lifecycle_thread_state_hash");
    requiredBoolean(target.isResolved, "lifecycle_target_resolved");
    requiredBoolean(
      target.parentOwnedByIntegration,
      "lifecycle_parent_ownership",
    );
    requiredBoolean(
      target.hasRelevantInteractionAfterParent,
      "lifecycle_target_interaction",
    );
    requiredDate(target.parentCreatedAt, "parent_created_at");
    requiredDate(target.lastRelevantChangeAt, "last_relevant_change_at");
    if (target.lastRelevantChangeAt < target.parentCreatedAt) {
      throw new Error("lifecycle_target_timestamp_order_invalid");
    }
    if (
      target.lastRelevantChangeAt > target.parentCreatedAt &&
      !target.hasRelevantInteractionAfterParent
    ) {
      throw new Error("lifecycle_target_interaction_inconsistent");
    }
  }
  assertUniqueTargets(input.targets);
}

function lifecycleChangedAfterBoundary(
  expected: readonly ReviewPublicationLifecycleTargetIdentity[],
  live: readonly LiveReviewPublicationLifecycleTargetIdentity[],
  boundary: Date,
  createdTargetFingerprints: readonly string[],
  lifecycleObservationVersion: ReviewPublicationLifecycleObservationVersion | null,
): boolean {
  const expectedByTargetId = new Map(
    expected.map((target) => [target.targetId, target] as const),
  );
  const liveByTargetId = new Map(
    live.map((target) => [target.targetId, target] as const),
  );
  for (const target of expected) {
    const current = liveByTargetId.get(target.targetId);
    if (!current) {
      if (
        lifecycleObservationVersion ===
        ReviewPublicationLifecycleObservationVersion.ThreadStateV1
      ) {
        return true;
      }
      continue;
    }
    if (
      current.threadId !== target.threadId ||
      lifecycleTargetChanged(
        target,
        current,
        boundary,
        lifecycleObservationVersion,
      ) ||
      (current.isResolved && !target.mutationEligible)
    ) {
      return true;
    }
  }
  const permittedFingerprints = new Set(createdTargetFingerprints);
  return live.some((target) => {
    if (expectedByTargetId.has(target.targetId) || target.isResolved) {
      return false;
    }
    return (
      !definitelyAfterBoundary(target.parentCreatedAt, boundary) ||
      !target.parentOwnedByIntegration ||
      target.hasRelevantInteractionAfterParent ||
      !permittedFingerprints.has(target.markerFingerprint)
    );
  });
}

function targetObservation(
  target: Readonly<Record<string, unknown>>,
  lifecycleObservationVersion: ReviewPublicationLifecycleObservationVersion | null,
): Readonly<{
  observation?: {
    readonly markerFingerprint: string;
    readonly threadStateHash: string;
  };
}> {
  if (lifecycleObservationVersion === null) {
    if (
      target.markerFingerprint !== undefined ||
      target.threadStateHash !== undefined
    ) {
      throw new Error("projection_lifecycle_observation_version_missing");
    }
    return Object.freeze({});
  }
  return Object.freeze({
    observation: Object.freeze({
      markerFingerprint: requiredFingerprint(
        target.markerFingerprint,
        "lifecycle_marker_fingerprint",
      ),
      threadStateHash: requiredSha256(
        target.threadStateHash,
        "lifecycle_thread_state_hash",
      ),
    }),
  });
}

function lifecycleTargetChanged(
  expected: ReviewPublicationLifecycleTargetIdentity,
  live: LiveReviewPublicationLifecycleTargetIdentity,
  legacyBoundary: Date,
  lifecycleObservationVersion: ReviewPublicationLifecycleObservationVersion | null,
): boolean {
  const observation = expected.observation;
  if (lifecycleObservationVersion === null) {
    return couldBeAfterBoundary(live.lastRelevantChangeAt, legacyBoundary);
  }
  if (!observation) throw new Error("lifecycle_observation_incomplete");
  return (
    live.markerFingerprint !== observation.markerFingerprint ||
    live.threadStateHash !== observation.threadStateHash
  );
}

function observationVersion(
  publishing: Readonly<Record<string, unknown>>,
): ReviewPublicationLifecycleObservationVersion | null {
  const value = publishing.lifecycleObservationVersion;
  if (value === undefined) return null;
  if (value !== ReviewPublicationLifecycleObservationVersion.ThreadStateV1) {
    throw new Error("projection_lifecycle_observation_version_unsupported");
  }
  return value;
}

function inlineFindingFingerprints(
  publishing: Readonly<Record<string, unknown>>,
): readonly string[] {
  if (!Array.isArray(publishing.inlineReviewChunks)) return Object.freeze([]);
  const fingerprints: string[] = [];
  publishing.inlineReviewChunks.forEach((candidate, chunkIndex) => {
    const chunk = requiredRecord(candidate, `projection_inline_${chunkIndex}`);
    if (!Array.isArray(chunk.comments)) {
      throw new Error("projection_inline_comments_invalid");
    }
    chunk.comments.forEach((value, commentIndex) => {
      const comment = requiredRecord(
        value,
        `projection_inline_${chunkIndex}_${commentIndex}`,
      );
      const marker = requiredNonEmpty(
        comment.marker,
        "projection_inline_marker",
      );
      const fingerprint = extractUniqueReviewFindingFingerprint(marker);
      if (!fingerprint) throw new Error("projection_inline_marker_invalid");
      fingerprints.push(fingerprint);
    });
  });
  const sorted = [...fingerprints].sort();
  assertUniqueFingerprints(sorted);
  return Object.freeze(sorted);
}

function assertUniqueFingerprints(fingerprints: readonly string[]): void {
  const unique = new Set<string>();
  for (const value of fingerprints) {
    const fingerprint = requiredFingerprint(value, "marker_fingerprint");
    if (unique.has(fingerprint)) {
      throw new Error("marker_fingerprint_duplicate");
    }
    unique.add(fingerprint);
  }
}

function requiredFingerprint(value: unknown, field: string): string {
  if (!isReviewFindingFingerprint(value)) {
    throw new Error(`${field}_invalid`);
  }
  return value;
}

function requiredSha256(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${field}_invalid`);
  }
  return value;
}

function couldBeAfterBoundary(change: Date, boundary: Date): boolean {
  return secondPrecision(change) >= secondPrecision(boundary);
}

function definitelyAfterBoundary(change: Date, boundary: Date): boolean {
  return secondPrecision(change) > secondPrecision(boundary);
}

function secondPrecision(value: Date): number {
  return Math.floor(value.getTime() / 1_000);
}

function assertUniqueTargets(
  targets: readonly Readonly<{ targetId: string; threadId: string }>[],
): void {
  const identities = new Set<string>();
  for (const target of targets) {
    const targetId = requiredIdentifier(target.targetId, "lifecycle_target_id");
    const threadId = requiredIdentifier(target.threadId, "lifecycle_thread_id");
    const identity = `${targetId}\n${threadId}`;
    if (identities.has(identity)) {
      throw new Error("lifecycle_target_duplicate");
    }
    identities.add(identity);
  }
}

function compareTargets(
  left: ReviewPublicationLifecycleTargetIdentity,
  right: ReviewPublicationLifecycleTargetIdentity,
): number {
  return (
    left.targetId.localeCompare(right.targetId) ||
    left.threadId.localeCompare(right.threadId)
  );
}

function requiredRecord(
  value: unknown,
  field: string,
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field}_invalid`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function requiredIdentifier(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    })
  ) {
    throw new Error(`${field}_invalid`);
  }
  return value;
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${field}_invalid`);
  return value;
}

function requiredNonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field}_invalid`);
  }
  return value;
}

function requiredCommitSha(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/u.test(value)) {
    throw new Error("reviewed_head_sha_invalid");
  }
  return value;
}

function requiredDate(value: Date, field: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error(`${field}_invalid`);
  }
  return new Date(value);
}

function changed(): CurrentPublicationLifecycleDecision {
  return {
    status: CurrentPublicationLifecycleStatus.Changed,
    lifecycleStateHash: null,
    commandLedgerWatermark: null,
  };
}

function missing(): CurrentPublicationLifecycleDecision {
  return {
    status: CurrentPublicationLifecycleStatus.Missing,
    lifecycleStateHash: null,
    commandLedgerWatermark: null,
  };
}

function unavailable(): CurrentPublicationLifecycleDecision {
  return {
    status: CurrentPublicationLifecycleStatus.Unavailable,
    lifecycleStateHash: null,
    commandLedgerWatermark: null,
  };
}

function invalid(): CurrentPublicationLifecycleDecision {
  return {
    status: CurrentPublicationLifecycleStatus.Invalid,
    lifecycleStateHash: null,
    commandLedgerWatermark: null,
  };
}
