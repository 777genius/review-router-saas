import { createHash } from "node:crypto";

import { canonicalJson } from "./canonical-json";

const sha256 = /^sha256:[a-f0-9]{64}$/u;
const commitSha = /^[a-f0-9]{40}$/u;
const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u;

export interface LiveCatalogDigestProvenanceV1 {
  readonly schemaVersion: "reviewrouter.live-catalog-digest-provenance.v1";
  readonly sourceCommitSha: string;
  readonly run: Readonly<{ id: number; attempt: number }>;
  readonly job: Readonly<{ id: number; name: string }>;
  readonly artifact: Readonly<{
    id: number;
    name: string;
    candidateBytes: number;
    candidateSha256: string;
  }>;
  readonly postgres: Readonly<{ image: string }>;
  readonly workflow: Readonly<{ path: string; bytes: number; sha256: string }>;
  readonly projection: Readonly<{ id: string; bytes: number; sha256: string }>;
  readonly observation: Readonly<{
    observedAt: string;
    catalogDigestSha256: string;
  }>;
  readonly captureLog: Readonly<{
    name: string;
    bytes: number;
    sha256: string;
    startedAt: string;
    completedAt: string;
    observationLine: string;
    observationLineBytes: number;
    observationLineSha256: string;
  }>;
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error(`live_catalog_digest_provenance_${field}_invalid`);
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  field: string,
  keys: readonly string[],
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, i) => key !== expected[i])
  )
    throw new Error(`live_catalog_digest_provenance_${field}_shape_invalid`);
}

function stringField(
  value: Record<string, unknown>,
  field: string,
  pattern?: RegExp,
): string {
  const found = value[field];
  if (
    typeof found !== "string" ||
    found.length === 0 ||
    (pattern && !pattern.test(found))
  )
    throw new Error(`live_catalog_digest_provenance_${field}_invalid`);
  return found;
}

function integerField(value: Record<string, unknown>, field: string): number {
  const found = value[field];
  if (!Number.isSafeInteger(found) || (found as number) <= 0)
    throw new Error(`live_catalog_digest_provenance_${field}_invalid`);
  return found as number;
}

function sha256Utf8(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>))
      deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function validateLiveCatalogDigestProvenance(
  input: unknown,
  expectedCanonicalSha256: string,
): LiveCatalogDigestProvenanceV1 {
  if (!sha256.test(expectedCanonicalSha256))
    throw new Error("live_catalog_digest_provenance_trust_root_invalid");

  const root = record(input, "root");
  exactKeys(root, "root", [
    "artifact",
    "captureLog",
    "job",
    "observation",
    "postgres",
    "projection",
    "run",
    "schemaVersion",
    "sourceCommitSha",
    "workflow",
  ]);
  if (root.schemaVersion !== "reviewrouter.live-catalog-digest-provenance.v1")
    throw new Error("live_catalog_digest_provenance_schema_version_invalid");
  const sourceCommitSha = stringField(root, "sourceCommitSha", commitSha);

  const run = record(root.run, "run");
  exactKeys(run, "run", ["attempt", "id"]);
  integerField(run, "id");
  const runAttempt = integerField(run, "attempt");

  const job = record(root.job, "job");
  exactKeys(job, "job", ["id", "name"]);
  integerField(job, "id");
  stringField(job, "name");

  const artifact = record(root.artifact, "artifact");
  exactKeys(artifact, "artifact", [
    "candidateBytes",
    "candidateSha256",
    "id",
    "name",
  ]);
  integerField(artifact, "id");
  integerField(artifact, "candidateBytes");
  stringField(artifact, "candidateSha256", sha256);
  const artifactName = stringField(artifact, "name");
  if (
    artifactName !==
    `activation-catalog-policy-${sourceCommitSha}-${runAttempt}`
  )
    throw new Error(
      "live_catalog_digest_provenance_artifact_identity_mismatch",
    );

  const postgres = record(root.postgres, "postgres");
  exactKeys(postgres, "postgres", ["image"]);
  stringField(
    postgres,
    "image",
    /^postgres:17\.5-bookworm@sha256:[a-f0-9]{64}$/u,
  );

  const workflow = record(root.workflow, "workflow");
  exactKeys(workflow, "workflow", ["bytes", "path", "sha256"]);
  integerField(workflow, "bytes");
  if (stringField(workflow, "path") !== ".github/workflows/ci.yml")
    throw new Error("live_catalog_digest_provenance_workflow_path_invalid");
  stringField(workflow, "sha256", sha256);

  const projection = record(root.projection, "projection");
  exactKeys(projection, "projection", ["bytes", "id", "sha256"]);
  integerField(projection, "bytes");
  if (stringField(projection, "id") !== "fencedLiveV70V86CatalogDigestSql")
    throw new Error("live_catalog_digest_provenance_projection_id_invalid");
  stringField(projection, "sha256", sha256);

  const observation = record(root.observation, "observation");
  exactKeys(observation, "observation", ["catalogDigestSha256", "observedAt"]);
  const observedDigest = stringField(
    observation,
    "catalogDigestSha256",
    sha256,
  );
  stringField(observation, "observedAt", timestamp);

  const captureLog = record(root.captureLog, "capture_log");
  exactKeys(captureLog, "capture_log", [
    "bytes",
    "completedAt",
    "name",
    "observationLine",
    "observationLineBytes",
    "observationLineSha256",
    "sha256",
    "startedAt",
  ]);
  integerField(captureLog, "bytes");
  stringField(captureLog, "sha256", sha256);
  stringField(captureLog, "startedAt", timestamp);
  stringField(captureLog, "completedAt", timestamp);
  const observationLine = stringField(captureLog, "observationLine");
  if (
    integerField(captureLog, "observationLineBytes") !==
      Buffer.byteLength(observationLine, "utf8") ||
    stringField(captureLog, "observationLineSha256", sha256) !==
      sha256Utf8(observationLine) ||
    !observationLine.includes(`observed=${observedDigest}`)
  )
    throw new Error("live_catalog_digest_provenance_observation_line_mismatch");
  if (stringField(captureLog, "name") !== `quality-job-${String(job.id)}.log`)
    throw new Error(
      "live_catalog_digest_provenance_capture_log_identity_mismatch",
    );

  const canonicalSha256 = sha256Utf8(canonicalJson(root));
  if (canonicalSha256 !== expectedCanonicalSha256)
    throw new Error("live_catalog_digest_provenance_canonical_hash_mismatch");

  // The hash check above authenticates every field; freezing prevents mutation after use.
  return deepFreeze(root) as unknown as LiveCatalogDigestProvenanceV1;
}
