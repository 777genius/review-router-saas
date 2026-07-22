import {
  cloneReviewObservation,
  reviewObservationAttemptIdentity,
  sameReviewObservationAcceptance,
  type ReviewObservation,
} from "../../domain/review-observation";
import { sameScope } from "../../domain/review-evidence-primitives";
import {
  ReviewObservationAcceptPersistenceStatus,
  type ReviewEvidencePrunerPort,
  type ReviewObservationAcceptPersistenceResult,
  type ReviewObservationCommandPort,
  type ReviewObservationQueryPort,
} from "../../application/ports/review-observation-ports";

export class InMemoryReviewObservationStore
  implements
    ReviewObservationCommandPort,
    ReviewObservationQueryPort,
    ReviewEvidencePrunerPort
{
  private readonly observations = new Map<string, ReviewObservation>();
  private readonly attemptIdentityIndex = new Map<string, string>();
  private readonly protectedObservationIds = new Set<string>();

  async acceptObservation(
    observation: ReviewObservation,
  ): Promise<ReviewObservationAcceptPersistenceResult> {
    const candidate = cloneReviewObservation(observation);
    const byId = this.observations.get(candidate.observationId);
    if (byId) return resolveExisting(byId, candidate);
    const attemptIdentity = reviewObservationAttemptIdentity(candidate);
    const existingId = this.attemptIdentityIndex.get(attemptIdentity);
    if (existingId) {
      const existing = this.observations.get(existingId);
      if (!existing) throw new Error("review_observation_memory_index_corrupt");
      return resolveExisting(existing, candidate);
    }
    this.observations.set(candidate.observationId, candidate);
    this.attemptIdentityIndex.set(attemptIdentity, candidate.observationId);
    return Object.freeze({
      status: ReviewObservationAcceptPersistenceStatus.Accepted,
      observation: cloneReviewObservation(candidate),
    });
  }

  async findCandidates(
    input: Parameters<ReviewObservationQueryPort["findCandidates"]>[0],
  ): Promise<readonly ReviewObservation[]> {
    if (!Number.isSafeInteger(input.limit) || input.limit <= 0) {
      throw new Error("review_observation_query_limit_invalid");
    }
    return [...this.observations.values()]
      .filter(
        (observation) =>
          sameScope(observation.scope, input.scope) &&
          observation.trustDomain === input.trustDomain &&
          observation.providerInvocationKey === input.providerInvocationKey &&
          observation.reuseExpiresAtMs > input.reusableAfterMs,
      )
      .sort(
        (left, right) =>
          right.createdAtMs - left.createdAtMs ||
          left.observationId.localeCompare(right.observationId),
      )
      .slice(0, input.limit)
      .map(cloneReviewObservation);
  }

  async findById(observationId: string): Promise<ReviewObservation | null> {
    const observation = this.observations.get(observationId);
    return observation ? cloneReviewObservation(observation) : null;
  }

  async pruneRetainedObservations(
    input: Parameters<ReviewEvidencePrunerPort["pruneRetainedObservations"]>[0],
  ): Promise<number> {
    const removable = [...this.observations.values()]
      .filter(
        (observation) =>
          observation.retainUntilMs <= input.retainUntilOrBeforeMs &&
          !this.protectedObservationIds.has(observation.observationId),
      )
      .sort(
        (left, right) =>
          left.retainUntilMs - right.retainUntilMs ||
          left.observationId.localeCompare(right.observationId),
      )
      .slice(0, input.limit);
    for (const observation of removable) {
      this.observations.delete(observation.observationId);
      this.attemptIdentityIndex.delete(
        reviewObservationAttemptIdentity(observation),
      );
    }
    return removable.length;
  }

  protectObservation(observationId: string): void {
    this.protectedObservationIds.add(observationId);
  }

  releaseObservation(observationId: string): void {
    this.protectedObservationIds.delete(observationId);
  }

  all(): readonly ReviewObservation[] {
    return Object.freeze(
      [...this.observations.values()]
        .sort((left, right) =>
          left.observationId.localeCompare(right.observationId),
        )
        .map(cloneReviewObservation),
    );
  }
}

function resolveExisting(
  existing: ReviewObservation,
  candidate: ReviewObservation,
): ReviewObservationAcceptPersistenceResult {
  if (!sameReviewObservationAcceptance(existing, candidate)) {
    return Object.freeze({
      status: ReviewObservationAcceptPersistenceStatus.Conflict,
    });
  }
  return Object.freeze({
    status: ReviewObservationAcceptPersistenceStatus.Idempotent,
    observation: cloneReviewObservation(existing),
  });
}
