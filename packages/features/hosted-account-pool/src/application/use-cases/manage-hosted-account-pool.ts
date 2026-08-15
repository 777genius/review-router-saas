import {
  bindRepositoryToHostedPool,
  coolDownHostedAccount,
  createDefaultHostedAccountPool,
  pauseHostedAccount,
  quarantineHostedAccount,
  replaceHostedAccountCredential,
  resumeHostedAccount,
  type CredentialMetadata,
  type HostedAccountAvailability,
  type HostedAccountPool,
  type HostedPoolAccount,
  type HostedPoolRepositoryBinding,
} from "../../domain/account-pool";
import type {
  HostedAccountId,
  HostedBindingId,
  HostedPoolId,
  RepositoryId,
  WorkspaceId,
} from "../../domain/identifiers";
import type { HostedAccountRepositoryPort } from "../ports/hosted-account-repository-port";
import type {
  HostedPoolBindingRepositoryPort,
  HostedPoolRepositoryPort,
} from "../ports/hosted-pool-repository-port";

export async function createWorkspaceDefaultPool(
  input: {
    readonly id: HostedPoolId;
    readonly workspaceId: WorkspaceId;
    readonly now: Date;
  },
  pools: HostedPoolRepositoryPort,
): Promise<HostedAccountPool> {
  const existing = await pools.findDefaultByWorkspaceId(input.workspaceId);
  if (existing) return existing;
  return pools.insertDefault(createDefaultHostedAccountPool(input));
}

export async function replaceAccountCredentialMetadata(
  input: {
    readonly accountId: HostedAccountId;
    readonly expectedAuthGeneration: number;
    readonly credential: CredentialMetadata;
    readonly now: Date;
  },
  accounts: HostedAccountRepositoryPort,
): Promise<HostedPoolAccount> {
  const current = await accounts.findById(input.accountId);
  if (!current) throw new Error("hosted_account_not_found");
  const replacement = replaceHostedAccountCredential({
    account: current,
    expectedAuthGeneration: input.expectedAuthGeneration,
    credential: input.credential,
    now: input.now,
  });
  if (
    !(await accounts.replaceCredential({
      account: replacement,
      expectedAuthGeneration: input.expectedAuthGeneration,
    }))
  ) {
    throw new Error("hosted_account_auth_generation_conflict");
  }
  return replacement;
}

export async function bindRepositoryToDefaultPool(
  input: {
    readonly bindingId: HostedBindingId;
    readonly repositoryId: RepositoryId;
    readonly workspaceId: WorkspaceId;
    readonly expectedRevision: number | null;
    readonly now: Date;
  },
  dependencies: {
    readonly pools: HostedPoolRepositoryPort;
    readonly bindings: HostedPoolBindingRepositoryPort;
  },
): Promise<HostedPoolRepositoryBinding> {
  const pool = await dependencies.pools.findDefaultByWorkspaceId(
    input.workspaceId,
  );
  if (!pool) throw new Error("hosted_default_pool_not_found");
  const currentBinding = await dependencies.bindings.findByRepositoryId(
    input.repositoryId,
  );
  if ((currentBinding?.revision ?? null) !== input.expectedRevision) {
    throw new Error("hosted_pool_binding_revision_conflict");
  }
  const binding = bindRepositoryToHostedPool({
    id: input.bindingId,
    ...input,
    pool,
    currentBinding,
  });
  if (
    !(await dependencies.bindings.save({
      binding,
      expectedRevision: input.expectedRevision,
      expectedStateVersion: currentBinding?.stateVersion ?? null,
    }))
  ) {
    throw new Error("hosted_pool_binding_revision_conflict");
  }
  return binding;
}

export async function setHostedAccountAvailability(
  input: {
    readonly accountId: HostedAccountId;
    readonly expectedHealthVersion: number;
    readonly availability:
      | { readonly status: "healthy" }
      | { readonly status: "paused"; readonly reason: string }
      | { readonly status: "quarantined"; readonly reason: string }
      | {
          readonly status: "cooldown";
          readonly reason: string;
          readonly until: Date;
        };
    readonly now: Date;
  },
  accounts: HostedAccountRepositoryPort,
): Promise<HostedPoolAccount> {
  const current = await accounts.findById(input.accountId);
  if (!current) throw new Error("hosted_account_not_found");
  if (current.healthVersion !== input.expectedHealthVersion) {
    throw new Error("hosted_account_health_version_conflict");
  }
  const updated = transitionAvailability(
    current,
    input.availability,
    input.now,
  );
  if (
    !(await accounts.saveAvailability({
      account: updated,
      expectedHealthVersion: input.expectedHealthVersion,
    }))
  ) {
    throw new Error("hosted_account_health_version_conflict");
  }
  return updated;
}

function transitionAvailability(
  account: HostedPoolAccount,
  availability: HostedAccountAvailability,
  now: Date,
): HostedPoolAccount {
  switch (availability.status) {
    case "healthy":
      return resumeHostedAccount(account, now);
    case "paused":
      return pauseHostedAccount(account, availability.reason, now);
    case "quarantined":
      return quarantineHostedAccount(account, availability.reason, now);
    case "cooldown":
      return coolDownHostedAccount(account, { ...availability, now });
  }
}
