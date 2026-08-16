import type { RepositoryId, WorkspaceId } from "../../domain/identifiers";
import type { HostedPoolBindingRepositoryPort } from "../ports/hosted-pool-repository-port";
import type { RepositoryAuthModeSwitchPort } from "../ports/repository-auth-mode-switch-port";

export async function switchRepositoryToRepositoryOwnedRotating(
  input: {
    readonly repositoryId: RepositoryId;
    readonly workspaceId: WorkspaceId;
    readonly expectedBindingRevision: number;
    readonly now: Date;
  },
  dependencies: {
    readonly bindings: HostedPoolBindingRepositoryPort;
    readonly authModeSwitch: RepositoryAuthModeSwitchPort;
  },
): Promise<{
  readonly authMode: "codex_subscription_oauth_rotating";
  readonly revision: number;
}> {
  const binding = await dependencies.bindings.findByRepositoryId(
    input.repositoryId,
  );
  if (
    !binding ||
    binding.workspaceId !== input.workspaceId ||
    binding.revision !== input.expectedBindingRevision
  ) {
    throw new Error("hosted_pool_binding_revision_conflict");
  }
  const nextBindingRevision = binding.revision + 1;
  const switched =
    await dependencies.authModeSwitch.switchToRepositoryOwnedRotating({
      repositoryId: input.repositoryId,
      workspaceId: input.workspaceId,
      expectedBindingRevision: input.expectedBindingRevision,
      nextBindingRevision,
      switchedAt: input.now,
    });
  if (!switched) throw new Error("hosted_pool_binding_revision_conflict");
  return {
    authMode: "codex_subscription_oauth_rotating",
    revision: nextBindingRevision,
  };
}
