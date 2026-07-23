import {
  ScmProvider,
  assertDate,
  assertIdentifier,
  assertNonNegativeInteger,
  cloneDate,
  invalid,
} from "./review-run-control-types";

export type ScmRepositoryExternalIdentity = {
  readonly provider: ScmProvider;
  readonly normalizedSourceBaseUrl: string;
  readonly externalRepositoryId: string;
};

export type ScmRepositoryIdentity = ScmRepositoryExternalIdentity & {
  readonly scmRepositoryIdentityId: string;
  readonly version: number;
  readonly currentWorkspaceId: string | null;
  readonly currentRepositoryConnectionId: string | null;
  readonly createdAt: Date;
  readonly boundAt: Date | null;
  readonly unboundAt: Date | null;
};

export function normalizeScmSourceBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return invalid("source_base_url_invalid");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    invalid("source_base_url_invalid");
  }
  parsed.hostname = parsed.hostname.toLowerCase();
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString().replace(/\/$/, "");
}

export function createScmRepositoryIdentity(input: {
  readonly scmRepositoryIdentityId: string;
  readonly provider: ScmProvider;
  readonly sourceBaseUrl: string;
  readonly externalRepositoryId: string;
  readonly createdAt: Date;
}): ScmRepositoryIdentity {
  assertIdentifier(input.scmRepositoryIdentityId, "scm_repository_identity_id");
  assertIdentifier(input.externalRepositoryId, "external_repository_id");
  assertDate(input.createdAt, "created_at");
  return {
    scmRepositoryIdentityId: input.scmRepositoryIdentityId,
    provider: input.provider,
    normalizedSourceBaseUrl: normalizeScmSourceBaseUrl(input.sourceBaseUrl),
    externalRepositoryId: input.externalRepositoryId,
    version: 1,
    currentWorkspaceId: null,
    currentRepositoryConnectionId: null,
    createdAt: cloneDate(input.createdAt),
    boundAt: null,
    unboundAt: null,
  };
}

export function bindScmRepositoryIdentity(
  identity: ScmRepositoryIdentity,
  input: {
    readonly expectedVersion: number;
    readonly workspaceId: string;
    readonly repositoryConnectionId: string;
    readonly boundAt: Date;
  },
): ScmRepositoryIdentity {
  assertNonNegativeInteger(input.expectedVersion, "expected_version");
  assertIdentifier(input.workspaceId, "workspace_id");
  assertIdentifier(input.repositoryConnectionId, "repository_connection_id");
  assertDate(input.boundAt, "bound_at");
  if (identity.version !== input.expectedVersion) {
    invalid("identity_version_conflict");
  }
  if (
    identity.currentWorkspaceId === input.workspaceId &&
    identity.currentRepositoryConnectionId === input.repositoryConnectionId
  ) {
    return cloneScmRepositoryIdentity(identity);
  }
  if (
    identity.currentWorkspaceId !== null ||
    identity.currentRepositoryConnectionId !== null
  ) {
    invalid("identity_binding_conflict");
  }
  return {
    ...identity,
    version: identity.version + 1,
    currentWorkspaceId: input.workspaceId,
    currentRepositoryConnectionId: input.repositoryConnectionId,
    boundAt: cloneDate(input.boundAt),
    unboundAt: null,
    createdAt: cloneDate(identity.createdAt),
  };
}

export function unbindScmRepositoryIdentity(
  identity: ScmRepositoryIdentity,
  input: { readonly expectedVersion: number; readonly unboundAt: Date },
): ScmRepositoryIdentity {
  assertNonNegativeInteger(input.expectedVersion, "expected_version");
  assertDate(input.unboundAt, "unbound_at");
  if (identity.version !== input.expectedVersion) {
    invalid("identity_version_conflict");
  }
  if (
    identity.currentWorkspaceId === null &&
    identity.currentRepositoryConnectionId === null
  ) {
    return cloneScmRepositoryIdentity(identity);
  }
  return {
    ...identity,
    version: identity.version + 1,
    currentWorkspaceId: null,
    currentRepositoryConnectionId: null,
    boundAt: identity.boundAt ? cloneDate(identity.boundAt) : null,
    unboundAt: cloneDate(input.unboundAt),
    createdAt: cloneDate(identity.createdAt),
  };
}

export function scmRepositoryExternalIdentityKey(
  identity: ScmRepositoryExternalIdentity,
): string {
  return [
    identity.provider,
    identity.normalizedSourceBaseUrl,
    identity.externalRepositoryId,
  ].join("\u0000");
}

export function cloneScmRepositoryIdentity(
  identity: ScmRepositoryIdentity,
): ScmRepositoryIdentity {
  return {
    ...identity,
    createdAt: cloneDate(identity.createdAt),
    boundAt: identity.boundAt ? cloneDate(identity.boundAt) : null,
    unboundAt: identity.unboundAt ? cloneDate(identity.unboundAt) : null,
  };
}
