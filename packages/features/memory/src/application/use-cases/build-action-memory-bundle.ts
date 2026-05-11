import {
  buildMemoryBundle,
  defaultMemoryBundlePolicy,
  type ActionMemoryBundle,
  type MemoryBundlePolicy,
} from "../../domain/memory-bundle-policy";
import type { MemoryUseCaseDependencies } from "./memory-use-case-types";

export type BuildActionMemoryBundleInput = {
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly userId: string | null;
  readonly policy?: Partial<MemoryBundlePolicy>;
};

export async function buildActionMemoryBundle(
  input: BuildActionMemoryBundleInput,
  dependencies: Pick<MemoryUseCaseDependencies, "memoryItems">,
): Promise<ActionMemoryBundle> {
  const policy = {
    ...defaultMemoryBundlePolicy,
    ...input.policy,
  };
  const items = await dependencies.memoryItems.listActiveForBundle({
    workspaceId: input.workspaceId,
    repositoryId: input.repositoryId,
    userId: input.userId,
    limit: policy.maxItems * 3,
  });
  return buildMemoryBundle(items, policy);
}
