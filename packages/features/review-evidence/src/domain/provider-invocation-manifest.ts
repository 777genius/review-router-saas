import {
  ProviderExecutionProfile,
  ReviewProviderKind,
  ReviewTaskKind,
  assertBoundedString,
  assertIdentifier,
  assertSha256,
  reviewEvidenceMaxTaskKinds,
} from "./review-evidence-primitives";

export const providerRequestEnvelopeVersion = 1;
export const providerInvocationManifestVersion = 1;
export const providerInvocationManifestDomain =
  "rr.provider-invocation-manifest.v1\0";
export const providerInvocationIdentityDomain = "rr.provider-invocation.v1\0";

const sha256PatternSource = "^[a-f0-9]{64}$";
const identifierPatternSource = "^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$";

export const providerInvocationManifestV1CanonicalizerDescriptor =
  Object.freeze({
    descriptorVersion: 1,
    canonicalizerId: "provider_invocation_manifest_v1",
    typeName: "ProviderInvocationManifestV1",
    manifestVersion: providerInvocationManifestVersion,
    canonicalPreimageDomain: providerInvocationManifestDomain,
    providerInvocationPreimageDomain: providerInvocationIdentityDomain,
    fields: Object.freeze([
      Object.freeze({
        name: "manifestVersion",
        kind: "literal_integer",
        value: providerInvocationManifestVersion,
        errorCode: "provider_invocation_manifest_version_unsupported",
      }),
      hashField("scopeHash", "scope_hash_invalid"),
      Object.freeze({
        name: "taskKindSet",
        kind: "enum_set",
        values: Object.freeze([
          ReviewTaskKind.FindingDiscovery,
          ReviewTaskKind.LifecycleRevalidation,
        ]),
        unknownValue: ReviewTaskKind.Unknown,
        minItems: 1,
        maxItems: reviewEvidenceMaxTaskKinds,
        normalization: "lexicographic",
        countErrorCode: "review_evidence_task_kind_count_invalid",
        duplicateErrorCode: "review_evidence_task_kind_duplicate",
        unknownErrorCode: "review_evidence_task_kind_unknown",
        invalidErrorCode: "review_evidence_task_kind_invalid",
      }),
      Object.freeze({
        name: "providerKind",
        kind: "enum",
        values: Object.freeze([
          ReviewProviderKind.Codex,
          ReviewProviderKind.ClaudeCode,
          ReviewProviderKind.OpenRouter,
        ]),
        unknownValue: ReviewProviderKind.Unknown,
        unknownErrorCode: "provider_kind_unknown",
        invalidErrorCode: "provider_kind_invalid",
      }),
      hashField("providerCapabilityHash", "provider_capability_hash_invalid"),
      Object.freeze({
        name: "requestedModel",
        kind: "bounded_string",
        minLength: 1,
        maxLength: 256,
        errorCode: "requested_model_invalid",
      }),
      identifierField(
        "providerPolicyVersion",
        "provider_policy_version_invalid",
      ),
      identifierField("producerReleaseId", "producer_release_id_invalid"),
      identifierField(
        "selectedProtocolVersion",
        "selected_protocol_version_invalid",
      ),
      hashField(
        "providerRequestEnvelopeHash",
        "provider_request_envelope_hash_invalid",
      ),
      hashField("outputSchemaHash", "output_schema_hash_invalid"),
      hashField("reviewConfigHash", "review_config_hash_invalid"),
      hashField("runtimeCompatibilityKey", "runtime_compatibility_key_invalid"),
      hashField("filePatchManifestHash", "file_patch_manifest_hash_invalid"),
      hashField("contextManifestHash", "context_manifest_hash_invalid"),
      nullableHashField("memoryBundleHash", "memory_bundle_hash_invalid"),
      nullableHashField(
        "codeGraphProjectionHash",
        "code_graph_projection_hash_invalid",
      ),
      nullableHashField(
        "lifecycleTargetSetHash",
        "lifecycle_target_set_hash_invalid",
      ),
      nullableHashField(
        "liveLifecycleStateHash",
        "live_lifecycle_state_hash_invalid",
      ),
      hashField("toolPolicyHash", "tool_policy_hash_invalid"),
      Object.freeze({
        name: "executionProfile",
        kind: "enum",
        values: Object.freeze([
          ProviderExecutionProfile.PromptOnlyEnvelopeV1,
          ProviderExecutionProfile.AgenticUnboundedV1,
          ProviderExecutionProfile.ContextGatewayV1,
        ]),
        unknownValue: ProviderExecutionProfile.Unknown,
        unknownErrorCode: "provider_execution_profile_unknown",
        invalidErrorCode: "provider_execution_profile_invalid",
      }),
      nullableHashField("baseTreeHash", "base_tree_hash_invalid"),
      hashField("environmentContractHash", "environment_contract_hash_invalid"),
    ]),
    goldenVector: Object.freeze({
      input: Object.freeze({
        manifestVersion: providerInvocationManifestVersion,
        scopeHash: "c".repeat(64),
        taskKindSet: Object.freeze([
          ReviewTaskKind.LifecycleRevalidation,
          ReviewTaskKind.FindingDiscovery,
        ]),
        providerKind: ReviewProviderKind.Codex,
        providerCapabilityHash: "d".repeat(64),
        requestedModel: "gpt-5.3-codex",
        providerPolicyVersion: "provider-policy-v1",
        producerReleaseId: "release-1",
        selectedProtocolVersion: "review-action-v2",
        providerRequestEnvelopeHash: "e".repeat(64),
        outputSchemaHash: "f".repeat(64),
        reviewConfigHash: "1".repeat(64),
        runtimeCompatibilityKey: "2".repeat(64),
        filePatchManifestHash: "3".repeat(64),
        contextManifestHash: "4".repeat(64),
        memoryBundleHash: null,
        codeGraphProjectionHash: null,
        lifecycleTargetSetHash: "8".repeat(64),
        liveLifecycleStateHash: "9".repeat(64),
        toolPolicyHash: "5".repeat(64),
        executionProfile: ProviderExecutionProfile.PromptOnlyEnvelopeV1,
        baseTreeHash: "6".repeat(64),
        environmentContractHash: "7".repeat(64),
      }),
      providerVoteIdentityHash: "a".repeat(64),
    }),
  });

const maxRequestMessages = 128;
const maxRequestMessageBytes = 2 * 1024 * 1024;
const maxCanonicalRequestBytes = 4 * 1024 * 1024;

export enum ProviderRequestMessageRole {
  System = "system",
  Developer = "developer",
  User = "user",
  Assistant = "assistant",
  Tool = "tool",
  Unknown = "unknown",
}

export type CanonicalJsonPrimitive = string | number | boolean | null;
export type CanonicalJsonValue =
  | CanonicalJsonPrimitive
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue };

export type ProviderRequestMessage = Readonly<{
  role: ProviderRequestMessageRole;
  content: string;
  name: string | null;
}>;

export type ProviderRequestEnvelope = Readonly<{
  envelopeVersion: typeof providerRequestEnvelopeVersion;
  messages: readonly ProviderRequestMessage[];
  systemInstruction: string | null;
  developerInstruction: string | null;
  toolDefinitions: readonly CanonicalJsonValue[];
  inferenceOptions: CanonicalJsonValue;
  requestedModel: string;
  resolvedProviderConfiguration: CanonicalJsonValue;
  providerExecutionContractVersion: string;
}>;

export type ProviderInvocationManifest = Readonly<{
  manifestVersion: typeof providerInvocationManifestVersion;
  scopeHash: string;
  taskKindSet: readonly ReviewTaskKind[];
  providerKind: ReviewProviderKind;
  providerCapabilityHash: string;
  requestedModel: string;
  providerPolicyVersion: string;
  producerReleaseId: string;
  selectedProtocolVersion: string;
  providerRequestEnvelopeHash: string;
  outputSchemaHash: string;
  reviewConfigHash: string;
  runtimeCompatibilityKey: string;
  filePatchManifestHash: string;
  contextManifestHash: string;
  memoryBundleHash: string | null;
  codeGraphProjectionHash: string | null;
  lifecycleTargetSetHash: string | null;
  liveLifecycleStateHash: string | null;
  toolPolicyHash: string;
  executionProfile: ProviderExecutionProfile;
  baseTreeHash: string | null;
  environmentContractHash: string;
}>;

export type ProviderInvocationIdentity = Readonly<{
  manifest: ProviderInvocationManifest;
  canonicalManifestBytes: Uint8Array;
  manifestKey: string;
  providerVoteIdentityHash: string;
  providerInvocationKey: string;
}>;

export function canonicalizeProviderRequestEnvelope(
  envelope: ProviderRequestEnvelope,
): Uint8Array {
  if (envelope.envelopeVersion !== providerRequestEnvelopeVersion) {
    throw new Error("provider_request_envelope_version_unsupported");
  }
  if (
    envelope.messages.length === 0 ||
    envelope.messages.length > maxRequestMessages
  ) {
    throw new Error("provider_request_message_count_invalid");
  }
  assertBoundedString(envelope.requestedModel, "requested_model", 256);
  assertIdentifier(
    envelope.providerExecutionContractVersion,
    "provider_execution_contract_version",
  );
  const messages = envelope.messages.map((message) => {
    if (message.role === ProviderRequestMessageRole.Unknown) {
      throw new Error("provider_request_message_role_unknown");
    }
    if (utf8Bytes(message.content).byteLength > maxRequestMessageBytes) {
      throw new Error("provider_request_message_too_large");
    }
    if (message.name !== null) {
      assertIdentifier(message.name, "provider_request_message_name");
    }
    return [message.role, message.name, message.content] as const;
  });
  assertSafeProviderConfiguration(envelope.resolvedProviderConfiguration);
  const canonical = stableJson([
    "provider_request_envelope",
    envelope.envelopeVersion,
    messages,
    envelope.systemInstruction,
    envelope.developerInstruction,
    envelope.toolDefinitions,
    envelope.inferenceOptions,
    envelope.requestedModel,
    envelope.resolvedProviderConfiguration,
    envelope.providerExecutionContractVersion,
  ]);
  const bytes = utf8Bytes(canonical);
  if (bytes.byteLength > maxCanonicalRequestBytes) {
    throw new Error("provider_request_envelope_too_large");
  }
  return bytes;
}

export function normalizeProviderInvocationManifest(
  candidate: unknown,
): ProviderInvocationManifest {
  if (!isRecord(candidate)) {
    throw new Error("provider_invocation_manifest_invalid");
  }
  const fields = providerInvocationManifestV1CanonicalizerDescriptor.fields;
  const fieldNames = new Set(fields.map((field) => field.name));
  const unknownField = Object.keys(candidate)
    .sort()
    .find((field) => !fieldNames.has(field));
  if (unknownField) {
    throw new Error(
      `provider_invocation_manifest_unknown_field:${unknownField}`,
    );
  }
  const normalized: Record<string, unknown> = {};
  for (const field of fields) {
    normalized[field.name] = normalizeManifestField(
      field,
      candidate[field.name],
    );
  }
  return Object.freeze(normalized) as ProviderInvocationManifest;
}

export function canonicalizeProviderInvocationManifest(
  candidate: unknown,
): Uint8Array {
  const manifest = normalizeProviderInvocationManifest(candidate);
  const body = stableJson(
    providerInvocationManifestV1CanonicalizerDescriptor.fields.map(
      (field) => manifest[field.name as keyof ProviderInvocationManifest],
    ) as readonly CanonicalJsonValue[],
  );
  return utf8Bytes(`${providerInvocationManifestDomain}${body}`);
}

export function serializeProviderInvocationManifestCanonicalWireJson(
  candidate: unknown,
): string {
  const manifest = normalizeProviderInvocationManifest(candidate);
  return stableJson(
    Object.fromEntries(
      providerInvocationManifestV1CanonicalizerDescriptor.fields.map(
        (field) => [
          field.name,
          manifest[field.name as keyof ProviderInvocationManifest],
        ],
      ),
    ) as Readonly<Record<string, CanonicalJsonValue>>,
  );
}

export function providerInvocationIdentityPreimage(
  manifestKey: string,
  providerVoteIdentityHash: string,
): Uint8Array {
  assertSha256(manifestKey, "manifest_key");
  assertSha256(providerVoteIdentityHash, "provider_vote_identity_hash");
  return utf8Bytes(
    `${providerInvocationIdentityDomain}${manifestKey}\0${providerVoteIdentityHash}`,
  );
}

export function stableJson(value: CanonicalJsonValue): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new Error("canonical_json_number_invalid");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  const entries = Object.entries(value).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(",")}}`;
}

function utf8Bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function normalizeManifestField(
  field: (typeof providerInvocationManifestV1CanonicalizerDescriptor.fields)[number],
  value: unknown,
): unknown {
  if (field.kind === "literal_integer") {
    if (value !== field.value) throw new Error(field.errorCode);
    return value;
  }
  if (field.kind === "hash" || field.kind === "nullable_hash") {
    if (field.kind === "nullable_hash" && value === null) return null;
    if (typeof value !== "string" || !new RegExp(field.pattern).test(value)) {
      throw new Error(field.errorCode);
    }
    return value;
  }
  if (field.kind === "bounded_string") {
    if (
      typeof value !== "string" ||
      value.length < field.minLength ||
      value.length > field.maxLength
    ) {
      throw new Error(field.errorCode);
    }
    return value;
  }
  if (field.kind === "identifier") {
    if (typeof value !== "string" || !new RegExp(field.pattern).test(value)) {
      throw new Error(field.errorCode);
    }
    return value;
  }
  if (field.kind === "enum") {
    if (value === field.unknownValue) throw new Error(field.unknownErrorCode);
    if (typeof value !== "string" || !field.values.includes(value as never)) {
      throw new Error(field.invalidErrorCode);
    }
    return value;
  }
  if (!Array.isArray(value)) throw new Error(field.countErrorCode);
  if (value.length < field.minItems || value.length > field.maxItems) {
    throw new Error(field.countErrorCode);
  }
  if (value.some((item) => item === field.unknownValue)) {
    throw new Error(field.unknownErrorCode);
  }
  if (
    value.some(
      (item) =>
        typeof item !== "string" || !field.values.includes(item as never),
    )
  ) {
    throw new Error(field.invalidErrorCode);
  }
  const normalized = [...value].sort();
  if (
    normalized.some(
      (item, index) => index > 0 && item === normalized[index - 1],
    )
  ) {
    throw new Error(field.duplicateErrorCode);
  }
  return Object.freeze(normalized) as readonly ReviewTaskKind[];
}

function hashField(name: string, errorCode: string) {
  return Object.freeze({
    name,
    kind: "hash" as const,
    pattern: sha256PatternSource,
    errorCode,
  });
}

function nullableHashField(name: string, errorCode: string) {
  return Object.freeze({
    name,
    kind: "nullable_hash" as const,
    pattern: sha256PatternSource,
    errorCode,
  });
}

function identifierField(name: string, errorCode: string) {
  return Object.freeze({
    name,
    kind: "identifier" as const,
    pattern: identifierPatternSource,
    errorCode,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertSafeProviderConfiguration(value: CanonicalJsonValue): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) assertSafeProviderConfiguration(item);
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (
      /(?:token|secret|password|cookie|authorization|credential|api[_-]?key)/iu.test(
        key,
      )
    ) {
      throw new Error("provider_configuration_sensitive_key_forbidden");
    }
    assertSafeProviderConfiguration(item);
  }
}
