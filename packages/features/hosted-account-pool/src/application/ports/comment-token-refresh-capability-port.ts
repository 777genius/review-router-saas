import type {
  HostedBindingId,
  InvocationGrantId,
  InvocationId,
} from "../../domain/identifiers";
import type {
  CommentTokenRefreshConsumption,
  InvocationGrant,
} from "../../domain/invocation-grant";

export interface CommentTokenRefreshCapabilityPort {
  issue(input: {
    readonly grantId: InvocationGrantId;
    readonly invocationId: InvocationId;
    readonly repositoryBindingId: HostedBindingId;
    readonly expiresAt: Date;
    readonly maxUses: number;
  }): Promise<{
    readonly plaintextToken: string;
    readonly tokenHash: string;
  }>;

  /** Atomically validates the presented hash, transitions, and persists useCount. */
  consume(input: {
    readonly grantId: InvocationGrantId;
    readonly presentedTokenHash: string;
    /** SHA-256 of the caller idempotency key; unique per logical refresh. */
    readonly requestIdHash: string;
    readonly now: Date;
    readonly transition: (
      grant: InvocationGrant,
    ) => CommentTokenRefreshConsumption;
  }): Promise<CommentTokenRefreshConsumption>;

  /** Atomically marks the capability revoked. */
  revoke(input: {
    readonly grantId: InvocationGrantId;
    readonly revokedAt: Date;
    readonly transition: (grant: InvocationGrant) => InvocationGrant;
  }): Promise<InvocationGrant>;
}
