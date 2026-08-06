import type {
  CreateReviewInvestigationLeaseInput,
  ReviewInvestigationLease,
  ReviewInvestigationLeaseTransitionResult,
} from "../../domain/investigation-lease";

export enum InvestigationLeaseAcquireStatus {
  Acquired = "acquired",
  Restored = "restored",
  Busy = "busy",
  BindingStale = "binding_stale",
  IdempotencyConflict = "idempotency_conflict",
}

export type InvestigationLeaseAcquireResult = Readonly<{
  status: InvestigationLeaseAcquireStatus;
  lease: ReviewInvestigationLease | null;
}>;

export interface InvestigationLeaseQueryPort {
  findLease(leaseId: string): Promise<ReviewInvestigationLease | null>;
}

export interface InvestigationLeaseCommandPort {
  acquireLease(
    candidate: Omit<CreateReviewInvestigationLeaseInput, "fencingToken">,
  ): Promise<InvestigationLeaseAcquireResult>;
  renewLease(input: {
    readonly leaseId: string;
    readonly ownerIdHash: string;
    readonly leaseCapabilityId: string;
    readonly fencingToken: bigint;
    readonly renewRequestIdHash: string;
    readonly renewRequestHash: string;
    readonly now: string;
    readonly expiresAt: string;
  }): Promise<ReviewInvestigationLeaseTransitionResult | null>;
  releaseLease(input: {
    readonly leaseId: string;
    readonly ownerIdHash: string;
    readonly leaseCapabilityId: string;
    readonly fencingToken: bigint;
    readonly releaseRequestIdHash: string;
    readonly releaseRequestHash: string;
    readonly now: string;
  }): Promise<ReviewInvestigationLeaseTransitionResult | null>;
}

export type InvestigationLeaseStorePort = InvestigationLeaseQueryPort &
  InvestigationLeaseCommandPort;
