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
import type { HostedPoolQueryPort } from "../ports/hosted-pool-query-port";

export function getDefaultHostedPoolSummary(
  workspaceId: WorkspaceId,
  queries: HostedPoolQueryPort,
): Promise<HostedPoolSafeSummary | null> {
  return queries.getDefaultPoolSummary(workspaceId);
}

export function listHostedPoolAccountSummaries(
  poolId: HostedPoolId,
  queries: HostedPoolQueryPort,
): Promise<readonly HostedAccountSafeSummary[]> {
  return queries.listAccountSummaries(poolId);
}

export function getHostedPoolRepositoryBindingSummary(
  repositoryId: RepositoryId,
  queries: HostedPoolQueryPort,
): Promise<HostedRepositoryBindingSafeSummary | null> {
  return queries.getRepositoryBindingSummary(repositoryId);
}
