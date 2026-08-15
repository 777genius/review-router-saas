import type {
  InvocationGrantId,
  RelayRequestId,
} from "../../domain/identifiers";
import type {
  InvocationGrant,
  RelayAdmission,
} from "../../domain/invocation-grant";

export interface RelayRequestAdmissionPort {
  /** Atomically transitions the grant and appends admission metadata. */
  admit(input: {
    readonly grantId: InvocationGrantId;
    readonly requestId: RelayRequestId;
    readonly ordinal: number;
    readonly idempotencyKeyHash: string;
    readonly requestBytes: number;
    readonly transition: (current: InvocationGrant) => RelayAdmission;
  }): Promise<RelayAdmission>;
}

export interface RelayRequestCompletionPort {
  /** Atomically transitions the grant and records sanitized response evidence. */
  complete(input: {
    readonly grantId: InvocationGrantId;
    readonly requestId: RelayRequestId;
    readonly responseBytes: number;
    readonly responseHash: string | null;
    readonly errorCode: string | null;
    readonly completedAt: Date;
    readonly transition: (current: InvocationGrant) => InvocationGrant;
  }): Promise<InvocationGrant>;
}

export interface RelayResponseStartedPort {
  /** Atomically fences failover when upstream accepts or starts a response. */
  markStarted(input: {
    readonly grantId: InvocationGrantId;
    readonly requestId: RelayRequestId;
    readonly startedAt: Date;
    readonly transition: (current: InvocationGrant) => InvocationGrant;
  }): Promise<InvocationGrant>;
}
