import {
  assertWorkspaceAdminAllowed,
  type AssertWorkspaceAdminAllowedInput,
  type WorkspaceAccessRepositoryPort,
} from "@reviewrouter/features-auth";
import {
  ProviderAccountError,
  assertExecutable,
  assertExpectedRevision,
  assertOpaqueReference,
  assertWorkspaceOwner,
  assertWorkspaceUseOwner,
  selectBinding,
  type BindingScope,
  type SafeBindingTuple,
  type WorkspaceAccountBinding,
} from "../../domain/provider-account";
import type {
  ProviderAccountRepositoryPort,
  OperatorAccountGrantRepositoryPort,
} from "../ports/provider-account-repository-port";

export type WorkspaceAccountActor = Pick<
  AssertWorkspaceAdminAllowedInput,
  "userId" | "githubUserId" | "githubLogin"
>;
export type ProviderAccountDependencies = {
  readonly accounts: ProviderAccountRepositoryPort;
  readonly workspaceAccess: WorkspaceAccessRepositoryPort;
  // Trusted composition config, never a caller-controlled permission input.
  readonly localAdminGithubLogins?: readonly string[];
  readonly operatorWorkspaceId?: string;
  readonly operatorGrants?: OperatorAccountGrantRepositoryPort;
};

function assertActor(actor: WorkspaceAccountActor): void {
  if (actor.userId !== undefined) assertOpaqueReference(actor.userId);
  if (
    typeof actor.githubUserId !== "string" ||
    typeof actor.githubLogin !== "string" ||
    (actor.userId === undefined && !/^[0-9]+$/.test(actor.githubUserId))
  ) {
    throw new ProviderAccountError("invalid_input");
  }
}

type MutationInput = BindingScope & {
  readonly actor: WorkspaceAccountActor;
  readonly expectedRevision: number;
};

// Capture only primitive authority fields before validation or any live read.
// The nested actor must not retain a caller-owned reference across awaits.
function snapshotMutation(input: MutationInput): MutationInput {
  return {
    workspaceId: input.workspaceId,
    connectionId: input.connectionId,
    expectedRevision: input.expectedRevision,
    actor: {
      userId: input.actor.userId,
      githubUserId: input.actor.githubUserId,
      githubLogin: input.actor.githubLogin,
    },
  };
}

async function assertAdmin(
  workspaceId: string,
  actor: WorkspaceAccountActor,
  dependencies: ProviderAccountDependencies,
): Promise<void> {
  try {
    await assertWorkspaceAdminAllowed(
      {
        workspaceId,
        userId: actor.userId,
        githubUserId: actor.githubUserId,
        githubLogin: actor.githubLogin,
        ...(dependencies.localAdminGithubLogins
          ? { localAdminGithubLogins: dependencies.localAdminGithubLogins }
          : {}),
      },
      { workspaceAccess: dependencies.workspaceAccess },
    );
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("workspace_admin_forbidden:")
    ) {
      throw new ProviderAccountError("workspace_forbidden");
    }
    throw error;
  }
}

async function changeBinding(
  input: MutationInput,
  dependencies: ProviderAccountDependencies,
  state: "active" | "revoked",
): Promise<WorkspaceAccountBinding> {
  assertActor(input.actor);
  assertOpaqueReference(input.workspaceId);
  assertOpaqueReference(input.connectionId);
  assertExpectedRevision(input.expectedRevision, state === "active");
  // Always query live auth at the application boundary; no cached role/paid-pool grant.
  await assertAdmin(input.workspaceId, input.actor, dependencies);
  const ownerWorkspaceId =
    state === "revoked" && dependencies.operatorWorkspaceId
      ? dependencies.operatorWorkspaceId
      : input.workspaceId;
  const owned = await dependencies.accounts.findOwnedConnection(input);
  const connection =
    owned ??
    (state === "revoked"
      ? await dependencies.accounts.findOwnedConnection({
          ...input,
          workspaceId: ownerWorkspaceId,
        })
      : null);
  if (state === "active") assertWorkspaceOwner(connection, input.workspaceId);
  else
    assertWorkspaceUseOwner(
      connection,
      input.workspaceId,
      dependencies.operatorWorkspaceId,
    );
  if (state === "active") assertExecutable(connection);
  return dependencies.accounts.compareAndSetBinding({
    workspaceId: input.workspaceId,
    connectionId: input.connectionId,
    expectedRevision: input.expectedRevision,
    state,
  });
}
/** Explicit operator grant/revoke. Recipient authority can only detach existing use. */
export async function changeOperatorWorkspaceAccountGrant(
  request: MutationInput & { readonly state: "active" | "revoked" },
  dependencies: ProviderAccountDependencies,
): Promise<WorkspaceAccountBinding> {
  const input = { ...snapshotMutation(request), state: request.state };
  assertActor(input.actor);
  assertOpaqueReference(input.workspaceId);
  assertOpaqueReference(input.connectionId);
  assertExpectedRevision(input.expectedRevision, input.state === "active");
  if (input.state !== "active" && input.state !== "revoked")
    throw new ProviderAccountError("invalid_input");
  const operatorWorkspaceId = dependencies.operatorWorkspaceId;
  if (!operatorWorkspaceId || !dependencies.operatorGrants)
    throw new ProviderAccountError("workspace_forbidden");
  assertOpaqueReference(operatorWorkspaceId);
  // Deliberately exclude local login overrides: real live membership is required.
  await assertAdmin(operatorWorkspaceId, input.actor, {
    accounts: dependencies.accounts,
    workspaceAccess: dependencies.workspaceAccess,
  });
  return dependencies.operatorGrants.compareAndSetOperatorBinding(input);
}
export function bindWorkspaceAccount(
  input: MutationInput,
  dependencies: ProviderAccountDependencies,
): Promise<WorkspaceAccountBinding> {
  return changeBinding(snapshotMutation(input), dependencies, "active");
}
/** Local denial and durable intent only; delivery is a separate trusted backend seam. */
export async function revokeWorkspaceAccountBinding(
  input: MutationInput,
  dependencies: ProviderAccountDependencies,
): Promise<
  WorkspaceAccountBinding & {
    readonly localAuthorization: "local_denied";
    readonly remoteFenceDelivery: "remote_pending";
  }
> {
  const binding = await changeBinding(
    snapshotMutation(input),
    dependencies,
    "revoked",
  );
  return {
    ...binding,
    localAuthorization: "local_denied",
    remoteFenceDelivery: "remote_pending",
  };
}
export async function resolveWorkspaceAccountBinding(
  request: {
    readonly workspaceId: string;
    readonly bindingId: string;
    readonly actor: WorkspaceAccountActor;
  },
  dependencies: ProviderAccountDependencies,
): Promise<SafeBindingTuple> {
  const input = {
    workspaceId: request.workspaceId,
    bindingId: request.bindingId,
    actor: {
      userId: request.actor.userId,
      githubUserId: request.actor.githubUserId,
      githubLogin: request.actor.githubLogin,
    },
  };
  assertActor(input.actor);
  assertOpaqueReference(input.workspaceId);
  assertOpaqueReference(input.bindingId);
  const role = input.actor.userId
    ? await dependencies.workspaceAccess.findWorkspaceRoleByUserId({
        workspaceId: input.workspaceId,
        userId: input.actor.userId,
      })
    : await dependencies.workspaceAccess.findWorkspaceRoleByGitHubUserId({
        workspaceId: input.workspaceId,
        githubUserId: input.actor.githubUserId,
      });
  // Members may read/select in their current workspace; missing membership must
  // pass the existing explicit local override seam. No login-role fallback.
  if (!role) await assertAdmin(input.workspaceId, input.actor, dependencies);
  const selection = await dependencies.accounts.findBinding({
    workspaceId: input.workspaceId,
    bindingId: input.bindingId,
  });
  return selectBinding(
    input.workspaceId,
    input.bindingId,
    selection,
    dependencies.operatorWorkspaceId,
  );
}
