const encoder = new TextEncoder();

export const contextDependencyManifestVersion = 2;
export const contextDependencyManifestDomain =
  "reviewrouter.context-dependency-manifest.v2";
export const contextDependencyManifestMaxEntries = 2_000;
export const contextDependencyManifestMaxCanonicalBytes = 2 * 1024 * 1024;
export const contextDependencyMaxPathLength = 1_024;
export const contextDependencyMaxGlobs = 128;
export const contextDependencyMaxResultItems = 20_000;
export const contextDependencyMaxResultBytes = 32 * 1024 * 1024;

export enum ContextDependencyKind {
  FileRead = "file_read",
  DirectoryList = "directory_list",
  TextSearch = "text_search",
  GitFact = "git_fact",
}

export enum ContextGitFactKind {
  ChangedPaths = "changed_paths",
  DiffStat = "diff_stat",
  MergeBase = "merge_base",
}

export enum ContextFileKind {
  Regular = "regular",
  Symlink = "symlink",
  Gitlink = "gitlink",
}

export enum ContextSearchBinaryPolicy {
  Exclude = "exclude",
  Include = "include",
}

export type FileReadDependencyOperation = Readonly<{
  kind: ContextDependencyKind.FileRead;
  path: string;
  startByte: number;
  maxBytes: number;
}>;

export type DirectoryListDependencyOperation = Readonly<{
  kind: ContextDependencyKind.DirectoryList;
  path: string;
  maxDepth: number;
  includeHidden: boolean;
  maxEntries: number;
  ignorePolicyHash: string;
  caseSensitive: boolean;
}>;

export type TextSearchDependencyOperation = Readonly<{
  kind: ContextDependencyKind.TextSearch;
  queryDigest: string;
  replayHandleHash: string;
  paths: readonly string[];
  includeGlobs: readonly string[];
  excludeGlobs: readonly string[];
  maxResults: number;
  ignorePolicyHash: string;
  binaryPolicy: ContextSearchBinaryPolicy;
  caseSensitive: boolean;
  encoding: "utf8";
}>;

export type GitFactDependencyOperation = Readonly<{
  kind: ContextDependencyKind.GitFact;
  fact: ContextGitFactKind;
  operandsHash: string;
}>;

export type ContextDependencyOperation =
  | FileReadDependencyOperation
  | DirectoryListDependencyOperation
  | TextSearchDependencyOperation
  | GitFactDependencyOperation;

export type FileReadDependencyResult = Readonly<{
  kind: ContextDependencyKind.FileRead;
  fileKind: ContextFileKind;
  mode: number;
  blobOid: string;
  symlinkTargetHash: string | null;
  contentHash: string;
  byteCount: number;
  eof: boolean;
  complete: true;
  truncated: false;
}>;

export type DirectoryListDependencyResult = Readonly<{
  kind: ContextDependencyKind.DirectoryList;
  treeOid: string;
  orderedEntriesHash: string;
  itemCount: number;
  byteCount: number;
  complete: true;
  truncated: false;
}>;

export type TextSearchDependencyResult = Readonly<{
  kind: ContextDependencyKind.TextSearch;
  orderedMatchesHash: string;
  scannedTreeHash: string;
  itemCount: number;
  byteCount: number;
  complete: true;
  truncated: false;
}>;

export type GitFactDependencyResult = Readonly<{
  kind: ContextDependencyKind.GitFact;
  resultHash: string;
  itemCount: number;
  byteCount: number;
  complete: true;
  truncated: false;
}>;

export type ContextDependencyResult =
  | FileReadDependencyResult
  | DirectoryListDependencyResult
  | TextSearchDependencyResult
  | GitFactDependencyResult;

export type ContextDependencyEntry = Readonly<{
  sequence: number;
  previousEventHash: string;
  eventHash: string;
  operationKey: string;
  operation: ContextDependencyOperation;
  result: ContextDependencyResult;
}>;

export type ContextDependencyManifest = Readonly<{
  manifestVersion: typeof contextDependencyManifestVersion;
  gatewayPolicyVersion: string;
  gatewayBinaryHash: string;
  checkoutTreeOid: string;
  authenticatedChainHash: string;
  complete: true;
  dependencies: readonly ContextDependencyEntry[];
}>;

export type ContextDependencyManifestCandidate = Readonly<{
  manifestVersion: number;
  gatewayPolicyVersion: string;
  gatewayBinaryHash: string;
  checkoutTreeOid: string;
  authenticatedChainHash: string;
  complete: boolean;
  dependencies: readonly ContextDependencyEntry[];
}>;

export function createContextDependencyManifest(
  candidate: ContextDependencyManifestCandidate,
): ContextDependencyManifest {
  if (candidate.manifestVersion !== contextDependencyManifestVersion) {
    throw new Error("context_dependency_manifest_version_unsupported");
  }
  assertIdentifier(candidate.gatewayPolicyVersion, "gateway_policy_version");
  assertSha256(candidate.gatewayBinaryHash, "gateway_binary_hash");
  assertGitOid(candidate.checkoutTreeOid, "checkout_tree_oid");
  assertSha256(
    candidate.authenticatedChainHash,
    "authenticated_event_chain_hash",
  );
  if (!candidate.complete) {
    throw new Error("context_dependency_manifest_incomplete");
  }
  if (
    candidate.dependencies.length === 0 ||
    candidate.dependencies.length > contextDependencyManifestMaxEntries
  ) {
    throw new Error("context_dependency_manifest_entry_count_invalid");
  }

  const dependencies = candidate.dependencies.map((entry, index) =>
    normalizeDependencyEntry(entry, index + 1),
  );
  assertUniqueOperationKeys(dependencies);
  assertEventChain(dependencies);

  const manifest = Object.freeze({
    manifestVersion: contextDependencyManifestVersion,
    gatewayPolicyVersion: candidate.gatewayPolicyVersion,
    gatewayBinaryHash: candidate.gatewayBinaryHash,
    checkoutTreeOid: candidate.checkoutTreeOid,
    authenticatedChainHash: candidate.authenticatedChainHash,
    complete: true as const,
    dependencies: Object.freeze(dependencies),
  });
  if (
    canonicalContextDependencyManifestBytes(manifest).byteLength >
    contextDependencyManifestMaxCanonicalBytes
  ) {
    throw new Error("context_dependency_manifest_too_large");
  }
  return manifest;
}

export function cloneContextDependencyManifest(
  manifest: ContextDependencyManifest,
): ContextDependencyManifest {
  return createContextDependencyManifest({
    ...manifest,
    dependencies: manifest.dependencies.map((entry) => ({
      ...entry,
      operation: cloneOperation(entry.operation),
      result: { ...entry.result },
    })),
  });
}

export function canonicalContextDependencyManifest(
  manifest: ContextDependencyManifest,
): string {
  return canonicalContextDependencyManifestUnchecked(
    createContextDependencyManifest(manifest),
  );
}

export function canonicalContextDependencyManifestBytes(
  manifest: ContextDependencyManifest,
): Uint8Array {
  return encoder.encode(canonicalContextDependencyManifestUnchecked(manifest));
}

export function canonicalContextDependencyOperation(
  operation: ContextDependencyOperation,
): string {
  return stableJson(operationToCanonicalValue(normalizeOperation(operation)));
}

export function canonicalContextDependencyResult(
  result: ContextDependencyResult,
): string {
  return stableJson(resultToCanonicalValue(normalizeResult(result)));
}

function canonicalContextDependencyManifestUnchecked(
  manifest: ContextDependencyManifest,
): string {
  return stableJson({
    authenticatedChainHash: manifest.authenticatedChainHash,
    checkoutTreeOid: manifest.checkoutTreeOid,
    complete: manifest.complete,
    dependencies: manifest.dependencies.map((entry) => ({
      eventHash: entry.eventHash,
      operation: operationToCanonicalValue(entry.operation),
      operationKey: entry.operationKey,
      previousEventHash: entry.previousEventHash,
      result: resultToCanonicalValue(entry.result),
      sequence: entry.sequence,
    })),
    gatewayBinaryHash: manifest.gatewayBinaryHash,
    gatewayPolicyVersion: manifest.gatewayPolicyVersion,
    manifestVersion: manifest.manifestVersion,
  });
}

function normalizeDependencyEntry(
  candidate: ContextDependencyEntry,
  expectedSequence: number,
): ContextDependencyEntry {
  if (candidate.sequence !== expectedSequence) {
    throw new Error("context_dependency_sequence_invalid");
  }
  assertSha256(candidate.previousEventHash, "previous_event_hash");
  assertSha256(candidate.eventHash, "event_hash");
  assertSha256(candidate.operationKey, "context_dependency_operation_key");
  const operation = normalizeOperation(candidate.operation);
  const result = normalizeResult(candidate.result);
  if (operation.kind !== result.kind) {
    throw new Error("context_dependency_result_kind_mismatch");
  }
  return Object.freeze({
    sequence: candidate.sequence,
    previousEventHash: candidate.previousEventHash,
    eventHash: candidate.eventHash,
    operationKey: candidate.operationKey,
    operation,
    result,
  });
}

function normalizeOperation(
  operation: ContextDependencyOperation,
): ContextDependencyOperation {
  switch (operation.kind) {
    case ContextDependencyKind.FileRead:
      return Object.freeze({
        kind: operation.kind,
        path: normalizeRepositoryPath(operation.path),
        startByte: nonNegativeInteger(
          operation.startByte,
          "file_read_start_byte",
        ),
        maxBytes: positiveBoundedInteger(
          operation.maxBytes,
          contextDependencyMaxResultBytes,
          "file_read_max_bytes",
        ),
      });
    case ContextDependencyKind.DirectoryList:
      assertSha256(operation.ignorePolicyHash, "directory_ignore_policy_hash");
      return Object.freeze({
        kind: operation.kind,
        path: normalizeRepositoryPath(operation.path),
        maxDepth: positiveBoundedInteger(
          operation.maxDepth,
          32,
          "directory_list_max_depth",
        ),
        includeHidden: booleanValue(
          operation.includeHidden,
          "directory_list_include_hidden",
        ),
        maxEntries: positiveBoundedInteger(
          operation.maxEntries,
          contextDependencyMaxResultItems,
          "directory_list_max_entries",
        ),
        ignorePolicyHash: operation.ignorePolicyHash,
        caseSensitive: booleanValue(
          operation.caseSensitive,
          "directory_list_case_sensitive",
        ),
      });
    case ContextDependencyKind.TextSearch:
      assertSha256(operation.queryDigest, "text_search_query_digest");
      assertSha256(
        operation.replayHandleHash,
        "text_search_replay_handle_hash",
      );
      assertSha256(
        operation.ignorePolicyHash,
        "text_search_ignore_policy_hash",
      );
      if (
        !Object.values(ContextSearchBinaryPolicy).includes(
          operation.binaryPolicy,
        )
      ) {
        throw new Error("text_search_binary_policy_invalid");
      }
      if (operation.encoding !== "utf8") {
        throw new Error("text_search_encoding_invalid");
      }
      return Object.freeze({
        kind: operation.kind,
        queryDigest: operation.queryDigest,
        replayHandleHash: operation.replayHandleHash,
        paths: normalizeUniquePaths(operation.paths, "text_search_paths"),
        includeGlobs: normalizeGlobs(
          operation.includeGlobs,
          "text_search_include_globs",
        ),
        excludeGlobs: normalizeGlobs(
          operation.excludeGlobs,
          "text_search_exclude_globs",
        ),
        maxResults: positiveBoundedInteger(
          operation.maxResults,
          contextDependencyMaxResultItems,
          "text_search_max_results",
        ),
        ignorePolicyHash: operation.ignorePolicyHash,
        binaryPolicy: operation.binaryPolicy,
        caseSensitive: booleanValue(
          operation.caseSensitive,
          "text_search_case_sensitive",
        ),
        encoding: "utf8" as const,
      });
    case ContextDependencyKind.GitFact:
      if (!Object.values(ContextGitFactKind).includes(operation.fact)) {
        throw new Error("context_git_fact_unknown");
      }
      assertSha256(operation.operandsHash, "git_fact_operands_hash");
      return Object.freeze({
        kind: operation.kind,
        fact: operation.fact,
        operandsHash: operation.operandsHash,
      });
  }
}

function normalizeResult(
  result: ContextDependencyResult,
): ContextDependencyResult {
  if (result.complete !== true) {
    throw new Error("context_dependency_result_incomplete");
  }
  if (result.truncated !== false) {
    throw new Error("context_dependency_result_truncated");
  }
  switch (result.kind) {
    case ContextDependencyKind.FileRead:
      if (!Object.values(ContextFileKind).includes(result.fileKind)) {
        throw new Error("context_dependency_file_kind_invalid");
      }
      assertFileMode(result.mode);
      assertGitOid(result.blobOid, "context_dependency_blob_oid");
      if (result.symlinkTargetHash !== null) {
        assertSha256(
          result.symlinkTargetHash,
          "context_dependency_symlink_target_hash",
        );
      }
      if (
        result.fileKind === ContextFileKind.Symlink &&
        result.symlinkTargetHash === null
      ) {
        throw new Error("context_dependency_symlink_target_required");
      }
      if (
        result.fileKind !== ContextFileKind.Symlink &&
        result.symlinkTargetHash !== null
      ) {
        throw new Error("context_dependency_symlink_target_invalid");
      }
      assertSha256(result.contentHash, "context_dependency_content_hash");
      assertBoundedNonNegativeInteger(
        result.byteCount,
        contextDependencyMaxResultBytes,
        "context_dependency_byte_count",
      );
      return Object.freeze({
        ...result,
        eof: booleanValue(result.eof, "file_read_eof"),
        complete: true as const,
        truncated: false as const,
      });
    case ContextDependencyKind.DirectoryList:
      assertGitOid(result.treeOid, "context_dependency_tree_oid");
      assertSha256(
        result.orderedEntriesHash,
        "context_dependency_ordered_entries_hash",
      );
      assertResultAccounting(result.itemCount, result.byteCount);
      return Object.freeze({
        ...result,
        complete: true as const,
        truncated: false as const,
      });
    case ContextDependencyKind.TextSearch:
      assertSha256(
        result.orderedMatchesHash,
        "context_dependency_ordered_matches_hash",
      );
      assertSha256(
        result.scannedTreeHash,
        "context_dependency_scanned_tree_hash",
      );
      assertResultAccounting(result.itemCount, result.byteCount);
      return Object.freeze({
        ...result,
        complete: true as const,
        truncated: false as const,
      });
    case ContextDependencyKind.GitFact:
      assertSha256(result.resultHash, "context_dependency_git_result_hash");
      assertResultAccounting(result.itemCount, result.byteCount);
      return Object.freeze({
        ...result,
        complete: true as const,
        truncated: false as const,
      });
  }
}

function operationToCanonicalValue(operation: ContextDependencyOperation) {
  switch (operation.kind) {
    case ContextDependencyKind.FileRead:
      return { ...operation };
    case ContextDependencyKind.DirectoryList:
      return { ...operation };
    case ContextDependencyKind.TextSearch:
      return {
        ...operation,
        paths: operation.paths,
        includeGlobs: operation.includeGlobs,
        excludeGlobs: operation.excludeGlobs,
      };
    case ContextDependencyKind.GitFact:
      return { ...operation };
  }
}

function resultToCanonicalValue(result: ContextDependencyResult) {
  return { ...result };
}

function cloneOperation(
  operation: ContextDependencyOperation,
): ContextDependencyOperation {
  return operation.kind === ContextDependencyKind.TextSearch
    ? {
        ...operation,
        paths: [...operation.paths],
        includeGlobs: [...operation.includeGlobs],
        excludeGlobs: [...operation.excludeGlobs],
      }
    : { ...operation };
}

function assertEventChain(
  dependencies: readonly ContextDependencyEntry[],
): void {
  for (let index = 1; index < dependencies.length; index += 1) {
    if (
      dependencies[index]?.previousEventHash !==
      dependencies[index - 1]?.eventHash
    ) {
      throw new Error("context_dependency_event_chain_invalid");
    }
  }
}

function normalizeRepositoryPath(value: string): string {
  const path = boundedNonEmptyString(
    value,
    contextDependencyMaxPathLength,
    "context_dependency_path",
  );
  if (
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((segment) => segment === "" || segment === "..")
  ) {
    throw new Error("context_dependency_path_invalid");
  }
  return path;
}

function normalizeUniquePaths(
  values: readonly string[],
  field: string,
): readonly string[] {
  if (values.length === 0 || values.length > contextDependencyMaxGlobs) {
    throw new Error(`${field}_count_invalid`);
  }
  const normalized = values.map(normalizeRepositoryPath).sort(compareStrings);
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`${field}_duplicate`);
  }
  return Object.freeze(normalized);
}

function normalizeGlobs(
  values: readonly string[],
  field: string,
): readonly string[] {
  if (values.length > contextDependencyMaxGlobs) {
    throw new Error(`${field}_count_invalid`);
  }
  const normalized = values
    .map((value) =>
      boundedNonEmptyString(
        value,
        contextDependencyMaxPathLength,
        `${field}_value`,
      ),
    )
    .sort(compareStrings);
  if (
    normalized.some((value) => value.startsWith("/") || value.includes("\\"))
  ) {
    throw new Error(`${field}_value_invalid`);
  }
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`${field}_duplicate`);
  }
  return Object.freeze(normalized);
}

function assertUniqueOperationKeys(
  dependencies: readonly ContextDependencyEntry[],
): void {
  if (
    new Set(dependencies.map((dependency) => dependency.operationKey)).size !==
    dependencies.length
  ) {
    throw new Error("context_dependency_operation_duplicate");
  }
}

function assertResultAccounting(itemCount: number, byteCount: number): void {
  assertBoundedNonNegativeInteger(
    itemCount,
    contextDependencyMaxResultItems,
    "context_dependency_item_count",
  );
  assertBoundedNonNegativeInteger(
    byteCount,
    contextDependencyMaxResultBytes,
    "context_dependency_byte_count",
  );
}

function assertFileMode(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0o177777) {
    throw new Error("context_dependency_file_mode_invalid");
  }
}

function assertGitOid(value: string, field: string): void {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) {
    throw new Error(`${field}_invalid`);
  }
}

function assertSha256(value: string, field: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`${field}_invalid`);
}

function assertIdentifier(value: string, field: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(value)) {
    throw new Error(`${field}_invalid`);
  }
}

function boundedNonEmptyString(
  value: string,
  maxLength: number,
  field: string,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    value.includes("\0")
  ) {
    throw new Error(`${field}_invalid`);
  }
  return value;
}

function nonNegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field}_invalid`);
  }
  return value;
}

function positiveBoundedInteger(
  value: number,
  maximum: number,
  field: string,
): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${field}_invalid`);
  }
  return value;
}

function assertBoundedNonNegativeInteger(
  value: number,
  maximum: number,
  field: string,
): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new Error(`${field}_invalid`);
  }
}

function booleanValue(value: boolean, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${field}_invalid`);
  return value;
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort(compareStrings)
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
