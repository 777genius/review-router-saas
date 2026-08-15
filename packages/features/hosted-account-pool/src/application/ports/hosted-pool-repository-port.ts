import type {
  HostedAccountPool,
  HostedPoolRepositoryBinding,
} from "../../domain/account-pool";
import type {
  HostedPoolId,
  RepositoryId,
  WorkspaceId,
} from "../../domain/identifiers";

export interface HostedPoolRepositoryPort {
  findDefaultByWorkspaceId(
    workspaceId: WorkspaceId,
  ): Promise<HostedAccountPool | null>;
  findById(poolId: HostedPoolId): Promise<HostedAccountPool | null>;
  insertDefault(pool: HostedAccountPool): Promise<HostedAccountPool>;
  /** Atomically increments pool revision, returning null on CAS conflict. */
  advanceRevision(input: {
    readonly poolId: HostedPoolId;
    readonly expectedRevision: number;
    readonly updatedAt: Date;
  }): Promise<HostedAccountPool | null>;
}

export interface HostedPoolBindingRepositoryPort {
  findByRepositoryId(
    repositoryId: RepositoryId,
  ): Promise<HostedPoolRepositoryBinding | null>;
  save(input: {
    readonly binding: HostedPoolRepositoryBinding;
    readonly expectedRevision: number | null;
    readonly expectedStateVersion: number | null;
  }): Promise<boolean>;
}
