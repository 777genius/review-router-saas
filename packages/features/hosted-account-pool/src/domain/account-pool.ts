import { z } from "zod";
import type {
  HostedAccountId,
  HostedBindingId,
  HostedPoolId,
  RepositoryId,
  WorkspaceId,
} from "./identifiers";

export const hostedPoolAuthMode =
  "codex_subscription_oauth_hosted_pool" as const;

export type HostedAccountPool = {
  readonly id: HostedPoolId;
  readonly workspaceId: WorkspaceId;
  readonly isDefault: true;
  readonly revision: number;
  readonly status: "active" | "paused";
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

export type HostedPoolRepositoryBinding = {
  readonly bindingId: HostedBindingId;
  readonly repositoryId: RepositoryId;
  readonly workspaceId: WorkspaceId;
  readonly poolId: HostedPoolId;
  readonly authMode: typeof hostedPoolAuthMode;
  readonly status: "pending_activation" | "active" | "draining";
  readonly revision: number;
  readonly stateVersion: number;
  readonly attestedBindingRevision: number | null;
  readonly activatedAt: Date | null;
  readonly drainingAt: Date | null;
  readonly boundAt: Date;
  readonly updatedAt: Date;
};

export type CredentialMetadata = {
  /** Opaque AR-owned handle. Never an access token, refresh token, or auth.json. */
  readonly credentialRef: string;
  readonly subjectFingerprint: string;
  readonly authGeneration: number;
  readonly validatedAt: Date;
  readonly expiresAt: Date | null;
};

export type HostedAccountAvailability =
  | { readonly status: "healthy" }
  | { readonly status: "paused"; readonly reason: string }
  | {
      readonly status: "cooldown";
      readonly reason: string;
      readonly until: Date;
    }
  | { readonly status: "quarantined"; readonly reason: string };

export type HostedPoolAccount = {
  readonly id: HostedAccountId;
  readonly poolId: HostedPoolId;
  readonly label: string;
  readonly priority: number;
  readonly credential: CredentialMetadata;
  readonly availability: HostedAccountAvailability;
  readonly healthVersion: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

const credentialMetadataSchema = z
  .object({
    credentialRef: z.string().trim().min(1).max(512),
    subjectFingerprint: z.string().trim().min(1).max(256),
    authGeneration: z.number().int().positive(),
    validatedAt: z.date(),
    expiresAt: z.date().nullable(),
  })
  .strict();

export function createDefaultHostedAccountPool(input: {
  readonly id: HostedPoolId;
  readonly workspaceId: WorkspaceId;
  readonly now: Date;
}): HostedAccountPool {
  return {
    id: input.id,
    workspaceId: input.workspaceId,
    isDefault: true,
    revision: 1,
    status: "active",
    createdAt: input.now,
    updatedAt: input.now,
  };
}

export function enrollHostedPoolAccount(input: {
  readonly id: HostedAccountId;
  readonly poolId: HostedPoolId;
  readonly label: string;
  readonly priority: number;
  readonly credential: CredentialMetadata;
  readonly now: Date;
}): HostedPoolAccount {
  return {
    id: input.id,
    poolId: input.poolId,
    label: z.string().trim().min(1).max(120).parse(input.label),
    priority: z.number().int().min(0).parse(input.priority),
    credential: credentialMetadataSchema.parse(input.credential),
    availability: { status: "healthy" },
    healthVersion: 1,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

/** CAS transition for the short AR refresh/writeback mutation fence. */
export function replaceHostedAccountCredential(input: {
  readonly account: HostedPoolAccount;
  readonly expectedAuthGeneration: number;
  readonly credential: CredentialMetadata;
  readonly now: Date;
}): HostedPoolAccount {
  const credential = credentialMetadataSchema.parse(input.credential);
  if (
    input.account.credential.authGeneration !== input.expectedAuthGeneration
  ) {
    throw new Error("hosted_account_auth_generation_conflict");
  }
  if (credential.authGeneration !== input.expectedAuthGeneration + 1) {
    throw new Error("hosted_account_auth_generation_must_increment");
  }
  if (
    credential.subjectFingerprint !==
    input.account.credential.subjectFingerprint
  ) {
    throw new Error("hosted_account_subject_mismatch");
  }
  return {
    ...input.account,
    credential,
    availability: { status: "healthy" },
    healthVersion: input.account.healthVersion + 1,
    updatedAt: input.now,
  };
}

export function bindRepositoryToHostedPool(input: {
  readonly id: HostedBindingId;
  readonly repositoryId: RepositoryId;
  readonly workspaceId: WorkspaceId;
  readonly pool: HostedAccountPool;
  readonly currentBinding?: HostedPoolRepositoryBinding | null;
  readonly now: Date;
}): HostedPoolRepositoryBinding {
  if (input.pool.workspaceId !== input.workspaceId) {
    throw new Error("hosted_pool_workspace_mismatch");
  }
  if (input.pool.status !== "active") {
    throw new Error("hosted_pool_not_active");
  }
  if (
    input.currentBinding &&
    input.currentBinding.workspaceId !== input.workspaceId
  ) {
    throw new Error("hosted_pool_binding_workspace_mismatch");
  }
  return {
    bindingId: input.currentBinding?.bindingId ?? input.id,
    repositoryId: input.repositoryId,
    workspaceId: input.workspaceId,
    poolId: input.pool.id,
    authMode: hostedPoolAuthMode,
    // Every new desired configuration requires fresh exact v5 attestation.
    status: "pending_activation",
    revision: (input.currentBinding?.revision ?? 0) + 1,
    stateVersion: (input.currentBinding?.stateVersion ?? 0) + 1,
    attestedBindingRevision: null,
    activatedAt: null,
    drainingAt: null,
    boundAt: input.currentBinding?.boundAt ?? input.now,
    updatedAt: input.now,
  };
}

export function transitionHostedPoolBindingStatus(input: {
  readonly binding: HostedPoolRepositoryBinding;
  readonly status: HostedPoolRepositoryBinding["status"];
  readonly expectedRevision: number;
  readonly expectedStateVersion: number;
  readonly now: Date;
}): HostedPoolRepositoryBinding {
  if (input.binding.revision !== input.expectedRevision) {
    throw new Error("hosted_pool_binding_revision_conflict");
  }
  if (input.binding.stateVersion !== input.expectedStateVersion) {
    throw new Error("hosted_pool_binding_state_version_conflict");
  }
  const allowed =
    (input.binding.status === "pending_activation" &&
      input.status === "active") ||
    (input.binding.status === "active" && input.status === "draining") ||
    input.binding.status === input.status;
  if (!allowed)
    throw new Error("hosted_pool_binding_status_transition_invalid");
  if (input.binding.status === input.status) return input.binding;
  return {
    ...input.binding,
    status: input.status,
    // Workflow/grant authority embeds this configuration revision. Activation
    // changes lifecycle state only and must not invalidate the merged workflow.
    revision: input.binding.revision,
    stateVersion: input.binding.stateVersion + 1,
    attestedBindingRevision:
      input.status === "active" ? input.binding.revision : null,
    activatedAt: input.status === "active" ? input.now : null,
    drainingAt: input.status === "draining" ? input.now : null,
    updatedAt: input.now,
  };
}

export function isHostedAccountHealthy(
  account: HostedPoolAccount,
  now: Date,
): boolean {
  return (
    account.availability.status === "healthy" ||
    (account.availability.status === "cooldown" &&
      account.availability.until <= now)
  );
}

export function pauseHostedAccount(
  account: HostedPoolAccount,
  reason: string,
  now: Date,
): HostedPoolAccount {
  return changeAvailability(
    account,
    { status: "paused", reason: reasonValue(reason) },
    now,
  );
}

export function quarantineHostedAccount(
  account: HostedPoolAccount,
  reason: string,
  now: Date,
): HostedPoolAccount {
  return changeAvailability(
    account,
    { status: "quarantined", reason: reasonValue(reason) },
    now,
  );
}

export function coolDownHostedAccount(
  account: HostedPoolAccount,
  input: { readonly reason: string; readonly until: Date; readonly now: Date },
): HostedPoolAccount {
  if (input.until <= input.now)
    throw new Error("hosted_account_cooldown_invalid");
  return changeAvailability(
    account,
    {
      status: "cooldown",
      reason: reasonValue(input.reason),
      until: input.until,
    },
    input.now,
  );
}

export function resumeHostedAccount(
  account: HostedPoolAccount,
  now: Date,
): HostedPoolAccount {
  return changeAvailability(account, { status: "healthy" }, now);
}

export function normalizeExpiredHostedAccountCooldown(
  account: HostedPoolAccount,
  now: Date,
): HostedPoolAccount {
  if (
    account.availability.status !== "cooldown" ||
    account.availability.until > now
  ) {
    return account;
  }
  return changeAvailability(account, { status: "healthy" }, now);
}

function changeAvailability(
  account: HostedPoolAccount,
  availability: HostedAccountAvailability,
  now: Date,
): HostedPoolAccount {
  return {
    ...account,
    availability,
    healthVersion: account.healthVersion + 1,
    updatedAt: now,
  };
}

function reasonValue(reason: string): string {
  return z.string().trim().min(1).max(500).parse(reason);
}
