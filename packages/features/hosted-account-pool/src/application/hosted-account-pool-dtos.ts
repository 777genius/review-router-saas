import type { HostedAccountAvailability } from "../domain/account-pool";
import type {
  HostedAccountId,
  HostedBindingId,
  HostedPoolId,
  RepositoryId,
  WorkspaceId,
} from "../domain/identifiers";

/** Mutation DTO carries only an opaque AR credential reference and safe metadata. */
export type ImportEnrollHostedAccountCommand = {
  readonly accountId: HostedAccountId;
  readonly poolId: HostedPoolId;
  readonly workspaceId: WorkspaceId;
  readonly label: string;
  readonly priority: number;
  readonly expectedPoolRevision: number;
  /** Command-only secret bytes. Must never be persisted or returned by a read model. */
  readonly authJsonBytes: Uint8Array;
  readonly requestedAt: Date;
};

export type BindRepositoryToHostedPoolCommand = {
  readonly bindingId: HostedBindingId;
  readonly repositoryId: RepositoryId;
  readonly workspaceId: WorkspaceId;
  readonly expectedRevision: number | null;
  readonly requestedAt: Date;
};

export type HostedAccountSafeSummary = {
  readonly id: HostedAccountId;
  readonly label: string;
  readonly priority: number;
  readonly availability: HostedAccountAvailability;
  readonly healthVersion: number;
  readonly authGeneration: number;
  readonly validatedAt: Date;
  readonly credentialExpiresAt: Date | null;
  readonly refreshDue: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

export type HostedPoolSafeSummary = {
  readonly id: HostedPoolId;
  readonly workspaceId: WorkspaceId;
  readonly status: "active" | "paused";
  readonly isDefault: true;
  readonly revision: number;
  readonly accountCount: number;
  readonly healthyAccountCount: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

export type HostedRepositoryBindingSafeSummary = {
  readonly id: HostedBindingId;
  readonly bindingId: HostedBindingId;
  readonly repositoryId: RepositoryId;
  readonly poolId: HostedPoolId;
  readonly revision: number;
  readonly stateVersion: number;
  readonly status: "pending_activation" | "active" | "draining";
  readonly activatedAt: Date | null;
  readonly updatedAt: Date;
};
