import type { ClockPort } from "../../application/ports/clock-port";
import type {
  ReviewExecutionAttemptFacts,
  ReviewExecutionAttemptFactsPort,
} from "../../application/ports/review-execution-attempt-facts-port";
import type {
  CurrentEvidenceWriteSafetyDecisionPort,
  CurrentReviewReusePolicyPort,
  EvidenceWriteSafetyDecision,
} from "../../application/ports/review-evidence-safety-port";
import type { ReviewObservationIdentityPort } from "../../application/ports/review-observation-ports";
import type {
  ReviewReuseCompatibilityPolicy,
  ReviewReuseSafetyDecision,
} from "../../domain/review-reuse-eligibility";

export class InMemoryReviewExecutionAttemptFactsPort implements ReviewExecutionAttemptFactsPort {
  private readonly attempts = new Map<string, ReviewExecutionAttemptFacts>();

  put(facts: ReviewExecutionAttemptFacts): void {
    this.attempts.set(
      attemptKey(facts.attemptId, facts.leaseCapabilityId),
      facts,
    );
  }

  async findAttemptFacts(input: {
    readonly attemptId: string;
    readonly leaseCapabilityId: string;
  }): Promise<ReviewExecutionAttemptFacts | null> {
    return (
      this.attempts.get(attemptKey(input.attemptId, input.leaseCapabilityId)) ??
      null
    );
  }
}

export class InMemoryReviewEvidenceSafetyPort
  implements
    CurrentEvidenceWriteSafetyDecisionPort,
    CurrentReviewReusePolicyPort
{
  constructor(
    public writeDecision: EvidenceWriteSafetyDecision,
    public reusePolicy: Readonly<{
      safetyDecision: ReviewReuseSafetyDecision;
      compatibility: ReviewReuseCompatibilityPolicy;
    }> | null,
  ) {}

  async resolveEvidenceWriteDecision(): Promise<EvidenceWriteSafetyDecision> {
    return this.writeDecision;
  }

  async resolveReviewReusePolicy(): Promise<Readonly<{
    safetyDecision: ReviewReuseSafetyDecision;
    compatibility: ReviewReuseCompatibilityPolicy;
  }> | null> {
    return this.reusePolicy;
  }
}

export class FixedClock implements ClockPort {
  constructor(private currentMs: number) {}

  nowMs(): number {
    return this.currentMs;
  }

  set(nowMs: number): void {
    this.currentMs = nowMs;
  }
}

export class SequentialReviewObservationIdentityPort implements ReviewObservationIdentityPort {
  private sequence = 0;

  constructor(private readonly prefix = "observation") {}

  nextObservationId(): string {
    this.sequence += 1;
    return `${this.prefix}-${this.sequence}`;
  }
}

function attemptKey(attemptId: string, leaseCapabilityId: string): string {
  return `${attemptId}\0${leaseCapabilityId}`;
}
