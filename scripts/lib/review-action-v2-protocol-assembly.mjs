import { createHash } from "node:crypto";

export const reviewActionV2OperationOrder = Object.freeze([
  "review_run_authorize",
  "review_run_renew",
  "review_execution_restore",
  "review_execution_start",
  "review_execution_supersede",
  "review_execution_observation_attach",
  "review_execution_observation_adopt",
  "review_execution_finalize",
  "review_investigation_open",
  "review_investigation_restore",
  "review_investigation_turn_plan",
  "review_investigation_turn_commit",
  "review_investigation_turn_abort",
  "review_investigation_replay_prepare",
  "review_investigation_replay",
  "review_investigation_conclude",
  "review_invocation_lease_acquire",
  "review_invocation_lease_renew",
  "review_invocation_lease_release",
  "review_context_gateway_open",
  "review_context_gateway_seal",
  "review_evidence_lookup",
  "review_context_receipt_replay_commit",
  "review_context_replay_commit",
  "review_evidence_commit",
  "review_snapshot_restore",
  "review_publication_request",
  "review_publication_status",
]);

export const reviewActionV2CallerAuthorities = Object.freeze([
  "fresh_scm_oidc",
  "current_authorization_and_fresh_same_run_oidc",
  "run_authorization",
  "run_authorization_and_lease_capability",
  "run_authorization_and_publication_permit",
  "lease_capability",
]);

const callerAuthorities = new Set(reviewActionV2CallerAuthorities);

const fieldTypes = new Set([
  "boolean",
  "canonical_json",
  "decimal",
  "enum",
  "git_oid",
  "hash",
  "hash_array",
  "identifier",
  "identifier_array",
  "non_negative_integer",
  "nullable_canonical_json",
  "nullable_decimal",
  "nullable_enum",
  "nullable_hash",
  "nullable_identifier",
  "nullable_non_negative_integer",
  "nullable_positive_integer",
  "nullable_string",
  "nullable_timestamp",
  "nullable_token",
  "positive_integer",
  "string",
  "timestamp",
  "token",
]);

export function assembleReviewActionV2Contract(input) {
  const { transportContract, semanticFragments } = input;
  assertRecord(transportContract, "transport_contract");
  if (
    transportContract.contractSourceVersion !== 1 ||
    transportContract.protocolVersion !== "2"
  ) {
    throw new Error("protocol_assembly_transport_identity_invalid");
  }
  if (!Array.isArray(semanticFragments) || semanticFragments.length !== 7) {
    throw new Error("protocol_assembly_fragment_count_invalid");
  }

  const contextNames = semanticFragments.map((fragment) => {
    assertRecord(fragment, "semantic_fragment");
    if (fragment.fragmentVersion !== 1) {
      throw new Error("protocol_assembly_fragment_version_invalid");
    }
    return fragment.boundedContext;
  });
  assertUniqueStrings(contextNames, "bounded_context");

  const enums = semanticFragments.flatMap((fragment) => [
    ...(fragment.publishedEnums ?? []),
  ]);
  for (const descriptor of enums) {
    assertRecord(descriptor, "enum");
    assertIdentifier(descriptor.typeName, "enum_type_name");
    assertUniqueStrings(descriptor.values, `enum_value:${descriptor.typeName}`);
    if (descriptor.values.length === 0) {
      throw new Error(`protocol_assembly_enum_empty:${descriptor.typeName}`);
    }
  }
  assertUniqueStrings(
    enums.map((descriptor) => descriptor.typeName),
    "enum_type_name",
  );
  const enumsByName = new Map(
    enums.map((descriptor) => [descriptor.typeName, descriptor]),
  );

  const canonicalizers = semanticFragments.flatMap((fragment) => [
    ...(fragment.publishedCanonicalizers ?? []),
  ]);
  if (canonicalizers.length !== 1) {
    throw new Error("protocol_assembly_canonicalizer_count_invalid");
  }
  for (const descriptor of canonicalizers) {
    assertCanonicalizerDescriptor(descriptor);
  }
  assertUniqueStrings(
    canonicalizers.map((descriptor) => descriptor.canonicalizerId),
    "canonicalizer_id",
  );
  assertUniqueStrings(
    canonicalizers.map((descriptor) => descriptor.typeName),
    "canonicalizer_type_name",
  );

  const semanticOperations = semanticFragments.flatMap((fragment) =>
    (fragment.operations ?? []).map((operation) => ({
      ...operation,
      boundedContext: fragment.boundedContext,
    })),
  );
  assertUniqueStrings(
    semanticOperations.map((operation) => operation.operationId),
    "semantic_operation_id",
  );
  assertUniqueStrings(
    [
      ...semanticOperations.flatMap((operation) => [
        operation.requestTypeName,
        operation.resultTypeName,
      ]),
      ...canonicalizers.map((descriptor) => descriptor.typeName),
    ],
    "published_type_name",
  );
  const semanticById = new Map(
    semanticOperations.map((operation) => [operation.operationId, operation]),
  );

  for (const operation of semanticOperations) {
    assertSemanticOperation(operation, enumsByName);
  }

  if (!Array.isArray(transportContract.operations)) {
    throw new Error("protocol_assembly_transport_operations_invalid");
  }
  assertUniqueStrings(
    transportContract.operations.map((operation) => operation.operationId),
    "transport_operation_id",
  );
  const actualOrder = transportContract.operations.map(
    (operation) => operation.operationId,
  );
  if (!arraysEqual(actualOrder, reviewActionV2OperationOrder)) {
    throw new Error("protocol_assembly_operation_order_invalid");
  }

  const declaredErrorCodes = new Set(
    (transportContract.errors ?? []).map((error) => error.errorCode),
  );
  assertUniqueStrings(
    (transportContract.errors ?? []).map((error) => error.typeName),
    "transport_error_type",
  );
  assertUniqueStrings([...declaredErrorCodes], "transport_error_code");
  const joined = [];
  for (const binding of transportContract.operations) {
    assertTransportBinding(binding, declaredErrorCodes);
    const semantic = semanticById.get(binding.operationId);
    if (!semantic) {
      throw new Error(
        `protocol_assembly_binding_without_command:${binding.operationId}`,
      );
    }
    joined.push(Object.freeze({ ...semantic, ...binding }));
  }
  for (const semantic of semanticOperations) {
    if (
      !transportContract.operations.some(
        (item) => item.operationId === semantic.operationId,
      )
    ) {
      throw new Error(
        `protocol_assembly_unbound_command:${semantic.operationId}`,
      );
    }
  }

  return Object.freeze({
    contractSourceVersion: transportContract.contractSourceVersion,
    protocolVersion: transportContract.protocolVersion,
    schemaId: transportContract.schemaId,
    envelope: transportContract.envelope,
    retryClasses: transportContract.retryClasses,
    errors: Object.freeze([...transportContract.errors]),
    enums: Object.freeze(
      enums.map((descriptor) => Object.freeze({ ...descriptor })),
    ),
    canonicalizers: Object.freeze([...canonicalizers]),
    operations: Object.freeze(joined),
  });
}

export function createPublishedProtocolArtifacts(contract, canonicalJson) {
  const schema = createPublishedSchema(contract);
  const schemaDigest = sha256(canonicalJson(schema));
  const fixtures = createPublishedFixtures(contract, schemaDigest);
  const canonicalizerFixtures = Object.fromEntries(
    contract.canonicalizers.map((descriptor) => [
      descriptor.canonicalizerId,
      createCanonicalizerGoldenFixture(descriptor, canonicalJson),
    ]),
  );
  const goldenFixtureDigest = sha256(
    canonicalJson({
      operations: fixtures,
      canonicalizers: canonicalizerFixtures,
    }),
  );
  const canonicalizerDescriptor = {
    canonicalizerVersion: 1,
    publishedCanonicalizers: contract.canonicalizers,
    operations: contract.operations.map((operation) => ({
      operationId: operation.operationId,
      fields: operation.requestFields.map((field) => field.name),
      naturalIdempotencyPreimage: operation.naturalIdempotencyPreimage,
    })),
  };
  const canonicalizerDigest = sha256(canonicalJson(canonicalizerDescriptor));
  const canonicalizerGoldenFixtureDigest = sha256(
    canonicalJson(canonicalizerFixtures),
  );
  return Object.freeze({
    schema,
    schemaDigest,
    fixtures,
    canonicalizerFixtures,
    goldenFixtureDigest,
    canonicalizerDigest,
    canonicalizerGoldenFixtureDigest,
    canonicalizerDescriptor,
  });
}

export function generatedPublishedCanonicalizerSources(contract, artifacts) {
  return new Map(
    contract.canonicalizers.map((descriptor) => {
      const fixture =
        artifacts.canonicalizerFixtures[descriptor.canonicalizerId];
      return [
        `generated/${descriptor.canonicalizerId.replaceAll("_", "-")}.ts`,
        generatedCanonicalizerSource(descriptor, fixture),
      ];
    }),
  );
}

function generatedCanonicalizerSource(descriptor, fixture) {
  const typeFields = descriptor.fields
    .map(
      (field) =>
        `  readonly ${field.name}: ${canonicalizerFieldTsType(field)};`,
    )
    .join("\n");
  const functionSuffix = descriptor.typeName;
  return `// Generated by scripts/generate-review-action-v2-protocol.mjs. Do not edit.

export const providerInvocationManifestV1CanonicalizerDescriptor = ${JSON.stringify(descriptor, null, 2)} as const;
export const providerInvocationManifestV1GoldenFixture = ${JSON.stringify(fixture, null, 2)} as const;

export type ${descriptor.typeName} = Readonly<{
${typeFields}
}>;

type CanonicalJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue };

export function normalize${functionSuffix}(input: unknown): ${descriptor.typeName} {
  if (!isRecord(input)) throw new Error("provider_invocation_manifest_invalid");
  const fields = providerInvocationManifestV1CanonicalizerDescriptor.fields;
  const fieldNames = new Set<string>(fields.map((field) => field.name));
  const unknownField = Object.keys(input).sort().find((field) => !fieldNames.has(field));
  if (unknownField) throw new Error(\`provider_invocation_manifest_unknown_field:\${unknownField}\`);
  const normalized: Record<string, unknown> = {};
  for (const field of fields) normalized[field.name] = normalizeManifestField(field, input[field.name]);
  return Object.freeze(normalized) as unknown as ${descriptor.typeName};
}

export function canonicalize${functionSuffix}(input: unknown): Uint8Array {
  const manifest = normalize${functionSuffix}(input);
  const values = providerInvocationManifestV1CanonicalizerDescriptor.fields.map(
    (field) => manifest[field.name as keyof ${descriptor.typeName}],
  ) as readonly CanonicalJsonValue[];
  return new TextEncoder().encode(
    providerInvocationManifestV1CanonicalizerDescriptor.canonicalPreimageDomain + canonicalJson(values),
  );
}

export function serialize${functionSuffix}CanonicalWireJson(input: unknown): string {
  const manifest = normalize${functionSuffix}(input);
  return canonicalJson(
    Object.fromEntries(
      providerInvocationManifestV1CanonicalizerDescriptor.fields.map((field) => [
        field.name,
        manifest[field.name as keyof ${descriptor.typeName}],
      ]),
    ) as Readonly<Record<string, CanonicalJsonValue>>,
  );
}

export function providerInvocationIdentityPreimageV1(
  manifestKey: string,
  providerVoteIdentityHash: string,
): Uint8Array {
  if (!digestPattern.test(manifestKey)) throw new Error("manifest_key_invalid");
  if (!digestPattern.test(providerVoteIdentityHash)) {
    throw new Error("provider_vote_identity_hash_invalid");
  }
  return new TextEncoder().encode(
    providerInvocationManifestV1CanonicalizerDescriptor.providerInvocationPreimageDomain +
      manifestKey +
      "\\0" +
      providerVoteIdentityHash,
  );
}

const digestPattern = /^[a-f0-9]{64}$/u;

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
    if (typeof value !== "string" || value.length < field.minLength || value.length > field.maxLength) {
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
  if (!Array.isArray(value) || value.length < field.minItems || value.length > field.maxItems) {
    throw new Error(field.countErrorCode);
  }
  if (value.some((item) => item === field.unknownValue)) throw new Error(field.unknownErrorCode);
  if (value.some((item) => typeof item !== "string" || !field.values.includes(item as never))) {
    throw new Error(field.invalidErrorCode);
  }
  const normalized = [...value].sort();
  if (normalized.some((item, index) => index > 0 && item === normalized[index - 1])) {
    throw new Error(field.duplicateErrorCode);
  }
  return Object.freeze(normalized);
}

function canonicalJson(value: CanonicalJsonValue): string {
  if (Array.isArray(value)) return \`[\${value.map(canonicalJson).join(",")}]\`;
  if (isRecord(value)) {
    return \`{\${Object.keys(value)
      .sort()
      .map((key) => \`\${JSON.stringify(key)}:\${canonicalJson(value[key] as CanonicalJsonValue)}\`)
      .join(",")}}\`;
  }
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
`;
}

export function generatedPublishedContractSource(contract, artifacts) {
  const enumSource = contract.enums
    .map(
      (descriptor) =>
        `export enum ${descriptor.typeName} {\n${descriptor.values
          .map((value) => `  ${enumMember(value)} = ${JSON.stringify(value)},`)
          .join("\n")}\n}`,
    )
    .join("\n\n");
  const typeSource = contract.operations
    .map((operation) => generatedOperationTypes(operation))
    .join("\n\n");
  const requestMap = contract.operations
    .map(
      (operation) =>
        `  [ReviewActionV2OperationId.${enumMember(operation.operationId)}]: ${operation.requestTypeName};`,
    )
    .join("\n");
  const resultMap = contract.operations
    .map(
      (operation) =>
        `  [ReviewActionV2OperationId.${enumMember(operation.operationId)}]: ${operation.resultTypeName};`,
    )
    .join("\n");
  const operationDescriptorsSource = generatedOperationDescriptorsSource(
    contract.operations,
    contract.enums,
  );
  return `// Generated by scripts/generate-review-action-v2-protocol.mjs. Do not edit.
import { ReviewActionV2RetryClass } from "./review-action-v2-negotiation.js";

export const reviewActionV2PublishedProtocolVersion = ${JSON.stringify(contract.protocolVersion)} as const;
export const reviewActionV2PublishedSchemaDigest = ${JSON.stringify(artifacts.schemaDigest)} as const;
export const reviewActionV2CanonicalizerDigest = ${JSON.stringify(artifacts.canonicalizerDigest)} as const;

export enum ReviewActionV2OperationId {
${contract.operations.map((operation) => `  ${enumMember(operation.operationId)} = ${JSON.stringify(operation.operationId)},`).join("\n")}
}

export enum ReviewActionV2CallerAuthority {
${reviewActionV2CallerAuthorities.map((authority) => `  ${enumMember(authority)} = ${JSON.stringify(authority)},`).join("\n")}
}

export enum ReviewActionV2ProtocolErrorCode {
${contract.errors.map((error) => `  ${enumMember(error.errorCode)} = ${JSON.stringify(error.errorCode)},`).join("\n")}
}

${enumSource}

export type ReviewActionV2RequestEnvelope = {
  readonly protocolVersion: typeof reviewActionV2PublishedProtocolVersion;
  readonly schemaDigest: typeof reviewActionV2PublishedSchemaDigest;
  readonly requestId: string;
};

export type ReviewActionV2ResultEnvelope<Result> = {
  readonly protocolVersion: typeof reviewActionV2PublishedProtocolVersion;
  readonly schemaDigest: typeof reviewActionV2PublishedSchemaDigest;
  readonly requestId: string;
  readonly serverTime: string;
  readonly result: Result;
};

export type ReviewActionV2ErrorResponse = {
  readonly protocolVersion: typeof reviewActionV2PublishedProtocolVersion;
  readonly schemaDigest: typeof reviewActionV2PublishedSchemaDigest;
  readonly requestId: string;
  readonly serverTime: string;
  readonly error: {
    readonly errorCode: ReviewActionV2ProtocolErrorCode;
    readonly retryClass: ReviewActionV2RetryClass;
    readonly details: { readonly issues: readonly string[] };
  };
};

${typeSource}

export type ReviewActionV2RequestMap = {
${requestMap}
};

export type ReviewActionV2ResultMap = {
${resultMap}
};

export const reviewActionV2Operations = ${operationDescriptorsSource} as const;

export const reviewActionV2GoldenFixtures = ${JSON.stringify(artifacts.fixtures, null, 2)} as const;

export const reviewContextGatewayEventDomain = "rr.context-gateway-event.v1" as const;
export const reviewContextSearchQueryDomain = "rr.context-search-query.v1" as const;
export const reviewContextReplayHandleDomain = "rr.context-replay-handle.v1" as const;
export const reviewContextReplayChainSeedDomain = "rr.context-replay-chain-seed.v1" as const;
export const reviewContextReplayEventDomain = "rr.context-replay-event.v1" as const;

export function canonicalizeReviewContextConfinementEvidence(input: {
  readonly attemptId: string;
  readonly sourceLeaseId: string;
  readonly sourceFencingToken: string;
  readonly sourceExecutionId: string;
  readonly sourceWorkSlotId: string;
  readonly sourceReviewRevisionHash: string;
  readonly checkoutTreeOid: string;
  readonly providerKind: string;
  readonly requestedModel: string;
  readonly executionProfile: string;
  readonly providerInvocationKey: string;
  readonly toolPolicyHash: string;
  readonly gatewayPolicyVersion: string;
  readonly gatewayBinaryHash: string;
}): string {
  return canonicalJson({ evidenceVersion: 1, ...input });
}

export function canonicalizeReviewContextGatewayEvent(input: {
  readonly sessionId: string;
  readonly sequence: number;
  readonly previousEventHash: string;
  readonly operationKey: string;
  readonly operation: unknown;
  readonly result: unknown;
}): string {
  return canonicalJson({ domain: reviewContextGatewayEventDomain, ...input });
}

export function canonicalizeReviewContextSearchQuery(query: string): string {
  return canonicalJson({ domain: reviewContextSearchQueryDomain, query });
}

export function canonicalizeReviewContextReplayHandle(input: {
  readonly sessionId: string;
  readonly sequence: number;
  readonly query: string;
}): string {
  return canonicalJson({ domain: reviewContextReplayHandleDomain, ...input });
}

export function canonicalizeReviewContextReplayChainSeed(input: {
  readonly planHash: string;
  readonly attestationId: string;
  readonly targetReviewRevisionHash: string;
  readonly targetCheckoutTreeOid: string;
}): string {
  return canonicalJson({ domain: reviewContextReplayChainSeedDomain, ...input });
}

export function canonicalizeReviewContextReplayEvent(input: {
  readonly sequence: number;
  readonly previousEventHash: string;
  readonly operationKey: string;
  readonly operation: unknown;
  readonly result: unknown;
}): string {
  return canonicalJson({ domain: reviewContextReplayEventDomain, ...input });
}

export type ReviewActionV2RequestParseResult<Operation extends ReviewActionV2OperationId> =
  | { readonly ok: true; readonly value: ReviewActionV2RequestMap[Operation] }
  | { readonly ok: false; readonly requestId?: string; readonly issues: readonly string[] };

export function parseReviewActionV2Request<Operation extends ReviewActionV2OperationId>(
  operationId: Operation,
  input: unknown,
): ReviewActionV2RequestParseResult<Operation> {
  const descriptor = reviewActionV2Operations.find((item) => item.operationId === operationId);
  if (!descriptor) throw new Error("review_action_v2_operation_unknown");
  if (!isRecord(input)) return { ok: false, issues: ["body_not_object"] };
  const requestId = readRequestId(input.requestId);
  const issues: string[] = [];
  const authorityFields = authorityFieldNames(descriptor.callerAuthority);
  const mutableFields = descriptor.mutability === "read" || operationId === ReviewActionV2OperationId.ReviewRunAuthorize
    ? []
    : ["idempotencyKey", "requestBodyHash"];
  const authorizeFields = operationId === ReviewActionV2OperationId.ReviewRunAuthorize
    ? ["oidcToken", "supportedProtocols"]
    : [];
  const allowed = new Set([
    "protocolVersion",
    "schemaDigest",
    "requestId",
    ...authorityFields,
    ...mutableFields,
    ...authorizeFields,
    ...descriptor.requestFields.map((field) => field.name),
  ]);
  for (const key of Object.keys(input).sort()) {
    if (!allowed.has(key)) issues.push(\`unknown_field:\${key}\`);
  }
  if (input.protocolVersion !== reviewActionV2PublishedProtocolVersion) issues.push("protocol_version_invalid");
  if (input.schemaDigest !== reviewActionV2PublishedSchemaDigest) issues.push("schema_digest_invalid");
  if (!requestId) issues.push("request_id_invalid");
  for (const field of authorityFields) validateField(field, "token", input[field], issues);
  for (const field of mutableFields) validateField(field, field === "requestBodyHash" ? "hash" : "identifier", input[field], issues);
  if (operationId === ReviewActionV2OperationId.ReviewRunAuthorize) {
    validateField("oidcToken", "token", input.oidcToken, issues);
    validateProtocolOffers(input.supportedProtocols, issues);
  }
  for (const field of descriptor.requestFields) validateField(
    field.name,
    field.type,
    input[field.name],
    issues,
    "enumValues" in field ? field.enumValues : undefined,
  );
  for (const group of descriptor.allOrNoneRequestFieldGroups) {
    const nullCount = group.filter((field) => input[field] === null).length;
    if (nullCount !== 0 && nullCount !== group.length) {
      issues.push(\`field_group_all_or_none:\${group.join(",")}\`);
    }
  }
  if (issues.length > 0 || !requestId) {
    return { ok: false, ...(requestId ? { requestId } : {}), issues: [...new Set(issues)].slice(0, 8) };
  }
  return { ok: true, value: input as ReviewActionV2RequestMap[Operation] };
}

export function canonicalizeReviewActionV2Request<Operation extends ReviewActionV2OperationId>(
  operationId: Operation,
  request: ReviewActionV2RequestMap[Operation],
): string {
  const parsed = parseReviewActionV2Request(operationId, request);
  if (!parsed.ok) throw new Error(\`review_action_v2_request_invalid:\${parsed.issues.join(",")}\`);
  const descriptor = reviewActionV2Operations.find((item) => item.operationId === operationId);
  if (!descriptor) throw new Error("review_action_v2_operation_unknown");
  const body = Object.fromEntries(descriptor.requestFields.map((field) => [field.name, (request as Record<string, unknown>)[field.name]]));
  return canonicalJson(body);
}

export function createReviewActionV2ErrorResponse(input: {
  readonly operationId: ReviewActionV2OperationId;
  readonly requestId: string;
  readonly serverTime: string;
  readonly errorCode: ReviewActionV2ProtocolErrorCode;
  readonly issues?: readonly string[];
}): ReviewActionV2ErrorResponse {
  const descriptor = reviewActionV2Operations.find((item) => item.operationId === input.operationId);
  const error = reviewActionV2ErrorRegistry.find((item) => item.errorCode === input.errorCode);
  if (!descriptor || !error || !descriptor.errorCodes.includes(input.errorCode as never)) {
    throw new Error("review_action_v2_error_not_allowed");
  }
  if (!readRequestId(input.requestId) || !Number.isFinite(Date.parse(input.serverTime))) {
    throw new Error("review_action_v2_error_envelope_invalid");
  }
  return {
    protocolVersion: reviewActionV2PublishedProtocolVersion,
    schemaDigest: reviewActionV2PublishedSchemaDigest,
    requestId: input.requestId,
    serverTime: input.serverTime,
    error: {
      errorCode: input.errorCode,
      retryClass: toRetryClass(error.retryClass),
      details: { issues: [...new Set(input.issues ?? [input.errorCode])].filter(Boolean).slice(0, 8) },
    },
  };
}

export function createReviewActionV2ResultResponse<Operation extends ReviewActionV2OperationId>(input: {
  readonly operationId: Operation;
  readonly requestId: string;
  readonly serverTime: string;
  readonly result: ReviewActionV2ResultMap[Operation];
}): ReviewActionV2ResultEnvelope<ReviewActionV2ResultMap[Operation]> {
  const descriptor = reviewActionV2Operations.find((item) => item.operationId === input.operationId);
  if (!descriptor || !descriptor.resultStatuses.includes(input.result.status as never)) {
    throw new Error("review_action_v2_result_status_invalid");
  }
  if (!readRequestId(input.requestId) || !Number.isFinite(Date.parse(input.serverTime))) {
    throw new Error("review_action_v2_result_envelope_invalid");
  }
  return {
    protocolVersion: reviewActionV2PublishedProtocolVersion,
    schemaDigest: reviewActionV2PublishedSchemaDigest,
    requestId: input.requestId,
    serverTime: input.serverTime,
    result: input.result,
  };
}

const reviewActionV2ErrorRegistry = ${JSON.stringify(contract.errors, null, 2)} as const;
const digestPattern = /^[a-f0-9]{64}$/;
const gitOidPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const decimalPattern = /^(0|[1-9][0-9]*)$/;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const requestIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function toRetryClass(value: string): ReviewActionV2RetryClass {
  switch (value) {
    case ReviewActionV2RetryClass.Never:
      return ReviewActionV2RetryClass.Never;
    case ReviewActionV2RetryClass.SameRequest:
      return ReviewActionV2RetryClass.SameRequest;
    case ReviewActionV2RetryClass.ReadOnly:
      return ReviewActionV2RetryClass.ReadOnly;
    default:
      throw new Error("review_action_v2_retry_class_unknown");
  }
}

function validateField(name: string, type: string, value: unknown, issues: string[], enumValues?: readonly string[]): void {
  const nullable = type.startsWith("nullable_");
  if (nullable && value === null) return;
  const base = nullable ? type.slice("nullable_".length) : type;
  let valid = false;
  if (base === "boolean") valid = typeof value === "boolean";
  else if (base === "hash") valid = typeof value === "string" && digestPattern.test(value);
  else if (base === "git_oid") valid = typeof value === "string" && gitOidPattern.test(value);
  else if (base === "decimal") valid = typeof value === "string" && decimalPattern.test(value);
  else if (base === "enum") valid = typeof value === "string" && Array.isArray(enumValues) && enumValues.includes(value);
  else if (base === "identifier") valid = typeof value === "string" && identifierPattern.test(value);
  else if (base === "positive_integer") valid = Number.isSafeInteger(value) && (value as number) > 0;
  else if (base === "non_negative_integer") valid = Number.isSafeInteger(value) && (value as number) >= 0;
  else if (base === "timestamp") valid = typeof value === "string" && Number.isFinite(Date.parse(value));
  else if (base === "token") valid = typeof value === "string" && value.length > 0 && value.length <= 32768 && /^\\S+$/u.test(value);
  else if (base === "string") valid = typeof value === "string" && value.length > 0 && value.length <= 1024;
  else if (base === "canonical_json") valid = typeof value === "string" && isCanonicalJson(value);
  else if (base === "hash_array") valid = Array.isArray(value) && value.length <= 256 && value.every((item) => typeof item === "string" && digestPattern.test(item));
  else if (base === "identifier_array") valid = Array.isArray(value) && value.length <= 256 && value.every((item) => typeof item === "string" && identifierPattern.test(item));
  if (!valid) issues.push(\`field_invalid:\${name}\`);
}

function validateProtocolOffers(value: unknown, issues: string[]): void {
  if (!Array.isArray(value) || value.length === 0 || value.length > 8) {
    issues.push("protocol_offers_invalid");
    return;
  }
  const identities = new Set<string>();
  for (const candidate of value) {
    if (!isRecord(candidate) || Object.keys(candidate).sort().join(",") !== "protocolVersion,schemaDigest" || typeof candidate.protocolVersion !== "string" || typeof candidate.schemaDigest !== "string" || !digestPattern.test(candidate.schemaDigest)) {
      issues.push("protocol_offer_invalid");
      continue;
    }
    const identity = \`\${candidate.protocolVersion}:\${candidate.schemaDigest}\`;
    if (identities.has(identity)) issues.push("protocol_offer_duplicate");
    identities.add(identity);
  }
}

function authorityFieldNames(
  authority: ReviewActionV2CallerAuthority,
): readonly string[] {
  if (authority === ReviewActionV2CallerAuthority.FreshScmOidc) return [];
  if (authority === ReviewActionV2CallerAuthority.CurrentAuthorizationAndFreshSameRunOidc) return ["authorizationToken"];
  if (authority === ReviewActionV2CallerAuthority.RunAuthorization) return ["authorizationToken"];
  if (authority === ReviewActionV2CallerAuthority.RunAuthorizationAndLeaseCapability) return ["authorizationToken", "leaseCapability"];
  if (authority === ReviewActionV2CallerAuthority.RunAuthorizationAndPublicationPermit) return ["authorizationToken"];
  if (authority === ReviewActionV2CallerAuthority.LeaseCapability) return ["leaseCapability"];
  throw new Error("review_action_v2_caller_authority_unknown");
}

function readRequestId(value: unknown): string | null {
  return typeof value === "string" && requestIdPattern.test(value) ? value : null;
}

function isCanonicalJson(value: string): boolean {
  try { return canonicalJson(JSON.parse(value)) === value; } catch { return false; }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return \`[\${value.map(canonicalJson).join(",")}]\`;
  if (isRecord(value)) return \`{\${Object.keys(value).sort().map((key) => \`\${JSON.stringify(key)}:\${canonicalJson(value[key])}\`).join(",")}}\`;
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
`;
}

function generatedOperationDescriptorsSource(operations, enums) {
  const descriptors = operations.map((operation) => ({
    operationId: operation.operationId,
    boundedContext: operation.boundedContext,
    method: operation.method,
    path: operation.path,
    callerAuthority: operation.callerAuthority,
    mutability: operation.mutability,
    naturalIdempotencyPreimage: operation.naturalIdempotencyPreimage,
    semanticRetryClass: operation.semanticRetryClass,
    transportAudience: operation.transportAudience,
    defaultTimeoutMs: operation.defaultTimeoutMs,
    bodyLimitBytes: operation.bodyLimitBytes,
    successStatuses: operation.successStatuses,
    errorCodes: operation.errorCodes,
    requestFields: operation.requestFields.map((field) => ({
      ...field,
      ...(field.type.replace(/^nullable_/u, "") === "enum"
        ? {
            enumValues: enums.find(
              (descriptor) => descriptor.typeName === field.enumTypeName,
            ).values,
          }
        : {}),
    })),
    allOrNoneRequestFieldGroups: operation.allOrNoneRequestFieldGroups ?? [],
    resultStatuses: enums.find(
      (descriptor) => descriptor.typeName === operation.resultStatusEnum,
    ).values,
  }));
  let source = JSON.stringify(descriptors, null, 2);
  for (const authority of reviewActionV2CallerAuthorities) {
    source = source.replaceAll(
      `"callerAuthority": ${JSON.stringify(authority)}`,
      `"callerAuthority": ReviewActionV2CallerAuthority.${enumMember(authority)}`,
    );
  }
  if (/"callerAuthority":\s*"/u.test(source)) {
    throw new Error("protocol_assembly_caller_authority_generation_invalid");
  }
  return source;
}

function generatedOperationTypes(operation) {
  const authorityFields = authorityFieldsFor(operation.callerAuthority);
  const mutableFields =
    operation.mutability === "read" ||
    operation.operationId === "review_run_authorize"
      ? []
      : [
          { name: "idempotencyKey", type: "identifier" },
          { name: "requestBodyHash", type: "hash" },
        ];
  const authorizeFields =
    operation.operationId === "review_run_authorize"
      ? [
          { name: "oidcToken", type: "token" },
          { name: "supportedProtocols", type: "protocol_offers" },
        ]
      : [];
  const requestFields = [
    ...authorityFields,
    ...mutableFields,
    ...authorizeFields,
    ...operation.requestFields,
  ];
  const requestBody = requestFields
    .map((field) => `  readonly ${field.name}: ${fieldTsType(field)};`)
    .join("\n");
  const resultBody = operation.resultFields
    .map((field) => `  readonly ${field.name}?: ${fieldTsType(field)};`)
    .join("\n");
  return `export type ${operation.requestTypeName} = ReviewActionV2RequestEnvelope & {\n${requestBody}\n};\n\nexport type ${operation.resultTypeName} = {\n  readonly status: ${operation.resultStatusEnum};\n${resultBody}\n};`;
}

function createPublishedSchema(contract) {
  const defs = {};
  for (const operation of contract.operations) {
    const request = requestSchema(contract, operation);
    const success = successResponseSchema(contract, operation);
    const errors = operation.errorCodes.map((errorCode) =>
      errorResponseSchema(contract, operation, errorCode),
    );
    defs[`${operation.operationId}_request`] = request;
    defs[`${operation.operationId}_response`] = {
      oneOf: [success, ...errors],
    };
  }
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: contract.schemaId,
    title: "ReviewRouter Action v2 Published Language",
    type: "object",
    $defs: defs,
    oneOf: contract.operations.flatMap((operation) => [
      { $ref: `#/$defs/${operation.operationId}_request` },
      { $ref: `#/$defs/${operation.operationId}_response` },
    ]),
  };
}

function requestSchema(contract, operation) {
  const fields = [
    ...authorityFieldsFor(operation.callerAuthority),
    ...(operation.mutability === "read" ||
    operation.operationId === "review_run_authorize"
      ? []
      : [
          { name: "idempotencyKey", type: "identifier" },
          { name: "requestBodyHash", type: "hash" },
        ]),
    ...(operation.operationId === "review_run_authorize"
      ? [
          { name: "oidcToken", type: "token" },
          { name: "supportedProtocols", type: "protocol_offers" },
        ]
      : []),
    ...operation.requestFields,
  ];
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "protocolVersion",
      "schemaDigest",
      "requestId",
      ...fields.map((field) => field.name),
    ],
    properties: {
      protocolVersion: { const: contract.protocolVersion },
      schemaDigest: { type: "string", pattern: "^[a-f0-9]{64}$" },
      requestId: {
        type: "string",
        minLength: 1,
        maxLength: contract.envelope.requestIdMaxBytes,
        pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$",
      },
      ...Object.fromEntries(
        fields.map((field) => [
          field.name,
          fieldJsonSchema(field, contract),
        ]),
      ),
    },
    ...allOrNoneRequestFieldGroupsSchema(operation, contract),
  };
}

function allOrNoneRequestFieldGroupsSchema(operation, contract) {
  const groups = operation.allOrNoneRequestFieldGroups ?? [];
  if (groups.length === 0) return {};
  const fieldsByName = new Map(
    operation.requestFields.map((field) => [field.name, field]),
  );
  return {
    allOf: groups.map((group) => ({
      oneOf: [
        {
          required: group,
          properties: Object.fromEntries(
            group.map((name) => {
              const field = fieldsByName.get(name);
              return [
                name,
                fieldJsonSchema(
                  { ...field, type: field.type.replace(/^nullable_/u, "") },
                  contract,
                ),
              ];
            }),
          ),
        },
        {
          required: group,
          properties: Object.fromEntries(
            group.map((name) => [name, { type: "null" }]),
          ),
        },
      ],
    })),
  };
}

function successResponseSchema(contract, operation) {
  const statusEnum = contract.enums.find(
    (descriptor) => descriptor.typeName === operation.resultStatusEnum,
  );
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "protocolVersion",
      "schemaDigest",
      "requestId",
      "serverTime",
      "result",
    ],
    properties: {
      ...responseEnvelopeSchema(contract),
      result: {
        type: "object",
        additionalProperties: false,
        required: ["status"],
        properties: {
          status: { enum: statusEnum.values },
          ...Object.fromEntries(
            operation.resultFields.map((field) => [
              field.name,
              fieldJsonSchema(field, contract),
            ]),
          ),
        },
      },
    },
  };
}

function errorResponseSchema(contract, operation, errorCode) {
  const error = contract.errors.find(
    (candidate) => candidate.errorCode === errorCode,
  );
  if (!error)
    throw new Error(`protocol_assembly_error_ref_undeclared:${errorCode}`);
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "protocolVersion",
      "schemaDigest",
      "requestId",
      "serverTime",
      "error",
    ],
    properties: {
      ...responseEnvelopeSchema(contract),
      error: {
        type: "object",
        additionalProperties: false,
        required: ["errorCode", "retryClass", "details"],
        properties: {
          errorCode: { const: error.errorCode },
          retryClass: { const: error.retryClass },
          details: {
            type: "object",
            additionalProperties: false,
            required: ["issues"],
            properties: {
              issues: {
                type: "array",
                maxItems: contract.envelope.errorDetailMaxItems,
                items: {
                  type: "string",
                  minLength: 1,
                  maxLength: contract.envelope.errorDetailMaxBytes,
                },
              },
            },
          },
        },
      },
    },
  };
}

function responseEnvelopeSchema(contract) {
  return {
    protocolVersion: { const: contract.protocolVersion },
    schemaDigest: { type: "string", pattern: "^[a-f0-9]{64}$" },
    requestId: {
      type: "string",
      minLength: 1,
      maxLength: contract.envelope.requestIdMaxBytes,
    },
    serverTime: { type: "string", format: "date-time" },
  };
}

function createPublishedFixtures(contract, schemaDigest) {
  return Object.fromEntries(
    contract.operations.map((operation, index) => {
      const request = {
        protocolVersion: contract.protocolVersion,
        schemaDigest,
        requestId: `rr_fixture_${String(index + 1).padStart(2, "0")}`,
      };
      for (const field of authorityFieldsFor(operation.callerAuthority)) {
        request[field.name] = sampleValue(field, field.name, index, contract);
      }
      if (
        operation.mutability !== "read" &&
        operation.operationId !== "review_run_authorize"
      ) {
        request.idempotencyKey = `idem_fixture_${index + 1}`;
        request.requestBodyHash = sampleHash(index + 1);
      }
      if (operation.operationId === "review_run_authorize") {
        request.oidcToken = "fixture.header.payload.signature";
        request.supportedProtocols = [
          { protocolVersion: contract.protocolVersion, schemaDigest },
        ];
      }
      for (const field of operation.requestFields) {
        request[field.name] = sampleValue(field, field.name, index, contract);
      }
      const status = contract.enums.find(
        (descriptor) => descriptor.typeName === operation.resultStatusEnum,
      ).values[0];
      return [
        operation.operationId,
        {
          request,
          response: {
            protocolVersion: contract.protocolVersion,
            schemaDigest,
            requestId: request.requestId,
            serverTime: "2026-01-01T00:00:00.000Z",
            result: { status },
          },
        },
      ];
    }),
  );
}

function fieldJsonSchema(fieldOrType, contract) {
  const field =
    typeof fieldOrType === "string" ? { type: fieldOrType } : fieldOrType;
  const type = field.type;
  const nullable = type.startsWith("nullable_");
  const base = nullable ? type.slice("nullable_".length) : type;
  let schema;
  if (base === "boolean") schema = { type: "boolean" };
  else if (base === "hash")
    schema = { type: "string", pattern: "^[a-f0-9]{64}$" };
  else if (base === "git_oid")
    schema = {
      type: "string",
      pattern: "^(?:[a-f0-9]{40}|[a-f0-9]{64})$",
    };
  else if (base === "decimal")
    schema = { type: "string", pattern: "^(0|[1-9][0-9]*)$" };
  else if (base === "enum") {
    const descriptor = contract.enums.find(
      (candidate) => candidate.typeName === field.enumTypeName,
    );
    if (!descriptor) {
      throw new Error(
        `protocol_assembly_enum_field_ref_undeclared:${field.enumTypeName}`,
      );
    }
    schema = { enum: descriptor.values };
  }
  else if (base === "identifier")
    schema = {
      type: "string",
      minLength: 1,
      maxLength: 256,
      pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$",
    };
  else if (base === "positive_integer")
    schema = { type: "integer", minimum: 1 };
  else if (base === "non_negative_integer")
    schema = { type: "integer", minimum: 0 };
  else if (base === "timestamp")
    schema = { type: "string", format: "date-time" };
  else if (base === "token")
    schema = {
      type: "string",
      minLength: 1,
      maxLength: contract.envelope.capabilityTokenMaxBytes,
      pattern: "^\\S+$",
    };
  else if (base === "string")
    schema = { type: "string", minLength: 1, maxLength: 1024 };
  else if (base === "canonical_json") schema = { type: "string", minLength: 2 };
  else if (base === "hash_array")
    schema = {
      type: "array",
      maxItems: 256,
      uniqueItems: true,
      items: fieldJsonSchema("hash", contract),
    };
  else if (base === "identifier_array")
    schema = {
      type: "array",
      maxItems: 256,
      uniqueItems: true,
      items: fieldJsonSchema("identifier", contract),
    };
  else if (base === "protocol_offers") {
    schema = {
      type: "array",
      minItems: 1,
      maxItems: 8,
      uniqueItems: true,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["protocolVersion", "schemaDigest"],
        properties: {
          protocolVersion: { type: "string", pattern: "^[1-9][0-9]{0,2}$" },
          schemaDigest: { type: "string", pattern: "^[a-f0-9]{64}$" },
        },
      },
    };
  } else throw new Error(`protocol_assembly_field_type_undeclared:${type}`);
  return nullable ? { anyOf: [schema, { type: "null" }] } : schema;
}

function authorityFieldsFor(authority) {
  if (authority === "fresh_scm_oidc") return [];
  if (authority === "current_authorization_and_fresh_same_run_oidc") {
    return [{ name: "authorizationToken", type: "token" }];
  }
  if (authority === "run_authorization_and_lease_capability") {
    return [
      { name: "authorizationToken", type: "token" },
      { name: "leaseCapability", type: "token" },
    ];
  }
  if (authority === "lease_capability") {
    return [{ name: "leaseCapability", type: "token" }];
  }
  if (authority === "run_authorization") {
    return [{ name: "authorizationToken", type: "token" }];
  }
  if (authority === "run_authorization_and_publication_permit") {
    return [{ name: "authorizationToken", type: "token" }];
  }
  throw new Error(`protocol_assembly_caller_authority_invalid:${authority}`);
}

function fieldTsType(fieldOrType) {
  const field =
    typeof fieldOrType === "string" ? { type: fieldOrType } : fieldOrType;
  const type = field.type;
  const nullable = type.startsWith("nullable_");
  const base = nullable ? type.slice("nullable_".length) : type;
  let result;
  if (["positive_integer", "non_negative_integer"].includes(base))
    result = "number";
  else if (base === "boolean") result = "boolean";
  else if (base === "enum") result = field.enumTypeName;
  else if (["hash_array", "identifier_array"].includes(base))
    result = "readonly string[]";
  else if (base === "protocol_offers")
    result =
      "readonly { readonly protocolVersion: string; readonly schemaDigest: string }[]";
  else result = "string";
  return nullable ? `${result} | null` : result;
}

function canonicalizerFieldTsType(field) {
  if (field.kind === "literal_integer") return String(field.value);
  if (field.kind === "enum") {
    return field.values.map((value) => JSON.stringify(value)).join(" | ");
  }
  if (field.kind === "enum_set") {
    return `readonly (${field.values
      .map((value) => JSON.stringify(value))
      .join(" | ")})[]`;
  }
  if (field.kind === "nullable_hash") return "string | null";
  return "string";
}

function createCanonicalizerGoldenFixture(descriptor, canonicalJson) {
  const normalized = normalizeCanonicalizerInput(
    descriptor,
    descriptor.goldenVector.input,
  );
  const canonicalWireJson = canonicalJson(normalized);
  const canonicalManifestPreimage =
    descriptor.canonicalPreimageDomain +
    canonicalJson(descriptor.fields.map((field) => normalized[field.name]));
  const manifestKey = sha256(canonicalManifestPreimage);
  const providerInvocationPreimage = `${descriptor.providerInvocationPreimageDomain}${manifestKey}\0${descriptor.goldenVector.providerVoteIdentityHash}`;
  return Object.freeze({
    input: descriptor.goldenVector.input,
    normalized,
    canonicalWireJson,
    canonicalManifestPreimage,
    canonicalManifestBytesHex: Buffer.from(
      canonicalManifestPreimage,
      "utf8",
    ).toString("hex"),
    manifestKey,
    providerVoteIdentityHash: descriptor.goldenVector.providerVoteIdentityHash,
    providerInvocationPreimage,
    providerInvocationPreimageBytesHex: Buffer.from(
      providerInvocationPreimage,
      "utf8",
    ).toString("hex"),
    providerInvocationKey: sha256(providerInvocationPreimage),
  });
}

function normalizeCanonicalizerInput(descriptor, input) {
  assertRecord(input, "canonicalizer_golden_input");
  const fieldNames = new Set(descriptor.fields.map((field) => field.name));
  const unknownField = Object.keys(input)
    .sort()
    .find((field) => !fieldNames.has(field));
  if (unknownField) {
    throw new Error(
      `protocol_assembly_canonicalizer_golden_unknown_field:${unknownField}`,
    );
  }
  return Object.fromEntries(
    descriptor.fields.map((field) => [
      field.name,
      normalizeCanonicalizerField(field, input[field.name]),
    ]),
  );
}

function normalizeCanonicalizerField(field, value) {
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
    if (typeof value !== "string" || !field.values.includes(value)) {
      throw new Error(field.invalidErrorCode);
    }
    return value;
  }
  if (
    !Array.isArray(value) ||
    value.length < field.minItems ||
    value.length > field.maxItems
  ) {
    throw new Error(field.countErrorCode);
  }
  if (value.some((item) => item === field.unknownValue)) {
    throw new Error(field.unknownErrorCode);
  }
  if (
    value.some(
      (item) => typeof item !== "string" || !field.values.includes(item),
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
  return normalized;
}

function sampleValue(fieldOrType, name, index, contract) {
  const field =
    typeof fieldOrType === "string" ? { type: fieldOrType } : fieldOrType;
  const type = field.type;
  const nullable = type.startsWith("nullable_");
  if (nullable) return null;
  if (type === "boolean") return true;
  if (type === "hash") return sampleHash(index + name.length);
  if (type === "git_oid") return sampleGitOid(index + name.length);
  if (type === "decimal") return String(index + 1);
  if (type === "enum") {
    const descriptor = contract.enums.find(
      (candidate) => candidate.typeName === field.enumTypeName,
    );
    if (!descriptor) {
      throw new Error(
        `protocol_assembly_enum_field_ref_undeclared:${field.enumTypeName}`,
      );
    }
    return descriptor.values[0];
  }
  if (type === "positive_integer") return index + 1;
  if (type === "non_negative_integer") return index;
  if (type === "timestamp") return "2026-01-01T00:00:00.000Z";
  if (type === "token") return "fixture.header.payload.signature";
  if (type === "canonical_json") return '{"fixture":true}';
  if (type === "hash_array") return [sampleHash(index + 1)];
  if (type === "identifier_array") return [`${name}_fixture`];
  return `${name}_fixture`;
}

function sampleHash(seed) {
  return (seed % 16).toString(16).repeat(64);
}

function sampleGitOid(seed) {
  return (seed % 16).toString(16).repeat(40);
}

function assertCanonicalizerDescriptor(descriptor) {
  assertRecord(descriptor, "canonicalizer_descriptor");
  if (
    descriptor.descriptorVersion !== 1 ||
    descriptor.canonicalizerId !== "provider_invocation_manifest_v1" ||
    descriptor.typeName !== "ProviderInvocationManifestV1" ||
    descriptor.manifestVersion !== 1 ||
    descriptor.canonicalPreimageDomain !==
      "rr.provider-invocation-manifest.v1\0" ||
    descriptor.providerInvocationPreimageDomain !==
      "rr.provider-invocation.v1\0"
  ) {
    throw new Error("protocol_assembly_canonicalizer_identity_invalid");
  }
  if (!Array.isArray(descriptor.fields) || descriptor.fields.length === 0) {
    throw new Error("protocol_assembly_canonicalizer_fields_invalid");
  }
  assertUniqueStrings(
    descriptor.fields.map((field) => field.name),
    `canonicalizer_field:${descriptor.canonicalizerId}`,
  );
  const supportedKinds = new Set([
    "literal_integer",
    "hash",
    "nullable_hash",
    "bounded_string",
    "identifier",
    "enum",
    "enum_set",
  ]);
  for (const field of descriptor.fields) {
    assertRecord(field, "canonicalizer_field");
    assertIdentifier(field.name, "canonicalizer_field_name");
    if (!supportedKinds.has(field.kind)) {
      throw new Error(
        `protocol_assembly_canonicalizer_field_kind_invalid:${field.name}`,
      );
    }
    if (field.kind === "literal_integer") {
      if (
        !Number.isSafeInteger(field.value) ||
        typeof field.errorCode !== "string"
      ) {
        throw new Error(
          `protocol_assembly_canonicalizer_literal_invalid:${field.name}`,
        );
      }
      continue;
    }
    if (["hash", "nullable_hash", "identifier"].includes(field.kind)) {
      if (
        typeof field.pattern !== "string" ||
        typeof field.errorCode !== "string"
      ) {
        throw new Error(
          `protocol_assembly_canonicalizer_pattern_invalid:${field.name}`,
        );
      }
      new RegExp(field.pattern);
      continue;
    }
    if (field.kind === "bounded_string") {
      if (
        !Number.isSafeInteger(field.minLength) ||
        !Number.isSafeInteger(field.maxLength) ||
        field.minLength < 0 ||
        field.maxLength < field.minLength ||
        typeof field.errorCode !== "string"
      ) {
        throw new Error(
          `protocol_assembly_canonicalizer_string_invalid:${field.name}`,
        );
      }
      continue;
    }
    assertUniqueStrings(field.values, `canonicalizer_enum:${field.name}`);
    if (
      field.values.length === 0 ||
      typeof field.unknownValue !== "string" ||
      typeof field.unknownErrorCode !== "string" ||
      typeof field.invalidErrorCode !== "string"
    ) {
      throw new Error(
        `protocol_assembly_canonicalizer_enum_invalid:${field.name}`,
      );
    }
    if (
      field.kind === "enum_set" &&
      (!Number.isSafeInteger(field.minItems) ||
        !Number.isSafeInteger(field.maxItems) ||
        field.minItems < 1 ||
        field.maxItems < field.minItems ||
        field.normalization !== "lexicographic" ||
        typeof field.countErrorCode !== "string" ||
        typeof field.duplicateErrorCode !== "string")
    ) {
      throw new Error(
        `protocol_assembly_canonicalizer_enum_set_invalid:${field.name}`,
      );
    }
  }
  assertRecord(descriptor.goldenVector, "canonicalizer_golden_vector");
  assertRecord(descriptor.goldenVector.input, "canonicalizer_golden_input");
  if (
    typeof descriptor.goldenVector.providerVoteIdentityHash !== "string" ||
    !/^[a-f0-9]{64}$/u.test(descriptor.goldenVector.providerVoteIdentityHash)
  ) {
    throw new Error("protocol_assembly_canonicalizer_golden_vote_hash_invalid");
  }
}

function assertSemanticOperation(operation, enumsByName) {
  assertRecord(operation, "semantic_operation");
  assertIdentifier(operation.operationId, "semantic_operation_id");
  assertIdentifier(operation.requestTypeName, "request_type_name");
  assertIdentifier(operation.resultTypeName, "result_type_name");
  if (!callerAuthorities.has(operation.callerAuthority)) {
    throw new Error(
      `protocol_assembly_caller_authority_invalid:${operation.callerAuthority}`,
    );
  }
  if (!enumsByName.has(operation.resultStatusEnum)) {
    throw new Error(
      `protocol_assembly_ref_undeclared:${operation.resultStatusEnum}`,
    );
  }
  if (!["read", "command", "authorization"].includes(operation.mutability)) {
    throw new Error(
      `protocol_assembly_mutability_invalid:${operation.operationId}`,
    );
  }
  if (
    !["never", "same_request", "read_only"].includes(
      operation.semanticRetryClass,
    )
  ) {
    throw new Error(
      `protocol_assembly_retry_class_invalid:${operation.operationId}`,
    );
  }
  assertUniqueStrings(
    operation.naturalIdempotencyPreimage,
    `idempotency_preimage:${operation.operationId}`,
  );
  assertFields(
    operation.requestFields,
    `${operation.operationId}:request`,
    enumsByName,
  );
  assertAllOrNoneRequestFieldGroups(operation);
  assertFields(
    operation.resultFields,
    `${operation.operationId}:result`,
    enumsByName,
  );
}

function assertAllOrNoneRequestFieldGroups(operation) {
  const groups = operation.allOrNoneRequestFieldGroups ?? [];
  if (!Array.isArray(groups)) {
    throw new Error(
      `protocol_assembly_all_or_none_groups_invalid:${operation.operationId}`,
    );
  }
  const fieldsByName = new Map(
    operation.requestFields.map((field) => [field.name, field]),
  );
  const seen = new Set();
  for (const group of groups) {
    if (!Array.isArray(group) || group.length < 2) {
      throw new Error(
        `protocol_assembly_all_or_none_group_invalid:${operation.operationId}`,
      );
    }
    assertUniqueStrings(group, `all_or_none_group:${operation.operationId}`);
    const identity = [...group].sort().join(",");
    if (seen.has(identity)) {
      throw new Error(
        `protocol_assembly_all_or_none_group_duplicate:${operation.operationId}`,
      );
    }
    seen.add(identity);
    for (const fieldName of group) {
      const field = fieldsByName.get(fieldName);
      if (!field || !field.type.startsWith("nullable_")) {
        throw new Error(
          `protocol_assembly_all_or_none_field_invalid:${operation.operationId}:${fieldName}`,
        );
      }
    }
  }
}

function assertTransportBinding(binding, declaredErrorCodes) {
  assertRecord(binding, "transport_binding");
  if (
    binding.method !== "POST" ||
    typeof binding.path !== "string" ||
    !binding.path.startsWith("/api/action/v2/")
  ) {
    throw new Error(
      `protocol_assembly_transport_binding_invalid:${binding.operationId}`,
    );
  }
  if (
    !Number.isSafeInteger(binding.defaultTimeoutMs) ||
    binding.defaultTimeoutMs <= 0
  ) {
    throw new Error(`protocol_assembly_timeout_invalid:${binding.operationId}`);
  }
  if (
    !Number.isSafeInteger(binding.bodyLimitBytes) ||
    binding.bodyLimitBytes <= 0
  ) {
    throw new Error(
      `protocol_assembly_body_limit_invalid:${binding.operationId}`,
    );
  }
  assertUniqueStrings(
    binding.errorCodes,
    `binding_error_code:${binding.operationId}`,
  );
  for (const errorCode of binding.errorCodes) {
    if (!declaredErrorCodes.has(errorCode)) {
      throw new Error(`protocol_assembly_error_ref_undeclared:${errorCode}`);
    }
  }
}

function assertFields(fields, label, enumsByName) {
  if (!Array.isArray(fields))
    throw new Error(`protocol_assembly_fields_invalid:${label}`);
  assertUniqueStrings(
    fields.map((field) => field.name),
    `field_name:${label}`,
  );
  for (const field of fields) {
    assertRecord(field, "field");
    assertIdentifier(field.name, `field_name:${label}`);
    if (!fieldTypes.has(field.type)) {
      throw new Error(`protocol_assembly_field_type_undeclared:${field.type}`);
    }
    const baseType = field.type.replace(/^nullable_/u, "");
    if (baseType === "enum") {
      if (
        typeof field.enumTypeName !== "string" ||
        !enumsByName.has(field.enumTypeName)
      ) {
        throw new Error(
          `protocol_assembly_enum_field_ref_undeclared:${field.enumTypeName}`,
        );
      }
    } else if (field.enumTypeName !== undefined) {
      throw new Error(
        `protocol_assembly_enum_field_ref_unexpected:${field.name}`,
      );
    }
  }
}

function assertRecord(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`protocol_assembly_${label}_invalid`);
  }
}

function assertIdentifier(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`protocol_assembly_${label}_invalid`);
  }
}

function assertUniqueStrings(values, label) {
  if (
    !Array.isArray(values) ||
    values.some((value) => typeof value !== "string")
  ) {
    throw new Error(`protocol_assembly_${label}_invalid`);
  }
  if (new Set(values).size !== values.length) {
    throw new Error(`protocol_assembly_${label}_duplicate`);
  }
}

function arraysEqual(left, right) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function enumMember(value) {
  return value
    .split("_")
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join("");
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
