import type {
  InvocationGrantId,
  RelayRequestId,
} from "../../domain/identifiers";
import type { HostedPoolAccount } from "../../domain/account-pool";
import type {
  CurrentRelayRequestFailover,
  InvocationGrant,
} from "../../domain/invocation-grant";

export interface CurrentRelayRequestFailoverPort {
  /**
   * Atomically CAS-persists the grant switch and failed-account disposition.
   * It must not complete or remove the relay request ledger row.
   */
  failover(input: {
    readonly grantId: InvocationGrantId;
    readonly requestId: RelayRequestId;
    readonly now: Date;
    readonly transition: (
      grant: InvocationGrant,
      failedAccount: HostedPoolAccount,
      backupAccount: HostedPoolAccount | null,
    ) => CurrentRelayRequestFailover;
  }): Promise<CurrentRelayRequestFailover>;
}
