import type {
  HostedAccountSafeSummary,
  HostedPoolSafeSummary,
  HostedRepositoryBindingSafeSummary,
} from "../hosted-account-pool-dtos";
import type {
  HostedPoolId,
  RepositoryId,
  WorkspaceId,
} from "../../domain/identifiers";

/** Read-model adapter must never return credentialRef, auth.json, or tokens. */
export interface HostedPoolQueryPort {
  getDefaultPoolSummary(
    workspaceId: WorkspaceId,
  ): Promise<HostedPoolSafeSummary | null>;
  listAccountSummaries(
    poolId: HostedPoolId,
  ): Promise<readonly HostedAccountSafeSummary[]>;
  getRepositoryBindingSummary(
    repositoryId: RepositoryId,
  ): Promise<HostedRepositoryBindingSafeSummary | null>;
}
