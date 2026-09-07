import type { HostedPoolRepositoryBinding } from "../../domain/account-pool";
import type {
  HostedBindingId,
  RepositoryId,
  WorkspaceId,
} from "../../domain/identifiers";
import type {
  HostedPoolBindingRepositoryPort,
  HostedPoolRepositoryPort,
} from "../ports/hosted-pool-repository-port";
import { ensureRepositoryUsesDefaultPool } from "./ensure-repository-uses-default-pool";

export type HostedPoolConnectDependencies = {
  readonly pools: HostedPoolRepositoryPort;
  readonly bindings: HostedPoolBindingRepositoryPort;
  /** Recheck membership, repository and App installation authority, including remote identity. */
  assertRepositoryAuthority(): Promise<void>;
  withRepositoryLock<T>(work: () => Promise<T>): Promise<T>;
  /** Existing canonical default-branch verifier + CAS activation; absent workflow is pending. */
  activateExact(
    binding: HostedPoolRepositoryBinding,
  ): Promise<"active" | "pending">;
  /** Reconcile the existing attempt/branch/PR before any retry. Never allocate a new attempt for a pending binding. */
  provisionOrResume(
    binding: HostedPoolRepositoryBinding,
  ): Promise<{ readonly pullRequestUrl: string | null }>;
};

export async function operatorConnectRepository(
  input: {
    readonly bindingId: HostedBindingId;
    readonly repositoryId: RepositoryId;
    readonly workspaceId: WorkspaceId;
    readonly expectedRevision: number | null;
    readonly now: Date;
  },
  dependencies: HostedPoolConnectDependencies,
) {
  await dependencies.assertRepositoryAuthority();
  return dependencies.withRepositoryLock(async () => {
    await dependencies.assertRepositoryAuthority();
    const ensured = await ensureRepositoryUsesDefaultPool(input, dependencies);
    const binding = ensured.binding;
    const guard = async () => {
      await dependencies.assertRepositoryAuthority();
      const current = await dependencies.bindings.findByRepositoryId(
        input.repositoryId,
      );
      if (
        !current ||
        current.bindingId !== binding.bindingId ||
        current.revision !== binding.revision ||
        current.stateVersion !== binding.stateVersion ||
        current.status !== binding.status ||
        current.poolId !== binding.poolId ||
        current.workspaceId !== input.workspaceId ||
        current.status === "draining"
      ) {
        throw new Error("hosted_pool_binding_conflict");
      }
    };
    if (ensured.status === "already_active")
      return {
        status: "already_active" as const,
        bindingId: binding.bindingId,
        bindingRevision: binding.revision,
      };
    await guard();
    const activation = await dependencies.activateExact(binding);
    if (activation === "active")
      return {
        status: "already_active" as const,
        bindingId: binding.bindingId,
        bindingRevision: binding.revision,
      };
    await guard();
    const setup = await dependencies.provisionOrResume(binding);
    await guard();
    return {
      status: setup.pullRequestUrl
        ? ("setup_pr_open" as const)
        : ("pending_activation" as const),
      bindingId: binding.bindingId,
      bindingRevision: binding.revision,
      setupPrUrl: setup.pullRequestUrl,
    };
  });
}
