#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { format } from "prettier";
import {
  assembleReviewActionV2Contract,
  createPublishedProtocolArtifacts,
  generatedPublishedCanonicalizerSources,
  generatedPublishedContractSource,
} from "./lib/review-action-v2-protocol-assembly.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const defaultOutputRoot = join(
  repositoryRoot,
  "packages",
  "protocol-review-action-v2",
  "src",
);

export async function generateReviewActionV2Protocol(input = {}) {
  const sources = input.sources ?? (await loadCompiledContractSources());
  const contract = input.contract ?? sources.negotiationContract;
  const outputRoot = input.outputRoot ?? defaultOutputRoot;
  assertContractSource(contract);
  const operation = findAuthorizeOperation(contract);

  const schema = createSchema(contract, operation);
  const schemaDigest = sha256(canonicalJson(schema));
  const fixture = createGoldenFixture(contract, schemaDigest);
  const fixtureDigest = sha256(canonicalJson(fixture));
  const publishedContract = assembleReviewActionV2Contract({
    transportContract: sources.transportContract,
    semanticFragments: sources.semanticFragments,
    publishedContracts: sources.publishedContracts,
  });
  const published = createPublishedProtocolArtifacts(
    publishedContract,
    canonicalJson,
  );
  const manifest = createManifest(
    contract,
    operation,
    schemaDigest,
    fixtureDigest,
    publishedContract,
    published,
  );
  const generatedIndex = await format(generatedIndexSource(), {
    parser: "typescript",
  });
  const generatedContract = await format(
    generatedContractSource(contract, operation, schemaDigest, fixture),
    { parser: "typescript" },
  );
  const generatedPublishedContract = await format(
    generatedPublishedContractSource(publishedContract, published),
    { parser: "typescript" },
  );
  const generatedCanonicalizers = new Map();
  for (const [relativePath, source] of generatedPublishedCanonicalizerSources(
    publishedContract,
    published,
  )) {
    generatedCanonicalizers.set(
      relativePath,
      await format(source, { parser: "typescript" }),
    );
  }
  const generatedSchema = await format(prettyJson(schema), { parser: "json" });
  const generatedPublishedSchema = await format(prettyJson(published.schema), {
    parser: "json",
  });
  const generatedInvestigationExtensionSchema = await format(
    prettyJson(published.extensionSchema),
    { parser: "json" },
  );
  const generatedPublishedFixtures = await format(
    prettyJson(published.fixtures),
    { parser: "json" },
  );
  const generatedRequestFixture = await format(prettyJson(fixture.request), {
    parser: "json",
  });
  const generatedResponseFixture = await format(prettyJson(fixture.response), {
    parser: "json",
  });
  const generatedManifest = await format(prettyJson(manifest), {
    parser: "json",
  });
  const files = new Map([
    ["index.ts", generatedIndex],
    ["generated/review-action-v2-negotiation.ts", generatedContract],
    ["generated/review-action-v2-negotiation.schema.json", generatedSchema],
    ["generated/review-action-v2.ts", generatedPublishedContract],
    ["generated/review-action-v2.schema.json", generatedPublishedSchema],
    [
      "generated/review-investigation-extension-v1.schema.json",
      generatedInvestigationExtensionSchema,
    ],
    [
      "generated/fixtures/review-action-v2.golden.json",
      generatedPublishedFixtures,
    ],
    [
      "generated/fixtures/review-run-authorize.request.json",
      generatedRequestFixture,
    ],
    [
      "generated/fixtures/review-run-authorize.unsupported.response.json",
      generatedResponseFixture,
    ],
    ["generated/manifest.json", generatedManifest],
  ]);
  for (const [relativePath, contents] of generatedCanonicalizers) {
    files.set(relativePath, contents);
  }
  for (const [canonicalizerId, goldenFixture] of Object.entries(
    published.canonicalizerFixtures,
  )) {
    files.set(
      `generated/fixtures/${canonicalizerId.replaceAll("_", "-")}.golden.json`,
      await format(prettyJson(goldenFixture), { parser: "json" }),
    );
  }
  for (const operationDescriptor of publishedContract.operations) {
    const operationSchemaSource =
      published.extensionSchema.$defs[
        `${operationDescriptor.operationId}_request`
      ] === undefined
        ? published.schema
        : published.extensionSchema;
    const requestDefinition =
      operationSchemaSource.$defs[`${operationDescriptor.operationId}_request`];
    const responseDefinition =
      operationSchemaSource.$defs[
        `${operationDescriptor.operationId}_response`
      ];
    if (requestDefinition === undefined || responseDefinition === undefined) {
      throw new Error(
        `protocol_operation_schema_missing:${operationDescriptor.operationId}`,
      );
    }
    const operationSchema = {
      $schema: published.schema.$schema,
      $id: `${publishedContract.schemaId}/${operationDescriptor.operationId}`,
      title: `${operationDescriptor.operationId} request and response`,
      oneOf: [requestDefinition, responseDefinition],
    };
    files.set(
      `generated/schemas/${operationDescriptor.operationId}.schema.json`,
      await format(prettyJson(operationSchema), { parser: "json" }),
    );
  }

  await rm(join(outputRoot, "generated"), { recursive: true, force: true });
  for (const [relativePath, contents] of files) {
    const destination = join(outputRoot, relativePath);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, contents, "utf8");
  }
  return { files, manifest };
}

export const assertContractAssembly = assembleReviewActionV2Contract;

export function assertContractSource(contract) {
  if (!isRecord(contract) || contract.contractSourceVersion !== 1) {
    throw new Error("protocol_contract_source_version_invalid");
  }
  if (contract.protocolVersion !== "2" || !Array.isArray(contract.operations)) {
    throw new Error("protocol_contract_identity_invalid");
  }
  if (contract.operations.length === 0) {
    throw new Error("protocol_contract_operations_missing");
  }
  if (contract.operations.some((operation) => !isRecord(operation))) {
    throw new Error("protocol_contract_operation_invalid");
  }
  assertUniqueStrings(
    contract.operations.map((operation) => operation.operationId),
    "operation_id",
  );
  const operation = findAuthorizeOperation(contract);
  if (
    operation.method !== "POST" ||
    operation.path !== "/api/action/v2/review-runs/authorize"
  ) {
    throw new Error("protocol_contract_transport_binding_invalid");
  }
  assertPositiveInteger(operation.defaultTimeoutMs, "default_timeout");
  assertPositiveInteger(operation.bodyLimitBytes, "body_limit");
  assertPositiveInteger(operation.maxOidcTokenBytes, "oidc_token_limit");
  assertPositiveInteger(operation.maxProtocolOffers, "offer_limit");
  assertPositiveInteger(operation.maxRequestIdBytes, "request_id_limit");
  assertUniqueStrings(contract.retryClasses, "retry_class");
  if (!Array.isArray(contract.errors) || contract.errors.length === 0) {
    throw new Error("protocol_contract_errors_missing");
  }
  assertUniqueStrings(
    contract.errors.map((error) => error.typeName),
    "error_type",
  );
  assertUniqueStrings(
    contract.errors.map((error) => error.errorCode),
    "error_code",
  );
  for (const error of contract.errors) {
    if (!contract.retryClasses.includes(error.retryClass)) {
      throw new Error(
        `protocol_contract_retry_class_undeclared:${error.retryClass}`,
      );
    }
  }
  const invalidRequest = contract.errors.find(
    (error) => error.errorCode === "invalid_request",
  );
  const unsupportedProtocol = contract.errors.find(
    (error) => error.errorCode === "unsupported_protocol",
  );
  if (
    invalidRequest?.httpStatus !== 400 ||
    invalidRequest.retryClass !== "never" ||
    unsupportedProtocol?.httpStatus !== 426 ||
    unsupportedProtocol.retryClass !== "never" ||
    unsupportedProtocol.fallbackProtocolVersion !== "1"
  ) {
    throw new Error("protocol_contract_required_error_mapping_invalid");
  }
}

export function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function createSchema(contract, operation) {
  const digestPattern = "^[a-f0-9]{64}$";
  const requestIdPattern = "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$";
  const protocolVersionPattern = "^[1-9][0-9]{0,2}$";
  const envelopeProperties = {
    protocolVersion: { const: contract.protocolVersion },
    schemaDigest: { type: "string", pattern: digestPattern },
    requestId: {
      type: "string",
      minLength: 1,
      maxLength: operation.maxRequestIdBytes,
      pattern: requestIdPattern,
    },
  };
  const errorEnvelopeProperties = {
    ...envelopeProperties,
    selectedProtocolVersion: { type: "null" },
    selectedSchemaDigest: { type: "null" },
    serverTime: { type: "string", format: "date-time" },
  };
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: contract.schemaId,
    title: "ReviewRouter Action v2 review-run authorization negotiation",
    type: "object",
    $defs: {
      protocolOffer: {
        type: "object",
        additionalProperties: false,
        required: ["protocolVersion", "schemaDigest"],
        properties: {
          protocolVersion: {
            type: "string",
            pattern: protocolVersionPattern,
          },
          schemaDigest: { type: "string", pattern: digestPattern },
        },
      },
      request: {
        type: "object",
        additionalProperties: false,
        required: [
          "protocolVersion",
          "schemaDigest",
          "requestId",
          "oidcToken",
          "supportedProtocols",
        ],
        properties: {
          ...envelopeProperties,
          oidcToken: {
            type: "string",
            minLength: 1,
            maxLength: operation.maxOidcTokenBytes,
            pattern: "^\\S+$",
          },
          supportedProtocols: {
            type: "array",
            minItems: 1,
            maxItems: operation.maxProtocolOffers,
            items: { $ref: "#/$defs/protocolOffer" },
          },
        },
      },
      invalidRequestResponse: {
        type: "object",
        additionalProperties: false,
        required: [
          "protocolVersion",
          "schemaDigest",
          "requestId",
          "selectedProtocolVersion",
          "selectedSchemaDigest",
          "serverTime",
          "error",
        ],
        properties: {
          ...errorEnvelopeProperties,
          error: {
            type: "object",
            additionalProperties: false,
            required: ["errorCode", "retryClass", "details"],
            properties: {
              errorCode: { const: "invalid_request" },
              retryClass: { const: "never" },
              details: {
                type: "object",
                additionalProperties: false,
                required: ["issues"],
                properties: {
                  issues: {
                    type: "array",
                    minItems: 1,
                    maxItems: 8,
                    items: { type: "string", minLength: 1, maxLength: 160 },
                  },
                },
              },
            },
          },
        },
      },
      unsupportedProtocolResponse: {
        type: "object",
        additionalProperties: false,
        required: [
          "protocolVersion",
          "schemaDigest",
          "requestId",
          "selectedProtocolVersion",
          "selectedSchemaDigest",
          "serverTime",
          "error",
        ],
        properties: {
          ...errorEnvelopeProperties,
          error: {
            type: "object",
            additionalProperties: false,
            required: ["errorCode", "retryClass", "details"],
            properties: {
              errorCode: { const: "unsupported_protocol" },
              retryClass: { const: "never" },
              details: {
                type: "object",
                additionalProperties: false,
                required: ["fallbackProtocolVersion"],
                properties: {
                  fallbackProtocolVersion: {
                    const: contract.errors.find(
                      (error) => error.errorCode === "unsupported_protocol",
                    ).fallbackProtocolVersion,
                  },
                },
              },
            },
          },
        },
      },
    },
    oneOf: [
      { $ref: "#/$defs/request" },
      { $ref: "#/$defs/invalidRequestResponse" },
      { $ref: "#/$defs/unsupportedProtocolResponse" },
    ],
  };
}

function createGoldenFixture(contract, schemaDigest) {
  const request = {
    protocolVersion: contract.protocolVersion,
    schemaDigest,
    requestId: "rr_fixture_request_0001",
    oidcToken: "fixture.header.payload.signature",
    supportedProtocols: [
      { protocolVersion: contract.protocolVersion, schemaDigest },
    ],
  };
  const response = {
    protocolVersion: contract.protocolVersion,
    schemaDigest,
    requestId: request.requestId,
    selectedProtocolVersion: null,
    selectedSchemaDigest: null,
    serverTime: "2026-01-01T00:00:00.000Z",
    error: {
      errorCode: "unsupported_protocol",
      retryClass: "never",
      details: { fallbackProtocolVersion: "1" },
    },
  };
  return { request, response };
}

function createManifest(
  contract,
  operation,
  negotiationSchemaDigest,
  negotiationFixtureDigest,
  publishedContract,
  published,
) {
  return {
    contractSourceVersion: contract.contractSourceVersion,
    protocolVersion: contract.protocolVersion,
    schemaDigest: published.schemaDigest,
    goldenFixtureDigest: published.goldenFixtureDigest,
    canonicalizerDigest: published.canonicalizerDigest,
    extensions: [
      {
        extensionId: "review-investigation-shadow.v1",
        schemaDigest: published.extensionSchemaDigest,
        canonicalizerDigest: published.extensionCanonicalizerDigest,
        operationIds: [
          "review_investigation_open_v2",
          "review_investigation_lease_acquire",
          "review_investigation_lease_renew",
          "review_investigation_lease_release",
          "review_investigation_replay_v2",
          "review_investigation_context_gateway_open",
          "review_investigation_context_gateway_seal",
        ],
      },
    ],
    canonicalizerGoldenFixtureDigest:
      published.canonicalizerGoldenFixtureDigest,
    negotiationBridge: {
      operationId: operation.operationId,
      schemaDigest: negotiationSchemaDigest,
      goldenFixtureDigest: negotiationFixtureDigest,
    },
    operations: publishedContract.operations.map((descriptor) => ({
      operationId: descriptor.operationId,
      boundedContext: descriptor.boundedContext,
      method: descriptor.method,
      path: descriptor.path,
      callerAuthority: descriptor.callerAuthority,
      mutability: descriptor.mutability,
      naturalIdempotencyPreimage: descriptor.naturalIdempotencyPreimage,
      semanticRetryClass: descriptor.semanticRetryClass,
      transportAudience: descriptor.transportAudience,
      defaultTimeoutMs: descriptor.defaultTimeoutMs,
      bodyLimitBytes: descriptor.bodyLimitBytes,
      successStatuses: descriptor.successStatuses,
      statusMapping: descriptor.errorCodes.map((errorCode) => {
        const error = publishedContract.errors.find(
          (candidate) => candidate.errorCode === errorCode,
        );
        return {
          errorCode: error.errorCode,
          retryClass: error.retryClass,
          httpStatus: error.httpStatus,
        };
      }),
    })),
    publishedContracts: publishedContract.publishedContracts,
  };
}

function generatedIndexSource() {
  return `// Generated by scripts/generate-review-action-v2-protocol.mjs. Do not edit.\nexport * from "./generated/review-action-v2-negotiation.js";\nexport * from "./generated/review-action-v2.js";\nexport * from "./generated/provider-invocation-manifest-v1.js";\n`;
}

function generatedContractSource(contract, operation, schemaDigest, fixture) {
  return `// Generated by scripts/generate-review-action-v2-protocol.mjs. Do not edit.

export const reviewActionV2ProtocolVersion = ${JSON.stringify(contract.protocolVersion)} as const;
export const reviewActionV2SchemaDigest = ${JSON.stringify(schemaDigest)} as const;
export const reviewRunAuthorizeNegotiationPath = ${JSON.stringify(operation.path)} as const;
export const reviewRunAuthorizeNegotiationMethod = ${JSON.stringify(operation.method)} as const;
export const reviewRunAuthorizeNegotiationBodyLimitBytes = ${operation.bodyLimitBytes} as const;
export const reviewRunAuthorizeNegotiationDefaultTimeoutMs = ${operation.defaultTimeoutMs} as const;
export const reviewRunAuthorizeNegotiationMaxOidcTokenBytes = ${operation.maxOidcTokenBytes} as const;
export const reviewRunAuthorizeNegotiationMaxProtocolOffers = ${operation.maxProtocolOffers} as const;

export enum ReviewActionV2RetryClass {
  Never = "never",
  SameRequest = "same_request",
  ReadOnly = "read_only",
}

export enum ReviewActionV2ErrorCode {
  InvalidRequest = "invalid_request",
  UnsupportedProtocol = "unsupported_protocol",
}

export type ReviewActionV2ProtocolOffer = {
  readonly protocolVersion: string;
  readonly schemaDigest: string;
};

export type ReviewRunAuthorizeNegotiationRequest = {
  readonly protocolVersion: typeof reviewActionV2ProtocolVersion;
  readonly schemaDigest: string;
  readonly requestId: string;
  readonly oidcToken: string;
  readonly supportedProtocols: readonly ReviewActionV2ProtocolOffer[];
};

type ReviewActionV2ErrorEnvelopeBase = {
  readonly protocolVersion: typeof reviewActionV2ProtocolVersion;
  readonly schemaDigest: typeof reviewActionV2SchemaDigest;
  readonly requestId: string;
  readonly selectedProtocolVersion: null;
  readonly selectedSchemaDigest: null;
  readonly serverTime: string;
};

export type ReviewActionV2InvalidRequestResponse =
  ReviewActionV2ErrorEnvelopeBase & {
    readonly error: {
      readonly errorCode: ReviewActionV2ErrorCode.InvalidRequest;
      readonly retryClass: ReviewActionV2RetryClass.Never;
      readonly details: { readonly issues: readonly string[] };
    };
  };

export type ReviewActionV2UnsupportedProtocolResponse =
  ReviewActionV2ErrorEnvelopeBase & {
    readonly error: {
      readonly errorCode: ReviewActionV2ErrorCode.UnsupportedProtocol;
      readonly retryClass: ReviewActionV2RetryClass.Never;
      readonly details: { readonly fallbackProtocolVersion: "1" };
    };
  };

export type ReviewRunAuthorizeNegotiationParseResult =
  | { readonly ok: true; readonly value: ReviewRunAuthorizeNegotiationRequest }
  | {
      readonly ok: false;
      readonly requestId?: string;
      readonly issues: readonly string[];
    };

const digestPattern = /^[a-f0-9]{64}$/;
const requestIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const protocolVersionPattern = /^[1-9][0-9]{0,2}$/;
const nonWhitespaceTokenPattern = /^\\S+$/u;
const requestFields = new Set([
  "protocolVersion",
  "schemaDigest",
  "requestId",
  "oidcToken",
  "supportedProtocols",
]);
const offerFields = new Set(["protocolVersion", "schemaDigest"]);

export function parseReviewRunAuthorizeNegotiationRequest(
  input: unknown,
): ReviewRunAuthorizeNegotiationParseResult {
  if (!isRecord(input)) {
    return { ok: false, issues: ["body_not_object"] };
  }

  const requestId = readRequestId(input.requestId);
  const issues: string[] = [];
  for (const key of Object.keys(input).sort()) {
    if (!requestFields.has(key)) issues.push(\`unknown_field:\${key}\`);
  }
  if (input.protocolVersion !== reviewActionV2ProtocolVersion) {
    issues.push("protocol_version_invalid");
  }
  if (typeof input.schemaDigest !== "string" || !digestPattern.test(input.schemaDigest)) {
    issues.push("schema_digest_invalid");
  }
  if (!requestId) issues.push("request_id_invalid");
  if (
    typeof input.oidcToken !== "string" ||
    input.oidcToken.length === 0 ||
    new TextEncoder().encode(input.oidcToken).byteLength >
      reviewRunAuthorizeNegotiationMaxOidcTokenBytes ||
    !nonWhitespaceTokenPattern.test(input.oidcToken)
  ) {
    issues.push("oidc_token_invalid");
  }

  const offers = parseProtocolOffers(input.supportedProtocols, issues);
  if (
    offers &&
    typeof input.schemaDigest === "string" &&
    !offers.some(
      (offer) =>
        offer.protocolVersion === reviewActionV2ProtocolVersion &&
        offer.schemaDigest === input.schemaDigest,
    )
  ) {
    issues.push("primary_protocol_offer_missing");
  }
  if (issues.length > 0 || !requestId || !offers) {
    return {
      ok: false,
      ...(requestId ? { requestId } : {}),
      issues: [...new Set(issues)].slice(0, 8),
    };
  }
  return {
    ok: true,
    value: {
      protocolVersion: reviewActionV2ProtocolVersion,
      schemaDigest: input.schemaDigest as string,
      requestId,
      oidcToken: input.oidcToken as string,
      supportedProtocols: offers,
    },
  };
}

export function createReviewActionV2InvalidRequestResponse(input: {
  readonly requestId: string;
  readonly serverTime: string;
  readonly issues: readonly string[];
}): ReviewActionV2InvalidRequestResponse {
  return {
    ...errorEnvelope(input.requestId, input.serverTime),
    error: {
      errorCode: ReviewActionV2ErrorCode.InvalidRequest,
      retryClass: ReviewActionV2RetryClass.Never,
      details: {
        issues: [...new Set(input.issues)].filter(Boolean).slice(0, 8),
      },
    },
  };
}

export function createReviewActionV2UnsupportedProtocolResponse(input: {
  readonly requestId: string;
  readonly serverTime: string;
}): ReviewActionV2UnsupportedProtocolResponse {
  return {
    ...errorEnvelope(input.requestId, input.serverTime),
    error: {
      errorCode: ReviewActionV2ErrorCode.UnsupportedProtocol,
      retryClass: ReviewActionV2RetryClass.Never,
      details: { fallbackProtocolVersion: "1" },
    },
  };
}

export const reviewRunAuthorizeNegotiationGoldenFixture = ${JSON.stringify(fixture, null, 2)} as const;

function errorEnvelope(requestId: string, serverTime: string): ReviewActionV2ErrorEnvelopeBase {
  if (!readRequestId(requestId)) throw new Error("review_action_v2_request_id_invalid");
  if (!Number.isFinite(Date.parse(serverTime))) {
    throw new Error("review_action_v2_server_time_invalid");
  }
  return {
    protocolVersion: reviewActionV2ProtocolVersion,
    schemaDigest: reviewActionV2SchemaDigest,
    requestId,
    selectedProtocolVersion: null,
    selectedSchemaDigest: null,
    serverTime,
  };
}

function parseProtocolOffers(
  input: unknown,
  issues: string[],
): readonly ReviewActionV2ProtocolOffer[] | null {
  if (
    !Array.isArray(input) ||
    input.length === 0 ||
    input.length > reviewRunAuthorizeNegotiationMaxProtocolOffers
  ) {
    issues.push("protocol_offers_invalid");
    return null;
  }
  const offers: ReviewActionV2ProtocolOffer[] = [];
  const identities = new Set<string>();
  for (const [index, candidate] of input.entries()) {
    if (!isRecord(candidate)) {
      issues.push(\`protocol_offer_invalid:\${index}\`);
      continue;
    }
    for (const key of Object.keys(candidate).sort()) {
      if (!offerFields.has(key)) issues.push(\`protocol_offer_unknown_field:\${key}\`);
    }
    const protocolVersion = candidate.protocolVersion;
    const schemaDigest = candidate.schemaDigest;
    if (
      typeof protocolVersion !== "string" ||
      !protocolVersionPattern.test(protocolVersion) ||
      typeof schemaDigest !== "string" ||
      !digestPattern.test(schemaDigest)
    ) {
      issues.push(\`protocol_offer_invalid:\${index}\`);
      continue;
    }
    const identity = \`\${protocolVersion}:\${schemaDigest}\`;
    if (identities.has(identity)) {
      issues.push("protocol_offer_duplicate");
      continue;
    }
    identities.add(identity);
    offers.push({ protocolVersion, schemaDigest });
  }
  return offers.length === input.length ? offers : null;
}

function readRequestId(value: unknown): string | null {
  return typeof value === "string" && requestIdPattern.test(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
`;
}

export async function loadCompiledContractSources() {
  const actionControlPlane = await importCompiledContractSource(
    "../packages/features/action-control-plane/package.json",
    "@reviewrouter/features-action-control-plane/v2/contract-source",
  );
  const runControl = await importCompiledContractSource(
    "../packages/features/review-run-control/package.json",
    "@reviewrouter/features-review-run-control/contract-source",
  );
  const evidence = await importCompiledContractSource(
    "../packages/features/review-evidence/package.json",
    "@reviewrouter/features-review-evidence/contract-source",
  );
  const contextAttestation = await importCompiledContractSourceFile(
    "../packages/features/review-context-attestation/dist/contract-source/index.js",
  );
  const investigations = await importCompiledContractSource(
    "../packages/features/review-investigations/package.json",
    "@reviewrouter/features-review-investigations/contract-source",
  );
  const investigationOperations = await importCompiledContractSourceFile(
    "../packages/features/review-investigation-operations/dist/contract-source/index.js",
  );
  const executions = await importCompiledContractSource(
    "../packages/features/review-executions/package.json",
    "@reviewrouter/features-review-executions/contract-source",
  );
  const publishing = await importCompiledContractSource(
    "../packages/features/review-publishing/package.json",
    "@reviewrouter/features-review-publishing/v2/contract-source",
  );
  const snapshots = await importCompiledContractSource(
    "../packages/features/review-snapshots/package.json",
    "@reviewrouter/features-review-snapshots/v2/contract-source",
  );
  return {
    negotiationContract: actionControlPlane.reviewActionV2NegotiationContract,
    transportContract: actionControlPlane.reviewActionV2TransportContract,
    publishedContracts: [
      investigationOperations.reviewInvestigationRolloutAuthorizationPublishedContract,
    ],
    semanticFragments: [
      runControl.reviewRunControlActionContractFragment,
      executions.reviewExecutionsActionContractFragment,
      investigations.reviewInvestigationsActionContractFragment,
      contextAttestation.reviewContextAttestationActionContractFragment,
      evidence.reviewEvidenceActionContractFragment,
      snapshots.reviewSnapshotV2ActionContractFragment,
      publishing.reviewPublicationV2ActionContractFragment,
    ],
  };
}

async function importCompiledContractSourceFile(relativePath) {
  return import(new URL(relativePath, import.meta.url).href);
}

async function importCompiledContractSource(packagePath, specifier) {
  const requireFromProducer = createRequire(
    new URL(packagePath, import.meta.url),
  );
  const resolved = requireFromProducer.resolve(specifier);
  return import(pathToFileURL(resolved).href);
}

function findAuthorizeOperation(contract) {
  const operation = contract.operations.find(
    (candidate) => candidate.operationId === "review_run_authorize",
  );
  if (!operation) {
    throw new Error("protocol_contract_authorize_operation_missing");
  }
  return operation;
}

function assertPositiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`protocol_contract_${field}_invalid`);
  }
}

function assertUniqueStrings(values, field) {
  if (
    !Array.isArray(values) ||
    values.some((value) => typeof value !== "string")
  ) {
    throw new Error(`protocol_contract_${field}_invalid`);
  }
  if (new Set(values).size !== values.length) {
    throw new Error(`protocol_contract_${field}_duplicate`);
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function prettyJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

const entrypoint = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : undefined;
if (entrypoint === import.meta.url) {
  await generateReviewActionV2Protocol();
}
