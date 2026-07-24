import {
  canonicalContextDependencyOperation,
  canonicalContextDependencyResult,
  createContextDependencyManifest,
  type ContextDependencyManifest,
} from "./context-dependency-manifest";

export enum ContextDependencyReplayStatus {
  Matched = "matched",
  Denied = "denied",
}

export enum ContextDependencyReplayDenialReason {
  None = "none",
  GatewayPolicyMismatch = "gateway_policy_mismatch",
  GatewayBinaryMismatch = "gateway_binary_mismatch",
  DependencySetMismatch = "dependency_set_mismatch",
  OperationMismatch = "operation_mismatch",
  ResultMismatch = "result_mismatch",
}

export type ContextDependencyReplayDecision = Readonly<{
  status: ContextDependencyReplayStatus;
  reason: ContextDependencyReplayDenialReason;
  mismatchedOperationKey: string | null;
}>;

export function decideContextDependencyReplay(
  sourceCandidate: ContextDependencyManifest,
  targetCandidate: ContextDependencyManifest,
): ContextDependencyReplayDecision {
  const source = createContextDependencyManifest(sourceCandidate);
  const target = createContextDependencyManifest(targetCandidate);
  if (source.gatewayPolicyVersion !== target.gatewayPolicyVersion) {
    return denied(ContextDependencyReplayDenialReason.GatewayPolicyMismatch);
  }
  if (source.gatewayBinaryHash !== target.gatewayBinaryHash) {
    return denied(ContextDependencyReplayDenialReason.GatewayBinaryMismatch);
  }
  if (source.dependencies.length !== target.dependencies.length) {
    return denied(ContextDependencyReplayDenialReason.DependencySetMismatch);
  }

  for (let index = 0; index < source.dependencies.length; index += 1) {
    const sourceDependency = source.dependencies[index];
    const targetDependency = target.dependencies[index];
    if (!sourceDependency || !targetDependency) {
      return denied(ContextDependencyReplayDenialReason.DependencySetMismatch);
    }
    if (
      sourceDependency.operationKey !== targetDependency.operationKey ||
      canonicalContextDependencyOperation(sourceDependency.operation) !==
        canonicalContextDependencyOperation(targetDependency.operation)
    ) {
      return denied(
        ContextDependencyReplayDenialReason.OperationMismatch,
        sourceDependency.operationKey,
      );
    }
    if (
      canonicalContextDependencyResult(sourceDependency.result) !==
      canonicalContextDependencyResult(targetDependency.result)
    ) {
      return denied(
        ContextDependencyReplayDenialReason.ResultMismatch,
        sourceDependency.operationKey,
      );
    }
  }
  return Object.freeze({
    status: ContextDependencyReplayStatus.Matched,
    reason: ContextDependencyReplayDenialReason.None,
    mismatchedOperationKey: null,
  });
}

function denied(
  reason: ContextDependencyReplayDenialReason,
  mismatchedOperationKey: string | null = null,
): ContextDependencyReplayDecision {
  return Object.freeze({
    status: ContextDependencyReplayStatus.Denied,
    reason,
    mismatchedOperationKey,
  });
}
