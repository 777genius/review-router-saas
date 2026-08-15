import type { HostedPoolAccount } from "../../domain/account-pool";
import type { HostedAccountId, HostedPoolId } from "../../domain/identifiers";

export interface HostedAccountRepositoryPort {
  findById(accountId: HostedAccountId): Promise<HostedPoolAccount | null>;
  findBySubjectFingerprint(input: {
    poolId: HostedPoolId;
    subjectFingerprint: string;
  }): Promise<HostedPoolAccount | null>;
  listByPoolId(poolId: HostedPoolId): Promise<readonly HostedPoolAccount[]>;
  /** Must atomically compare auth generation and persist the replacement. */
  replaceCredential(input: {
    account: HostedPoolAccount;
    expectedAuthGeneration: number;
  }): Promise<boolean>;
  saveAvailability(input: {
    readonly account: HostedPoolAccount;
    readonly expectedHealthVersion: number;
  }): Promise<boolean>;
}
