import type {
  HostedBindingId,
  InvocationGrantId,
  InvocationId,
} from "../../domain/identifiers";
import type { InvocationGrant } from "../../domain/invocation-grant";

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

  /** Atomically marks the capability revoked. */
  revoke(input: {
    readonly grantId: InvocationGrantId;
    readonly revokedAt: Date;
    readonly transition: (grant: InvocationGrant) => InvocationGrant;
  }): Promise<InvocationGrant>;
}
