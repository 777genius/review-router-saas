import type { MemoryPolicyConfig } from "../ports/memory-policy-config-port";
import type { MemoryScope } from "../../domain/memory-scope-policy";
import type {
  MemoryMutationResult,
  MemoryUseCaseDependencies,
} from "./memory-use-case-types";

export type MemoryWritePolicyInput = {
  readonly workspaceId: string;
  readonly repositoryId: string | null;
  readonly scope: MemoryScope;
};

export type MemoryWritePolicyResult =
  | {
      readonly allowed: true;
      readonly policy: MemoryPolicyConfig;
    }
  | {
      readonly allowed: false;
      readonly rejection: Extract<MemoryMutationResult, { status: "rejected" }>;
    };

export async function evaluateMemoryWritePolicy(
  input: MemoryWritePolicyInput,
  dependencies: Pick<MemoryUseCaseDependencies, "memoryPolicyConfig">,
): Promise<MemoryWritePolicyResult> {
  const policy = await dependencies.memoryPolicyConfig.getPolicy({
    workspaceId: input.workspaceId,
    repositoryId: input.repositoryId,
  });
  if (!policy.memoryEnabled) {
    return {
      allowed: false,
      rejection: {
        status: "rejected",
        reason: "memory_disabled",
        retryable: false,
      },
    };
  }
  if (!policy.allowedScopes[input.scope]) {
    return {
      allowed: false,
      rejection: {
        status: "rejected",
        reason: "memory_scope_forbidden",
        retryable: false,
      },
    };
  }
  return { allowed: true, policy };
}
