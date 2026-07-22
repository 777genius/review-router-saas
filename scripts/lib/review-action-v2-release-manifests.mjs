import { createHash } from "node:crypto";
import { posix as posixPath } from "node:path";

export const CONTRACT_EXPORT_VERSION = 1;
export const RELEASE_MANIFEST_VERSION = 1;
export const PROTOCOL_GENERATION_MANIFEST_FILE = "manifest.json";
export const HANDOFF_MANIFEST_FILE = "handoff-manifest.json";
export const PUBLIC_GENERATED_DIRECTORY =
  "src/control-plane/generated/review-action-v2";
export const PUBLIC_RUNTIME_BUNDLE = "dist/index.js";

const SHA_PATTERN = /^[a-f0-9]{40}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;

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
  return Object.freeze({
    releaseManifestVersion: RELEASE_MANIFEST_VERSION,
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
  });
}

export function parseReleaseManifest(raw) {
  const label = "release manifest";
  const value = parseCanonicalJson(raw, label);
  assertExactKeys(
    value,
    [
      "actionCommitSha",
      "canonicalizerDigest",
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
    ],
    label,
  );
  if (value.releaseManifestVersion !== RELEASE_MANIFEST_VERSION) {
    throw new Error(
      `release manifest releaseManifestVersion must be ${RELEASE_MANIFEST_VERSION}`,
    );
  }
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
  return Object.freeze({
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
  });
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
