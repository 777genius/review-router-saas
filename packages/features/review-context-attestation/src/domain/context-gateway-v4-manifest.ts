const encoder = new TextEncoder();

export const contextGatewayV4ManifestVersion = 3 as const;
export const contextGatewayV4PolicyVersion = "context-gateway-v4" as const;
export const contextGatewayV4ManifestMaxEvents = 2_000;
export const contextGatewayV4ManifestMaxBytes = 4 * 1024 * 1024;

export enum ContextGatewayV4OutcomeKind {
  Succeeded = "succeeded",
  Rejected = "rejected",
  Failed = "failed",
}

export enum ContextGatewayV4FailureClass {
  RecoverableRequest = "recoverable_request",
  IncompleteResult = "incomplete_result",
  ConfinementViolation = "confinement_violation",
  InfrastructureFailure = "infrastructure_failure",
  BudgetExceeded = "budget_exceeded",
}

export enum ContextGatewayV4OperationKind {
  FileRead = "file_read",
  DirectoryList = "directory_list",
  TextSearch = "text_search",
  CanonicalInventory = "canonical_inventory",
  GitFact = "git_fact",
  UnsupportedTool = "unsupported_tool",
}

export enum ContextGatewayV4ValidationIssue {
  EventChainInvalid = "context_gateway_v4_event_chain_invalid",
  EventCountInvalid = "context_gateway_v4_event_count_invalid",
  EventKindInvalid = "context_gateway_v4_event_kind_invalid",
  FailureClassInvalid = "context_gateway_v4_failure_class_invalid",
  FileCompletionInvalid = "context_gateway_v4_file_completion_invalid",
  FileContentKindInvalid = "context_gateway_v4_file_content_kind_invalid",
  FileContentMetadataIncomplete = "context_gateway_v4_file_content_metadata_incomplete",
  FileIdentityMismatch = "context_gateway_v4_file_identity_mismatch",
  FileLineCountInvalid = "context_gateway_v4_file_line_count_invalid",
  FileRangeGap = "context_gateway_v4_file_range_gap",
  FileRangeIncomplete = "context_gateway_v4_file_range_incomplete",
  FileResultShapeInvalid = "context_gateway_v4_file_result_shape_invalid",
  GitFactInvalid = "context_gateway_v4_git_fact_invalid",
  GitFactResultShapeInvalid = "context_gateway_v4_git_fact_result_shape_invalid",
  GitFactResultInvalid = "context_gateway_v4_git_fact_result_invalid",
  ManifestNotAcceptable = "context_gateway_v4_manifest_not_acceptable",
  ManifestTooLarge = "context_gateway_v4_manifest_too_large",
  ManifestVersionUnsupported = "context_gateway_v4_manifest_version_unsupported",
  OutcomeShapeInvalid = "context_gateway_v4_outcome_shape_invalid",
  OperationShapeInvalid = "context_gateway_v4_operation_shape_invalid",
  PageChainIncomplete = "context_gateway_v4_page_chain_incomplete",
  PageChainInvalid = "context_gateway_v4_page_chain_invalid",
  PageCompletionInvalid = "context_gateway_v4_page_completion_invalid",
  PagePathChainInvalid = "context_gateway_v4_page_path_chain_invalid",
  PageResultShapeInvalid = "context_gateway_v4_page_result_shape_invalid",
  ReasonInvalid = "context_gateway_v4_reason_invalid",
  ResultMissing = "context_gateway_v4_result_missing",
  SequenceInvalid = "context_gateway_v4_sequence_invalid",
  TerminalFailurePresent = "context_gateway_v4_terminal_failure_present",
  TerminalHashInvalid = "context_gateway_v4_terminal_hash_invalid",
  UnsupportedToolSucceeded = "context_gateway_v4_unsupported_tool_succeeded",
}

const contextGatewayV4ValidationIssues = new Set<string>(
  Object.values(ContextGatewayV4ValidationIssue),
);

export function isContextGatewayV4ValidationIssue(
  value: unknown,
): value is ContextGatewayV4ValidationIssue {
  return (
    typeof value === "string" && contextGatewayV4ValidationIssues.has(value)
  );
}

export type ContextGatewayV4Event = Readonly<{
  sequence: number;
  previousEventHash: string;
  eventHash: string;
  operationKey: string;
  operationKind: ContextGatewayV4OperationKind;
  outcome: ContextGatewayV4OutcomeKind;
  failureClass: ContextGatewayV4FailureClass | null;
  operation: Readonly<Record<string, unknown>> & {
    readonly kind: ContextGatewayV4OperationKind;
  };
  result: Readonly<Record<string, unknown>> | null;
  operationReceiptId: string | null;
  sanitizedReason: string | null;
}>;

export type ContextGatewayV4Manifest = Readonly<{
  manifestVersion: typeof contextGatewayV4ManifestVersion;
  gatewayPolicyVersion: typeof contextGatewayV4PolicyVersion;
  gatewayBinaryHash: string;
  checkoutTreeOid: string;
  eventChainSeedHash: string;
  authenticatedChainHash: string;
  complete: true;
  confinementTainted: false;
  terminalFailureClass: null;
  events: readonly ContextGatewayV4Event[];
}>;

export function createContextGatewayV4Manifest(
  candidate: Readonly<{
    manifestVersion: number;
    gatewayPolicyVersion: string;
    gatewayBinaryHash: string;
    checkoutTreeOid: string;
    eventChainSeedHash: string;
    authenticatedChainHash: string;
    complete: boolean;
    confinementTainted: boolean;
    terminalFailureClass: ContextGatewayV4FailureClass | null;
    events: readonly ContextGatewayV4Event[];
  }>,
): ContextGatewayV4Manifest {
  if (
    candidate.manifestVersion !== contextGatewayV4ManifestVersion ||
    candidate.gatewayPolicyVersion !== contextGatewayV4PolicyVersion
  ) {
    throw new Error(ContextGatewayV4ValidationIssue.ManifestVersionUnsupported);
  }
  assertSha256(candidate.gatewayBinaryHash, "gateway_binary_hash");
  assertGitOid(candidate.checkoutTreeOid, "checkout_tree_oid");
  assertSha256(candidate.eventChainSeedHash, "event_chain_seed_hash");
  assertSha256(candidate.authenticatedChainHash, "authenticated_chain_hash");
  if (
    candidate.complete !== true ||
    candidate.confinementTainted !== false ||
    candidate.terminalFailureClass !== null
  ) {
    throw new Error(ContextGatewayV4ValidationIssue.ManifestNotAcceptable);
  }
  if (
    !Array.isArray(candidate.events) ||
    candidate.events.length < 1 ||
    candidate.events.length > contextGatewayV4ManifestMaxEvents
  ) {
    throw new Error(ContextGatewayV4ValidationIssue.EventCountInvalid);
  }
  const events = candidate.events.map((event, index) =>
    normalizeEvent(event, index + 1),
  );
  assertEventChain(events, candidate.eventChainSeedHash);
  if (events.at(-1)?.eventHash !== candidate.authenticatedChainHash) {
    throw new Error(ContextGatewayV4ValidationIssue.TerminalHashInvalid);
  }
  assertSuccessfulEvidenceConsistency(events);
  const manifest = Object.freeze({
    manifestVersion: contextGatewayV4ManifestVersion,
    gatewayPolicyVersion: contextGatewayV4PolicyVersion,
    gatewayBinaryHash: candidate.gatewayBinaryHash,
    checkoutTreeOid: candidate.checkoutTreeOid,
    eventChainSeedHash: candidate.eventChainSeedHash,
    authenticatedChainHash: candidate.authenticatedChainHash,
    complete: true as const,
    confinementTainted: false as const,
    terminalFailureClass: null,
    events: Object.freeze(events),
  });
  if (
    canonicalContextGatewayV4ManifestBytes(manifest).byteLength >
    contextGatewayV4ManifestMaxBytes
  ) {
    throw new Error(ContextGatewayV4ValidationIssue.ManifestTooLarge);
  }
  return manifest;
}

export function canonicalContextGatewayV4Manifest(
  manifest: ContextGatewayV4Manifest,
): string {
  return stableJson(toCanonicalValue(createContextGatewayV4Manifest(manifest)));
}

export function canonicalContextGatewayV4ManifestBytes(
  manifest: ContextGatewayV4Manifest,
): Uint8Array {
  return encoder.encode(stableJson(toCanonicalValue(manifest)));
}

export function successfulContextGatewayV4Receipts(
  manifest: ContextGatewayV4Manifest,
): readonly Readonly<{
  operationKind: ContextGatewayV4OperationKind;
  operationReceiptId: string;
  operationKey: string;
}>[] {
  return createContextGatewayV4Manifest(manifest)
    .events.filter(
      (
        event,
      ): event is ContextGatewayV4Event & { operationReceiptId: string } =>
        event.outcome === ContextGatewayV4OutcomeKind.Succeeded &&
        event.operationReceiptId !== null,
    )
    .map((event) =>
      Object.freeze({
        operationKind: event.operationKind,
        operationReceiptId: event.operationReceiptId,
        operationKey: event.operationKey,
      }),
    );
}

function normalizeEvent(
  event: ContextGatewayV4Event,
  expectedSequence: number,
): ContextGatewayV4Event {
  if (event.sequence !== expectedSequence) {
    throw new Error(ContextGatewayV4ValidationIssue.SequenceInvalid);
  }
  assertSha256(event.previousEventHash, "previous_event_hash");
  assertSha256(event.eventHash, "event_hash");
  assertSha256(event.operationKey, "operation_key");
  if (
    !Object.values(ContextGatewayV4OperationKind).includes(
      event.operationKind,
    ) ||
    !Object.values(ContextGatewayV4OutcomeKind).includes(event.outcome) ||
    event.operation?.kind !== event.operationKind
  ) {
    throw new Error(ContextGatewayV4ValidationIssue.EventKindInvalid);
  }
  const operation = normalizeOperation(event.operation);
  const succeeded = event.outcome === ContextGatewayV4OutcomeKind.Succeeded;
  if (
    succeeded
      ? event.failureClass !== null ||
        event.result === null ||
        event.operationReceiptId === null ||
        event.sanitizedReason !== null
      : event.failureClass === null ||
        event.result !== null ||
        event.operationReceiptId !== null ||
        event.sanitizedReason === null
  ) {
    throw new Error(ContextGatewayV4ValidationIssue.OutcomeShapeInvalid);
  }
  if (event.operationReceiptId !== null) {
    assertSha256(event.operationReceiptId, "operation_receipt_id");
  }
  if (
    event.sanitizedReason !== null &&
    !/^[a-z0-9_]{1,160}$/.test(event.sanitizedReason)
  ) {
    throw new Error(ContextGatewayV4ValidationIssue.ReasonInvalid);
  }
  if (
    event.failureClass !== null &&
    !Object.values(ContextGatewayV4FailureClass).includes(event.failureClass)
  ) {
    throw new Error(ContextGatewayV4ValidationIssue.FailureClassInvalid);
  }
  if (
    event.failureClass === ContextGatewayV4FailureClass.ConfinementViolation ||
    event.failureClass === ContextGatewayV4FailureClass.InfrastructureFailure
  ) {
    throw new Error(ContextGatewayV4ValidationIssue.TerminalFailurePresent);
  }
  const result = event.result === null ? null : normalizeResult(event);
  return Object.freeze({
    ...event,
    operation,
    result,
  });
}

function normalizeOperation(
  operation: ContextGatewayV4Event["operation"],
): ContextGatewayV4Event["operation"] {
  const expectedKeys =
    operation.kind === ContextGatewayV4OperationKind.GitFact
      ? ["fact", "kind"]
      : operation.kind === ContextGatewayV4OperationKind.UnsupportedTool
        ? ["kind", "requestedToolHash"]
        : ["inputHash", "kind"];
  assertExactKeys(operation, expectedKeys, "operation");
  const hashField =
    operation.kind === ContextGatewayV4OperationKind.UnsupportedTool
      ? operation.requestedToolHash
      : operation.kind === ContextGatewayV4OperationKind.GitFact
        ? null
        : operation.inputHash;
  if (hashField !== null) assertSha256(hashField, "operation_input_hash");
  if (
    operation.kind === ContextGatewayV4OperationKind.GitFact &&
    operation.fact !== "merge_base" &&
    operation.fact !== "changed_paths" &&
    operation.fact !== "diff_stat"
  ) {
    throw new Error(ContextGatewayV4ValidationIssue.GitFactInvalid);
  }
  return Object.freeze({ ...operation });
}

function normalizeResult(
  event: ContextGatewayV4Event,
): Readonly<Record<string, unknown>> {
  const result = event.result;
  if (result === null) {
    throw new Error(ContextGatewayV4ValidationIssue.ResultMissing);
  }
  switch (event.operationKind) {
    case ContextGatewayV4OperationKind.FileRead: {
      const extendedFileEvidence = Object.hasOwn(result, "contentKind");
      assertExactKeys(
        result,
        [
          "blobOid",
          "byteCount",
          "complete",
          ...(extendedFileEvidence ? ["contentKind"] : []),
          "contentHash",
          "eof",
          ...(extendedFileEvidence ? ["lineCount"] : []),
          "mode",
          "pathHash",
          "revision",
          "startByte",
          "treeOid",
        ],
        "file_result",
      );
      assertGitOid(result.blobOid, "file_blob_oid");
      assertGitOid(result.treeOid, "file_tree_oid");
      assertSha256(result.pathHash, "file_path_hash");
      assertSha256(result.contentHash, "file_content_hash");
      assertNonNegativeInteger(result.startByte, "file_start_byte");
      assertNonNegativeInteger(result.byteCount, "file_byte_count");
      if (extendedFileEvidence) {
        if (result.contentKind !== "text" && result.contentKind !== "binary") {
          throw new Error(
            ContextGatewayV4ValidationIssue.FileContentKindInvalid,
          );
        }
        if (result.contentKind === "text") {
          assertNonNegativeInteger(result.lineCount, "file_line_count");
        } else if (result.lineCount !== null) {
          throw new Error(ContextGatewayV4ValidationIssue.FileLineCountInvalid);
        }
      } else if (Object.hasOwn(result, "lineCount")) {
        throw new Error(
          ContextGatewayV4ValidationIssue.FileContentMetadataIncomplete,
        );
      }
      if (typeof result.eof !== "boolean" || result.complete !== result.eof) {
        throw new Error(ContextGatewayV4ValidationIssue.FileCompletionInvalid);
      }
      break;
    }
    case ContextGatewayV4OperationKind.DirectoryList:
    case ContextGatewayV4OperationKind.TextSearch:
    case ContextGatewayV4OperationKind.CanonicalInventory:
      assertExactKeys(
        result,
        [
          "aggregateHash",
          "aggregateItemCount",
          "aggregatePathCount",
          "aggregatePathSetHash",
          "complete",
          "cursorInputHash",
          "nextCursorHash",
          "pageItemCount",
          "pageItemsHash",
          "pagePathHashes",
          "pageOrdinal",
          "queryDigest",
          "treeOid",
        ],
        "page_result",
      );
      assertGitOid(result.treeOid, "page_tree_oid");
      assertSha256(result.queryDigest, "page_query_digest");
      assertSha256(result.pageItemsHash, "page_items_hash");
      assertSha256(result.aggregateHash, "page_aggregate_hash");
      assertSha256(result.aggregatePathSetHash, "page_aggregate_path_set_hash");
      if (result.cursorInputHash !== null) {
        assertSha256(result.cursorInputHash, "page_cursor_input_hash");
      }
      assertSha256Array(result.pagePathHashes, "page_path_hashes", 2_000);
      assertNonNegativeInteger(result.pageOrdinal, "page_ordinal");
      assertNonNegativeInteger(result.pageItemCount, "page_item_count");
      assertNonNegativeInteger(
        result.aggregateItemCount,
        "page_aggregate_item_count",
      );
      assertNonNegativeInteger(
        result.aggregatePathCount,
        "page_aggregate_path_count",
      );
      if (
        typeof result.complete !== "boolean" ||
        (result.complete
          ? result.nextCursorHash !== null
          : !isSha256(result.nextCursorHash))
      ) {
        throw new Error(ContextGatewayV4ValidationIssue.PageCompletionInvalid);
      }
      break;
    case ContextGatewayV4OperationKind.GitFact:
      assertExactKeys(
        result,
        ["complete", "fact", "itemCount", "resultHash"],
        "git_fact_result",
      );
      assertSha256(result.resultHash, "git_fact_result_hash");
      assertNonNegativeInteger(result.itemCount, "git_fact_item_count");
      if (result.complete !== true || result.fact !== event.operation.fact) {
        throw new Error(ContextGatewayV4ValidationIssue.GitFactResultInvalid);
      }
      break;
    case ContextGatewayV4OperationKind.UnsupportedTool:
      throw new Error(ContextGatewayV4ValidationIssue.UnsupportedToolSucceeded);
  }
  return Object.freeze({ ...result });
}

function assertSuccessfulEvidenceConsistency(
  events: readonly ContextGatewayV4Event[],
): void {
  const pages = new Map<string, ContextGatewayV4Event[]>();
  const files = new Map<string, ContextGatewayV4Event[]>();
  for (const event of events) {
    if (event.outcome !== ContextGatewayV4OutcomeKind.Succeeded) continue;
    const result = event.result;
    if (result === null) continue;
    if (
      event.operationKind === ContextGatewayV4OperationKind.DirectoryList ||
      event.operationKind === ContextGatewayV4OperationKind.TextSearch ||
      event.operationKind === ContextGatewayV4OperationKind.CanonicalInventory
    ) {
      const key = [
        event.operationKind,
        result.treeOid,
        result.queryDigest,
      ].join(":");
      const chain = pages.get(key) ?? [];
      chain.push(event);
      pages.set(key, chain);
    }
    if (event.operationKind === ContextGatewayV4OperationKind.FileRead) {
      const key = [result.revision, result.treeOid, result.pathHash].join(":");
      const ranges = files.get(key) ?? [];
      ranges.push(event);
      files.set(key, ranges);
    }
  }
  for (const chain of pages.values()) assertCompletePageSequences(chain);
  for (const ranges of files.values()) assertConsistentFileIdentity(ranges);
}

function assertCompletePageSequences(
  events: readonly ContextGatewayV4Event[],
): void {
  let sequence: ContextGatewayV4Event[] = [];
  for (const event of events) {
    if (Number(event.result?.pageOrdinal) === 0 && sequence.length > 0) {
      assertCompletePageChain(sequence);
      sequence = [];
    }
    sequence.push(event);
  }
  assertCompletePageChain(sequence);
}

function assertCompletePageChain(
  chain: readonly ContextGatewayV4Event[],
): void {
  let aggregateCount = 0;
  let terminal = false;
  let expectedCursorInputHash: string | null = null;
  const aggregatePathHashes = new Set<string>();
  for (let index = 0; index < chain.length; index += 1) {
    const result = chain[index]!.result;
    if (
      result === null ||
      terminal ||
      result.pageOrdinal !== index ||
      result.cursorInputHash !== expectedCursorInputHash ||
      result.aggregateItemCount !==
        aggregateCount + Number(result.pageItemCount)
    ) {
      throw new Error(ContextGatewayV4ValidationIssue.PageChainInvalid);
    }
    for (const pathHash of result.pagePathHashes as readonly string[]) {
      if (aggregatePathHashes.has(pathHash)) {
        throw new Error(ContextGatewayV4ValidationIssue.PagePathChainInvalid);
      }
      aggregatePathHashes.add(pathHash);
    }
    if (result.aggregatePathCount !== aggregatePathHashes.size) {
      throw new Error(ContextGatewayV4ValidationIssue.PagePathChainInvalid);
    }
    aggregateCount = Number(result.aggregateItemCount);
    terminal = result.complete === true;
    expectedCursorInputHash =
      typeof result.nextCursorHash === "string" ? result.nextCursorHash : null;
  }
  if (!terminal) {
    throw new Error(ContextGatewayV4ValidationIssue.PageChainIncomplete);
  }
}

function assertConsistentFileIdentity(
  ranges: readonly ContextGatewayV4Event[],
): void {
  const first = ranges[0]?.result;
  if (first === null || first === undefined) {
    throw new Error(ContextGatewayV4ValidationIssue.ResultMissing);
  }
  for (const event of ranges.slice(1)) {
    if (
      event.result === null ||
      event.result.mode !== first.mode ||
      event.result.blobOid !== first.blobOid
    ) {
      throw new Error(ContextGatewayV4ValidationIssue.FileIdentityMismatch);
    }
  }
}

function assertEventChain(
  events: readonly ContextGatewayV4Event[],
  eventChainSeedHash: string,
): void {
  let previous = eventChainSeedHash;
  for (const event of events) {
    if (event.previousEventHash !== previous) {
      throw new Error(ContextGatewayV4ValidationIssue.EventChainInvalid);
    }
    previous = event.eventHash;
  }
}

function toCanonicalValue(manifest: ContextGatewayV4Manifest): unknown {
  return {
    authenticatedChainHash: manifest.authenticatedChainHash,
    checkoutTreeOid: manifest.checkoutTreeOid,
    complete: manifest.complete,
    confinementTainted: manifest.confinementTainted,
    eventChainSeedHash: manifest.eventChainSeedHash,
    events: manifest.events,
    gatewayBinaryHash: manifest.gatewayBinaryHash,
    gatewayPolicyVersion: manifest.gatewayPolicyVersion,
    manifestVersion: manifest.manifestVersion,
    terminalFailureClass: manifest.terminalFailureClass,
  };
}

function assertExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
  field: "operation" | "file_result" | "page_result" | "git_fact_result",
): void {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (
    actual.length !== sorted.length ||
    actual.some((key, index) => key !== sorted[index])
  ) {
    throw new Error(contextGatewayV4ShapeIssue(field));
  }
}

function contextGatewayV4ShapeIssue(
  field: "operation" | "file_result" | "page_result" | "git_fact_result",
): ContextGatewayV4ValidationIssue {
  switch (field) {
    case "operation":
      return ContextGatewayV4ValidationIssue.OperationShapeInvalid;
    case "file_result":
      return ContextGatewayV4ValidationIssue.FileResultShapeInvalid;
    case "page_result":
      return ContextGatewayV4ValidationIssue.PageResultShapeInvalid;
    case "git_fact_result":
      return ContextGatewayV4ValidationIssue.GitFactResultShapeInvalid;
  }
}

function assertNonNegativeInteger(value: unknown, field: string): void {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${field}_invalid`);
  }
}

function assertSha256(value: unknown, field: string): asserts value is string {
  if (!isSha256(value)) throw new Error(`${field}_invalid`);
}

function assertSha256Array(
  value: unknown,
  field: string,
  maximumLength: number,
): asserts value is readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length > maximumLength ||
    value.some((item) => !isSha256(item)) ||
    new Set(value).size !== value.length ||
    value.some((item, index) => index > 0 && String(value[index - 1]) > item)
  ) {
    throw new Error(`${field}_invalid`);
  }
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function assertGitOid(value: unknown, field: string): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)
  ) {
    throw new Error(`${field}_invalid`);
  }
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}
