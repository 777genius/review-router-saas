import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { posix as posixPath } from "node:path";

export const CONTRACT_EXPORT_VERSION = 1;
export const LEGACY_RELEASE_MANIFEST_VERSION = 2;
export const RELEASE_MANIFEST_VERSION = 3;
export const PROTOCOL_GENERATION_MANIFEST_FILE = "manifest.json";
export const HANDOFF_MANIFEST_FILE = "handoff-manifest.json";
export const PUBLIC_GENERATED_DIRECTORY =
  "src/control-plane/generated/review-action-v2";
export const PUBLIC_RUNTIME_BUNDLE = "dist/index.js";
export const PUBLIC_CONTEXT_GATEWAY_BUNDLE = "dist/context-gateway.js";
export const PUBLIC_CONTEXT_GATEWAY_RELEASE_METADATA =
  "dist/context-gateway.release.json";
export const LEGACY_CONTEXT_GATEWAY_RELEASE_METADATA_VERSION = 1;
export const CONTEXT_GATEWAY_RELEASE_METADATA_VERSION = 2;
export const REVIEW_INVESTIGATION_RELEASE_CAPABILITY =
  "review_investigation_v1";

const SHA_PATTERN = /^[a-f0-9]{40}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const LEGACY_CONTEXT_GATEWAY_POLICY_VERSION = "context-gateway-v3";
const INVESTIGATION_CONTEXT_GATEWAY_POLICY_VERSION = "context-gateway-v4";
const SUPPORTED_CONTEXT_GATEWAY_POLICY_VERSIONS = Object.freeze([
  LEGACY_CONTEXT_GATEWAY_POLICY_VERSION,
  INVESTIGATION_CONTEXT_GATEWAY_POLICY_VERSION,
]);
const REVIEW_INVESTIGATION_CAPABILITY_FIXTURE = loadCapabilityFixture();

export const REVIEW_INVESTIGATION_RELEASE_COVERAGE_PROFILE_HASH =
  REVIEW_INVESTIGATION_CAPABILITY_FIXTURE.coverageProfileHash;
export const REVIEW_INVESTIGATION_RELEASE_POLICY_HASH =
  REVIEW_INVESTIGATION_CAPABILITY_FIXTURE.policyHash;

export function assertFullCommitSha(value, field) {
  if (typeof value !== "string" || !SHA_PATTERN.test(value)) {
    throw new Error(`${field} must be a lowercase 40-character commit SHA`);
  }
  return value;
}

export function assertSha256Digest(value, field) {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    throw new Error(`${field} must be a lowercase 64-character SHA-256 digest`);
  }
  return value;
}

export function sha256Digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function parseContextGatewayReleaseMetadata(raw) {
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > 4 * 1_024) {
    throw new Error("context gateway release metadata is oversized");
  }
  const label = "context gateway release metadata";
  const value = parseCanonicalJson(raw, label);
  if (!isPlainObject(value)) {
    throw new Error(`${label} must be an object`);
  }
  if (
    value.metadataVersion === LEGACY_CONTEXT_GATEWAY_RELEASE_METADATA_VERSION
  ) {
    const hasSupportedPolicies = Object.prototype.hasOwnProperty.call(
      value,
      "supportedContextGatewayPolicyVersions",
    );
    assertExactKeys(
      value,
      [
        "artifactKind",
        "contextGatewayEntrypointDigest",
        "contextGatewayEntrypointPath",
        "contextGatewayPolicyVersion",
        "metadataVersion",
        ...(hasSupportedPolicies
          ? ["supportedContextGatewayPolicyVersions"]
          : []),
      ],
      label,
    );
    const base = validateContextGatewayReleaseMetadataBase(value, label);
    if (
      base.contextGatewayPolicyVersion !== LEGACY_CONTEXT_GATEWAY_POLICY_VERSION
    ) {
      throw new Error(
        `${label} metadataVersion ${LEGACY_CONTEXT_GATEWAY_RELEASE_METADATA_VERSION} is restricted to ${LEGACY_CONTEXT_GATEWAY_POLICY_VERSION}`,
      );
    }
    const supportedContextGatewayPolicyVersions = hasSupportedPolicies
      ? assertSupportedContextGatewayPolicyVersions(
          value.supportedContextGatewayPolicyVersions,
          base.contextGatewayPolicyVersion,
          `${label}.supportedContextGatewayPolicyVersions`,
        )
      : undefined;
    return Object.freeze({
      ...base,
      ...(supportedContextGatewayPolicyVersions
        ? { supportedContextGatewayPolicyVersions }
        : {}),
    });
  }
  if (value.metadataVersion !== CONTEXT_GATEWAY_RELEASE_METADATA_VERSION) {
    throw new Error(
      `${label} metadataVersion must be ${LEGACY_CONTEXT_GATEWAY_RELEASE_METADATA_VERSION} or ${CONTEXT_GATEWAY_RELEASE_METADATA_VERSION}`,
    );
  }
  assertExactKeys(
    value,
    [
      "artifactKind",
      "contextGatewayEntrypointDigest",
      "contextGatewayEntrypointPath",
      "contextGatewayPolicyVersion",
      "metadataVersion",
      "reviewInvestigationCapability",
      "reviewInvestigationCoverageProfileHash",
      "reviewInvestigationPolicyHash",
      "supportedContextGatewayPolicyVersions",
    ],
    label,
  );
  const base = validateContextGatewayReleaseMetadataBase(value, label);
  if (
    base.contextGatewayPolicyVersion !==
    INVESTIGATION_CONTEXT_GATEWAY_POLICY_VERSION
  ) {
    throw new Error(
      `${label} metadataVersion ${CONTEXT_GATEWAY_RELEASE_METADATA_VERSION} requires ${INVESTIGATION_CONTEXT_GATEWAY_POLICY_VERSION}`,
    );
  }
  const supportedContextGatewayPolicyVersions =
    assertSupportedContextGatewayPolicyVersions(
      value.supportedContextGatewayPolicyVersions,
      base.contextGatewayPolicyVersion,
      `${label}.supportedContextGatewayPolicyVersions`,
      true,
    );
  if (
    value.reviewInvestigationCapability !==
    REVIEW_INVESTIGATION_RELEASE_CAPABILITY
  ) {
    throw new Error(`${label}.reviewInvestigationCapability is invalid`);
  }
  const reviewInvestigationCoverageProfileHash = assertSha256Digest(
    value.reviewInvestigationCoverageProfileHash,
    `${label}.reviewInvestigationCoverageProfileHash`,
  );
  const reviewInvestigationPolicyHash = assertSha256Digest(
    value.reviewInvestigationPolicyHash,
    `${label}.reviewInvestigationPolicyHash`,
  );
  if (
    reviewInvestigationCoverageProfileHash !==
    REVIEW_INVESTIGATION_RELEASE_COVERAGE_PROFILE_HASH
  ) {
    throw new Error(
      `${label}.reviewInvestigationCoverageProfileHash does not match the authoritative fixture`,
    );
  }
  if (
    reviewInvestigationPolicyHash !== REVIEW_INVESTIGATION_RELEASE_POLICY_HASH
  ) {
    throw new Error(
      `${label}.reviewInvestigationPolicyHash does not match the authoritative fixture`,
    );
  }
  return Object.freeze({
    ...base,
    supportedContextGatewayPolicyVersions,
    reviewInvestigationCapability: value.reviewInvestigationCapability,
    reviewInvestigationCoverageProfileHash,
    reviewInvestigationPolicyHash,
  });
}

export function canonicalJson(value) {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

export function parseCanonicalJson(raw, label) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`, {
      cause: error,
    });
  }
  if (canonicalJson(parsed) !== raw) {
    throw new Error(`${label} must use canonical sorted JSON formatting`);
  }
  return parsed;
}

export function validateContractExportDescriptor(value) {
  assertExactKeys(
    value,
    [
      "canonicalizerDigest",
      "contractExportVersion",
      "generatedFileDigests",
      "goldenFixtureDigest",
      "protocolVersion",
      "schemaDigest",
    ],
    "normalized contract export descriptor",
  );
  assertContractMetadata(value, "normalized contract export descriptor");
  return Object.freeze({
    contractExportVersion: value.contractExportVersion,
    protocolVersion: value.protocolVersion,
    schemaDigest: value.schemaDigest,
    canonicalizerDigest: value.canonicalizerDigest,
    goldenFixtureDigest: value.goldenFixtureDigest,
    generatedFileDigests: validateGeneratedFileDigests(
      value.generatedFileDigests,
      "normalized contract export descriptor.generatedFileDigests",
    ),
  });
}

export function parseProtocolGenerationManifest(raw) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `${PROTOCOL_GENERATION_MANIFEST_FILE} is not valid JSON: ${error.message}`,
      { cause: error },
    );
  }
  if (!isPlainObject(value)) {
    throw new Error(`${PROTOCOL_GENERATION_MANIFEST_FILE} must be an object`);
  }
  if (
    typeof value.protocolVersion !== "string" ||
    !/^[1-9][0-9]{0,2}$/.test(value.protocolVersion)
  ) {
    throw new Error(
      `${PROTOCOL_GENERATION_MANIFEST_FILE}.protocolVersion must be a canonical version string`,
    );
  }
  assertSha256Digest(
    value.schemaDigest,
    `${PROTOCOL_GENERATION_MANIFEST_FILE}.schemaDigest`,
  );
  assertSha256Digest(
    value.goldenFixtureDigest,
    `${PROTOCOL_GENERATION_MANIFEST_FILE}.goldenFixtureDigest`,
  );
  if (value.canonicalizerDigest !== undefined) {
    assertSha256Digest(
      value.canonicalizerDigest,
      `${PROTOCOL_GENERATION_MANIFEST_FILE}.canonicalizerDigest`,
    );
  }
  return Object.freeze({
    protocolVersion: value.protocolVersion,
    schemaDigest: value.schemaDigest,
    goldenFixtureDigest: value.goldenFixtureDigest,
    canonicalizerDigest: value.canonicalizerDigest,
  });
}

export function buildHandoffManifest(input) {
  const source = validateContractExportDescriptor(input.contract);
  return Object.freeze({
    contractExportVersion: source.contractExportVersion,
    saasSourceCommit: assertFullCommitSha(
      input.saasSourceCommit,
      "saasSourceCommit",
    ),
    protocolVersion: source.protocolVersion,
    schemaDigest: source.schemaDigest,
    canonicalizerDigest: source.canonicalizerDigest,
    goldenFixtureDigest: source.goldenFixtureDigest,
    generatedFileDigests: source.generatedFileDigests,
    expectedPublicActionBaseCommit: assertFullCommitSha(
      input.expectedPublicActionBaseCommit,
      "expectedPublicActionBaseCommit",
    ),
  });
}

export function parseHandoffManifest(raw) {
  const value = parseCanonicalJson(raw, HANDOFF_MANIFEST_FILE);
  assertExactKeys(
    value,
    [
      "canonicalizerDigest",
      "contractExportVersion",
      "expectedPublicActionBaseCommit",
      "generatedFileDigests",
      "goldenFixtureDigest",
      "protocolVersion",
      "saasSourceCommit",
      "schemaDigest",
    ],
    HANDOFF_MANIFEST_FILE,
  );
  assertContractMetadata(value, HANDOFF_MANIFEST_FILE);
  return Object.freeze({
    contractExportVersion: value.contractExportVersion,
    saasSourceCommit: assertFullCommitSha(
      value.saasSourceCommit,
      `${HANDOFF_MANIFEST_FILE}.saasSourceCommit`,
    ),
    protocolVersion: value.protocolVersion,
    schemaDigest: value.schemaDigest,
    canonicalizerDigest: value.canonicalizerDigest,
    goldenFixtureDigest: value.goldenFixtureDigest,
    generatedFileDigests: validateGeneratedFileDigests(
      value.generatedFileDigests,
      `${HANDOFF_MANIFEST_FILE}.generatedFileDigests`,
    ),
    expectedPublicActionBaseCommit: assertFullCommitSha(
      value.expectedPublicActionBaseCommit,
      `${HANDOFF_MANIFEST_FILE}.expectedPublicActionBaseCommit`,
    ),
  });
}

export function buildReleaseManifest(input) {
  const handoff = parseHandoffManifest(canonicalJson(input.handoffManifest));
  const actionCommitSha = assertFullCommitSha(
    input.actionCommitSha,
    "actionCommitSha",
  );
  if (actionCommitSha === handoff.expectedPublicActionBaseCommit) {
    throw new Error(
      "actionCommitSha must contain the committed handoff and rebuilt runtime bundle",
    );
  }
  const runtimeEntrypointPath = assertSafeRelativePath(
    input.runtimeEntrypointPath,
    "runtimeEntrypointPath",
  );
  const contextGateway = resolveReleaseContextGateway(input);
  const base = {
    releaseManifestVersion:
      contextGateway.metadataVersion ===
      CONTEXT_GATEWAY_RELEASE_METADATA_VERSION
        ? RELEASE_MANIFEST_VERSION
        : LEGACY_RELEASE_MANIFEST_VERSION,
    distributionKind: "PublicReusable",
    saasSourceCommit: handoff.saasSourceCommit,
    actionCommitSha,
    runtimeCommitSha: actionCommitSha,
    expectedPublicActionBaseCommit: handoff.expectedPublicActionBaseCommit,
    contractExportVersion: handoff.contractExportVersion,
    protocolVersion: handoff.protocolVersion,
    schemaDigest: handoff.schemaDigest,
    canonicalizerDigest: handoff.canonicalizerDigest,
    goldenFixtureDigest: handoff.goldenFixtureDigest,
    generatedFileDigests: handoff.generatedFileDigests,
    handoffManifestDigest: assertSha256Digest(
      input.handoffManifestDigest,
      "handoffManifestDigest",
    ),
    runtimeEntrypointPath,
    runtimeEntrypointDigest: assertSha256Digest(
      input.runtimeEntrypointDigest,
      "runtimeEntrypointDigest",
    ),
    contextGatewayPolicyVersion: contextGateway.contextGatewayPolicyVersion,
    contextGatewayEntrypointPath: contextGateway.contextGatewayEntrypointPath,
    contextGatewayEntrypointDigest:
      contextGateway.contextGatewayEntrypointDigest,
  };
  if (
    contextGateway.metadataVersion === CONTEXT_GATEWAY_RELEASE_METADATA_VERSION
  ) {
    return Object.freeze({
      ...base,
      supportedContextGatewayPolicyVersions:
        contextGateway.supportedContextGatewayPolicyVersions,
      reviewInvestigationCapability:
        contextGateway.reviewInvestigationCapability,
      reviewInvestigationCoverageProfileHash:
        contextGateway.reviewInvestigationCoverageProfileHash,
      reviewInvestigationPolicyHash:
        contextGateway.reviewInvestigationPolicyHash,
    });
  }
  return Object.freeze(base);
}

export function parseReleaseManifest(raw) {
  const label = "release manifest";
  const value = parseCanonicalJson(raw, label);
  if (!isPlainObject(value)) {
    throw new Error(`${label} must be an object`);
  }
  const legacy =
    value.releaseManifestVersion === LEGACY_RELEASE_MANIFEST_VERSION;
  const investigation =
    value.releaseManifestVersion === RELEASE_MANIFEST_VERSION;
  if (!legacy && !investigation) {
    throw new Error(
      `${label} releaseManifestVersion must be ${LEGACY_RELEASE_MANIFEST_VERSION} or ${RELEASE_MANIFEST_VERSION}`,
    );
  }
  assertExactKeys(
    value,
    [
      "actionCommitSha",
      "canonicalizerDigest",
      "contextGatewayEntrypointDigest",
      "contextGatewayEntrypointPath",
      "contextGatewayPolicyVersion",
      "contractExportVersion",
      "distributionKind",
      "expectedPublicActionBaseCommit",
      "generatedFileDigests",
      "goldenFixtureDigest",
      "handoffManifestDigest",
      "protocolVersion",
      "releaseManifestVersion",
      "runtimeCommitSha",
      "runtimeEntrypointDigest",
      "runtimeEntrypointPath",
      "saasSourceCommit",
      "schemaDigest",
      ...(investigation
        ? [
            "reviewInvestigationCapability",
            "reviewInvestigationCoverageProfileHash",
            "reviewInvestigationPolicyHash",
            "supportedContextGatewayPolicyVersions",
          ]
        : []),
    ],
    label,
  );
  if (value.distributionKind !== "PublicReusable") {
    throw new Error("release manifest distributionKind must be PublicReusable");
  }
  const handoff = parseHandoffManifest(
    canonicalJson({
      contractExportVersion: value.contractExportVersion,
      saasSourceCommit: value.saasSourceCommit,
      protocolVersion: value.protocolVersion,
      schemaDigest: value.schemaDigest,
      canonicalizerDigest: value.canonicalizerDigest,
      goldenFixtureDigest: value.goldenFixtureDigest,
      generatedFileDigests: value.generatedFileDigests,
      expectedPublicActionBaseCommit: value.expectedPublicActionBaseCommit,
    }),
  );
  const actionCommitSha = assertFullCommitSha(
    value.actionCommitSha,
    `${label}.actionCommitSha`,
  );
  const runtimeCommitSha = assertFullCommitSha(
    value.runtimeCommitSha,
    `${label}.runtimeCommitSha`,
  );
  if (runtimeCommitSha !== actionCommitSha) {
    throw new Error(
      "release manifest runtimeCommitSha must equal actionCommitSha for PublicReusable",
    );
  }
  const contextGatewayPolicyVersion = assertIdentifier(
    value.contextGatewayPolicyVersion,
    `${label}.contextGatewayPolicyVersion`,
  );
  if (
    legacy &&
    contextGatewayPolicyVersion !== LEGACY_CONTEXT_GATEWAY_POLICY_VERSION
  ) {
    throw new Error(
      `${label} version ${LEGACY_RELEASE_MANIFEST_VERSION} is restricted to ${LEGACY_CONTEXT_GATEWAY_POLICY_VERSION} and cannot claim investigation capability`,
    );
  }
  if (
    investigation &&
    contextGatewayPolicyVersion !== INVESTIGATION_CONTEXT_GATEWAY_POLICY_VERSION
  ) {
    throw new Error(
      `${label} version ${RELEASE_MANIFEST_VERSION} requires ${INVESTIGATION_CONTEXT_GATEWAY_POLICY_VERSION}`,
    );
  }
  const base = {
    releaseManifestVersion: value.releaseManifestVersion,
    distributionKind: value.distributionKind,
    saasSourceCommit: handoff.saasSourceCommit,
    actionCommitSha,
    runtimeCommitSha,
    expectedPublicActionBaseCommit: handoff.expectedPublicActionBaseCommit,
    contractExportVersion: handoff.contractExportVersion,
    protocolVersion: handoff.protocolVersion,
    schemaDigest: handoff.schemaDigest,
    canonicalizerDigest: handoff.canonicalizerDigest,
    goldenFixtureDigest: handoff.goldenFixtureDigest,
    generatedFileDigests: handoff.generatedFileDigests,
    handoffManifestDigest: assertSha256Digest(
      value.handoffManifestDigest,
      `${label}.handoffManifestDigest`,
    ),
    runtimeEntrypointPath: assertSafeRelativePath(
      value.runtimeEntrypointPath,
      `${label}.runtimeEntrypointPath`,
    ),
    runtimeEntrypointDigest: assertSha256Digest(
      value.runtimeEntrypointDigest,
      `${label}.runtimeEntrypointDigest`,
    ),
    contextGatewayPolicyVersion,
    contextGatewayEntrypointPath: assertSafeRelativePath(
      value.contextGatewayEntrypointPath,
      `${label}.contextGatewayEntrypointPath`,
    ),
    contextGatewayEntrypointDigest: assertSha256Digest(
      value.contextGatewayEntrypointDigest,
      `${label}.contextGatewayEntrypointDigest`,
    ),
  };
  if (legacy) return Object.freeze(base);

  const supportedContextGatewayPolicyVersions =
    assertSupportedContextGatewayPolicyVersions(
      value.supportedContextGatewayPolicyVersions,
      contextGatewayPolicyVersion,
      `${label}.supportedContextGatewayPolicyVersions`,
      true,
    );
  if (
    value.reviewInvestigationCapability !==
    REVIEW_INVESTIGATION_RELEASE_CAPABILITY
  ) {
    throw new Error(`${label}.reviewInvestigationCapability is invalid`);
  }
  const reviewInvestigationCoverageProfileHash = assertSha256Digest(
    value.reviewInvestigationCoverageProfileHash,
    `${label}.reviewInvestigationCoverageProfileHash`,
  );
  const reviewInvestigationPolicyHash = assertSha256Digest(
    value.reviewInvestigationPolicyHash,
    `${label}.reviewInvestigationPolicyHash`,
  );
  if (
    reviewInvestigationCoverageProfileHash !==
      REVIEW_INVESTIGATION_RELEASE_COVERAGE_PROFILE_HASH ||
    reviewInvestigationPolicyHash !== REVIEW_INVESTIGATION_RELEASE_POLICY_HASH
  ) {
    throw new Error(
      `${label} investigation hashes do not match the authoritative fixture`,
    );
  }
  return Object.freeze({
    ...base,
    supportedContextGatewayPolicyVersions,
    reviewInvestigationCapability: value.reviewInvestigationCapability,
    reviewInvestigationCoverageProfileHash,
    reviewInvestigationPolicyHash,
  });
}

export function buildReleaseRegistrationCandidateFields(input) {
  const manifest = parseReleaseManifest(canonicalJson(input));
  return Object.freeze({
    distributionKind: "public_reusable",
    actionCommitSha: manifest.actionCommitSha,
    runtimeCommitSha: manifest.runtimeCommitSha,
    wrapperEntrypointDigest: null,
    runtimeEntrypointDigest: manifest.runtimeEntrypointDigest,
    contextGatewayPolicyVersion: manifest.contextGatewayPolicyVersion,
    contextGatewayEntrypointDigest: manifest.contextGatewayEntrypointDigest,
    reviewInvestigationProfile:
      manifest.releaseManifestVersion === RELEASE_MANIFEST_VERSION
        ? Object.freeze({
            capability: manifest.reviewInvestigationCapability,
            coverageProfileHash:
              manifest.reviewInvestigationCoverageProfileHash,
            policyHash: manifest.reviewInvestigationPolicyHash,
          })
        : null,
    schemaDigest: manifest.schemaDigest,
    canonicalizerDigest: manifest.canonicalizerDigest,
  });
}

export function assertIdentifier(value, field) {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(value)
  ) {
    throw new Error(`${field} must be a valid identifier`);
  }
  return value;
}

export function assertSafeRelativePath(value, field) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\\") ||
    value.includes("\0") ||
    posixPath.isAbsolute(value) ||
    posixPath.normalize(value) !== value ||
    value === "." ||
    value.startsWith("../") ||
    value.includes("/../")
  ) {
    throw new Error(`${field} must be a normalized relative POSIX path`);
  }
  return value;
}

function validateContextGatewayReleaseMetadataBase(value, label) {
  if (value.artifactKind !== "reviewrouter-context-gateway") {
    throw new Error(`${label} artifactKind is invalid`);
  }
  return Object.freeze({
    artifactKind: value.artifactKind,
    contextGatewayEntrypointDigest: assertSha256Digest(
      value.contextGatewayEntrypointDigest,
      `${label}.contextGatewayEntrypointDigest`,
    ),
    contextGatewayEntrypointPath: assertSafeRelativePath(
      value.contextGatewayEntrypointPath,
      `${label}.contextGatewayEntrypointPath`,
    ),
    contextGatewayPolicyVersion: assertIdentifier(
      value.contextGatewayPolicyVersion,
      `${label}.contextGatewayPolicyVersion`,
    ),
    metadataVersion: value.metadataVersion,
  });
}

function assertSupportedContextGatewayPolicyVersions(
  value,
  primaryPolicyVersion,
  field,
  requireCompletePair = false,
) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) {
    throw new Error(`${field} must be a bounded policy array`);
  }
  const policies = value.map((policy, index) =>
    assertIdentifier(policy, `${field}[${index}]`),
  );
  if (
    new Set(policies).size !== policies.length ||
    policies.some(
      (policy) => !SUPPORTED_CONTEXT_GATEWAY_POLICY_VERSIONS.includes(policy),
    ) ||
    !policies.includes(primaryPolicyVersion)
  ) {
    throw new Error(`${field} is invalid`);
  }
  const canonicalPolicies = SUPPORTED_CONTEXT_GATEWAY_POLICY_VERSIONS.filter(
    (policy) => policies.includes(policy),
  );
  if (
    JSON.stringify(policies) !== JSON.stringify(canonicalPolicies) ||
    (requireCompletePair &&
      JSON.stringify(policies) !==
        JSON.stringify(SUPPORTED_CONTEXT_GATEWAY_POLICY_VERSIONS))
  ) {
    throw new Error(`${field} must use the authenticated canonical policy set`);
  }
  return Object.freeze([...policies]);
}

function resolveReleaseContextGateway(input) {
  const legacyFields = [
    "contextGatewayEntrypointDigest",
    "contextGatewayEntrypointPath",
    "contextGatewayPolicyVersion",
  ];
  if (input.contextGatewayReleaseMetadata !== undefined) {
    if (legacyFields.some((field) => input[field] !== undefined)) {
      throw new Error(
        "contextGatewayReleaseMetadata cannot be combined with legacy context gateway fields",
      );
    }
    return parseContextGatewayReleaseMetadata(
      canonicalJson(input.contextGatewayReleaseMetadata),
    );
  }
  const contextGatewayPolicyVersion = assertIdentifier(
    input.contextGatewayPolicyVersion,
    "contextGatewayPolicyVersion",
  );
  if (contextGatewayPolicyVersion !== LEGACY_CONTEXT_GATEWAY_POLICY_VERSION) {
    throw new Error(
      `investigation releases require authenticated contextGatewayReleaseMetadata version ${CONTEXT_GATEWAY_RELEASE_METADATA_VERSION}`,
    );
  }
  return Object.freeze({
    metadataVersion: LEGACY_CONTEXT_GATEWAY_RELEASE_METADATA_VERSION,
    contextGatewayPolicyVersion,
    contextGatewayEntrypointPath: assertSafeRelativePath(
      input.contextGatewayEntrypointPath,
      "contextGatewayEntrypointPath",
    ),
    contextGatewayEntrypointDigest: assertSha256Digest(
      input.contextGatewayEntrypointDigest,
      "contextGatewayEntrypointDigest",
    ),
  });
}

function loadCapabilityFixture() {
  const path = new URL(
    "../fixtures/review-action-v2-release/review-investigation-capability-v1.golden.json",
    import.meta.url,
  );
  const raw = readFileSync(path, "utf8");
  if (Buffer.byteLength(raw, "utf8") > 16 * 1_024) {
    throw new Error("review investigation capability fixture is oversized");
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `review investigation capability fixture is invalid: ${error.message}`,
      {
        cause: error,
      },
    );
  }
  assertExactKeys(value, ["coverageProfile", "policy"], "capability fixture");
  if (
    !isPlainObject(value.coverageProfile?.value) ||
    value.coverageProfile.value.gatewayPolicyVersion !==
      INVESTIGATION_CONTEXT_GATEWAY_POLICY_VERSION
  ) {
    throw new Error("capability fixture gateway policy is invalid");
  }
  return Object.freeze({
    coverageProfileHash: readCapabilityFixtureHash(
      value.coverageProfile,
      "coverageProfile",
    ),
    policyHash: readCapabilityFixtureHash(value.policy, "policy"),
  });
}

function readCapabilityFixtureHash(value, field) {
  assertExactKeys(
    value,
    ["canonicalJson", "sha256", "value"],
    `capability fixture.${field}`,
  );
  if (typeof value.canonicalJson !== "string") {
    throw new Error(`capability fixture.${field}.canonicalJson is invalid`);
  }
  const canonical = compactCanonicalJson(value.value);
  const digest = assertSha256Digest(
    value.sha256,
    `capability fixture.${field}.sha256`,
  );
  if (canonical !== value.canonicalJson || sha256Digest(canonical) !== digest) {
    throw new Error(`capability fixture.${field} hash is invalid`);
  }
  return digest;
}

function compactCanonicalJson(value) {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(compactCanonicalJson).join(",")}]`;
  }
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${compactCanonicalJson(value[key])}`,
      )
      .join(",")}}`;
  }
  throw new Error("capability fixture contains an unsupported value");
}

function assertContractMetadata(value, label) {
  if (value.contractExportVersion !== CONTRACT_EXPORT_VERSION) {
    throw new Error(
      `${label}.contractExportVersion must be ${CONTRACT_EXPORT_VERSION}`,
    );
  }
  if (
    typeof value.protocolVersion !== "string" ||
    !/^[1-9][0-9]{0,2}$/.test(value.protocolVersion)
  ) {
    throw new Error(
      `${label}.protocolVersion must be a canonical version string`,
    );
  }
  assertSha256Digest(value.schemaDigest, `${label}.schemaDigest`);
  assertSha256Digest(value.canonicalizerDigest, `${label}.canonicalizerDigest`);
  assertSha256Digest(value.goldenFixtureDigest, `${label}.goldenFixtureDigest`);
}

function validateGeneratedFileDigests(value, label) {
  if (!isPlainObject(value) || Object.keys(value).length === 0) {
    throw new Error(`${label} must be a non-empty object`);
  }
  const validated = {};
  for (const file of Object.keys(value).sort()) {
    assertSafeRelativePath(file, `${label} file`);
    if (file === HANDOFF_MANIFEST_FILE) {
      throw new Error(`${label} contains reserved file ${file}`);
    }
    validated[file] = assertSha256Digest(value[file], `${label}.${file}`);
  }
  return Object.freeze(validated);
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (isPlainObject(value)) {
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = canonicalize(value[key]);
    }
    return sorted;
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  throw new Error("canonical JSON contains an unsupported value");
}

function assertExactKeys(value, expectedKeys, label) {
  if (!isPlainObject(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error(`${label} fields must be exactly: ${expected.join(", ")}`);
  }
}

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}
