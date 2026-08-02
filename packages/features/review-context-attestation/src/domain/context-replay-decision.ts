import {
  canonicalContextDependencyOperation,
  canonicalContextDependencyResult,
  createContextDependencyManifest,
  type ContextDependencyManifest,
} from "./context-dependency-manifest";
import {
  ContextGatewayV4OperationKind,
  ContextGatewayV4OutcomeKind,
  createContextGatewayV4Manifest,
  type ContextGatewayV4Event,
  type ContextGatewayV4Manifest,
} from "./context-gateway-v4-manifest";

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
  ReceiptSelectionInvalid = "receipt_selection_invalid",
  ManifestVersionMismatch = "manifest_version_mismatch",
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

export function decideContextGatewayV4Replay(
  sourceCandidate: ContextGatewayV4Manifest,
  targetCandidate: ContextGatewayV4Manifest,
  sourceOperationReceiptIds: readonly string[],
): ContextDependencyReplayDecision {
  const source = createContextGatewayV4Manifest(sourceCandidate);
  const target = createContextGatewayV4Manifest(targetCandidate);
  if (source.gatewayPolicyVersion !== target.gatewayPolicyVersion) {
    return denied(ContextDependencyReplayDenialReason.GatewayPolicyMismatch);
  }
  if (source.gatewayBinaryHash !== target.gatewayBinaryHash) {
    return denied(ContextDependencyReplayDenialReason.GatewayBinaryMismatch);
  }
  const selected = normalizeReceiptSelection(sourceOperationReceiptIds);
  if (selected === null) {
    return denied(ContextDependencyReplayDenialReason.ReceiptSelectionInvalid);
  }
  const sourceEvents = selectedSourceEvents(source.events, selected);
  if (sourceEvents === null) {
    return denied(ContextDependencyReplayDenialReason.ReceiptSelectionInvalid);
  }
  const targetEvents = target.events.filter(
    (event) => event.outcome === ContextGatewayV4OutcomeKind.Succeeded,
  );
  if (sourceEvents.length !== targetEvents.length) {
    return denied(ContextDependencyReplayDenialReason.DependencySetMismatch);
  }
  for (let index = 0; index < sourceEvents.length; index += 1) {
    const sourceEvent = sourceEvents[index]!;
    const targetEvent = targetEvents[index]!;
    if (sourceEvent.operationKind !== targetEvent.operationKind) {
      return denied(
        ContextDependencyReplayDenialReason.OperationMismatch,
        sourceEvent.operationKey,
      );
    }
    if (
      stableJson(v4ComparableResult(sourceEvent)) !==
      stableJson(v4ComparableResult(targetEvent))
    ) {
      return denied(
        ContextDependencyReplayDenialReason.ResultMismatch,
        sourceEvent.operationKey,
      );
    }
  }
  return Object.freeze({
    status: ContextDependencyReplayStatus.Matched,
    reason: ContextDependencyReplayDenialReason.None,
    mismatchedOperationKey: null,
  });
}

function normalizeReceiptSelection(
  values: readonly string[],
): ReadonlySet<string> | null {
  if (!Array.isArray(values) || values.length === 0) return null;
  const selected = new Set<string>();
  for (const value of values) {
    if (!/^[a-f0-9]{64}$/.test(value) || selected.has(value)) return null;
    selected.add(value);
  }
  return selected;
}

function selectedSourceEvents(
  events: readonly ContextGatewayV4Event[],
  selectedReceiptIds: ReadonlySet<string>,
): readonly ContextGatewayV4Event[] | null {
  const successful = events.filter(
    (event): event is ContextGatewayV4Event & { operationReceiptId: string } =>
      event.outcome === ContextGatewayV4OutcomeKind.Succeeded &&
      event.operationReceiptId !== null,
  );
  const byReceipt = new Map(
    successful.map((event) => [event.operationReceiptId, event]),
  );
  if ([...selectedReceiptIds].some((receiptId) => !byReceipt.has(receiptId))) {
    return null;
  }
  const selectedGroups = new Set(
    [...selectedReceiptIds].map((receiptId) =>
      v4ReplayGroupKey(byReceipt.get(receiptId)!),
    ),
  );
  return successful.filter((event) =>
    selectedGroups.has(v4ReplayGroupKey(event)),
  );
}

function v4ReplayGroupKey(event: ContextGatewayV4Event): string {
  const result = event.result;
  if (result === null) return `failed:${event.sequence}`;
  switch (event.operationKind) {
    case ContextGatewayV4OperationKind.FileRead:
      return stableJson({
        kind: event.operationKind,
        pathHash: result.pathHash,
        revision: result.revision,
      });
    case ContextGatewayV4OperationKind.DirectoryList:
    case ContextGatewayV4OperationKind.TextSearch:
    case ContextGatewayV4OperationKind.CanonicalInventory:
      return stableJson({
        kind: event.operationKind,
        queryDigest: result.queryDigest,
      });
    case ContextGatewayV4OperationKind.GitFact:
      return stableJson({ kind: event.operationKind, fact: result.fact });
    case ContextGatewayV4OperationKind.UnsupportedTool:
      return `unsupported:${event.sequence}`;
  }
}

function v4ComparableResult(
  event: ContextGatewayV4Event,
): Readonly<Record<string, unknown>> | null {
  const result = event.result;
  if (result === null) return null;
  switch (event.operationKind) {
    case ContextGatewayV4OperationKind.FileRead: {
      const { treeOid, ...comparable } = result;
      void treeOid;
      return comparable;
    }
    case ContextGatewayV4OperationKind.DirectoryList:
    case ContextGatewayV4OperationKind.TextSearch:
    case ContextGatewayV4OperationKind.CanonicalInventory: {
      const { treeOid, queryDigest, nextCursorHash, ...comparable } = result;
      void treeOid;
      void queryDigest;
      void nextCursorHash;
      return comparable;
    }
    case ContextGatewayV4OperationKind.GitFact:
      return result;
    case ContextGatewayV4OperationKind.UnsupportedTool:
      return null;
  }
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

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
