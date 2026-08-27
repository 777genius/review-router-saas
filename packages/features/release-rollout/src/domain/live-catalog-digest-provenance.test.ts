import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { canonicalJson } from "./canonical-json";
import { validateLiveCatalogDigestProvenance } from "./live-catalog-digest-provenance";
import { liveV70V86CatalogDigestProvenanceCanonicalSha256 } from "./live-catalog-digest-provenance-trust";
import provenance from "./live-v70-v86-catalog-digest-provenance.json" with { type: "json" };

const provenancePath =
  "packages/features/release-rollout/src/domain/live-v70-v86-catalog-digest-provenance.json";
const adapterPath =
  "packages/features/release-rollout/src/adapters/live-v70-v72-catalog-digest.mjs";

const sha256 = (value: string | Buffer) =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;

const securityBindings = [
  "schemaVersion",
  "sourceCommitSha",
  "run.id",
  "run.attempt",
  "job.id",
  "job.name",
  "artifact.id",
  "artifact.name",
  "artifact.candidateBytes",
  "artifact.candidateSha256",
  "postgres.image",
  "workflow.path",
  "workflow.bytes",
  "workflow.sha256",
  "projection.id",
  "projection.bytes",
  "projection.sha256",
  "observation.observedAt",
  "observation.catalogDigestSha256",
  "captureLog.name",
  "captureLog.bytes",
  "captureLog.sha256",
  "captureLog.startedAt",
  "captureLog.completedAt",
  "captureLog.observationLine",
  "captureLog.observationLineBytes",
  "captureLog.observationLineSha256",
] as const;

function mutate(path: string): unknown {
  const changed = structuredClone(provenance) as unknown as Record<
    string,
    unknown
  >;
  const segments = path.split(".");
  const field = segments.pop()!;
  let parent = changed;
  for (const segment of segments)
    parent = parent[segment] as Record<string, unknown>;
  const value = parent[field];
  parent[field] =
    typeof value === "number" ? value + 1 : `${String(value)}-tampered`;
  return changed;
}

describe("live V70-V86 catalog digest provenance", () => {
  it("accepts the exact canonical, independently hash-pinned evidence", () => {
    const validated = validateLiveCatalogDigestProvenance(
      provenance,
      liveV70V86CatalogDigestProvenanceCanonicalSha256,
    );
    expect(validated.observation.catalogDigestSha256).toBe(
      "sha256:1263f5c7c12179382cecf46ee434d530ede3763bbb0b9e43e658a352029f8961",
    );
    expect(Object.isFrozen(validated)).toBe(true);
    expect(Object.isFrozen(validated.captureLog)).toBe(true);
  });

  it.each(securityBindings)("rejects tampering with %s", (binding) => {
    expect(() =>
      validateLiveCatalogDigestProvenance(
        mutate(binding),
        liveV70V86CatalogDigestProvenanceCanonicalSha256,
      ),
    ).toThrow(/live_catalog_digest_provenance_/u);
  });

  it("rejects missing, additional, and self-consistently re-hashed evidence", () => {
    const missing = structuredClone(provenance) as unknown as Record<
      string,
      unknown
    >;
    delete missing.captureLog;
    expect(() =>
      validateLiveCatalogDigestProvenance(
        missing,
        liveV70V86CatalogDigestProvenanceCanonicalSha256,
      ),
    ).toThrow("live_catalog_digest_provenance_root_shape_invalid");

    expect(() =>
      validateLiveCatalogDigestProvenance(
        { ...provenance, untrusted: true },
        liveV70V86CatalogDigestProvenanceCanonicalSha256,
      ),
    ).toThrow("live_catalog_digest_provenance_root_shape_invalid");

    const changed = structuredClone(provenance);
    const replacementDigest = `sha256:${"0".repeat(64)}`;
    changed.captureLog.observationLine =
      changed.captureLog.observationLine.replace(
        changed.observation.catalogDigestSha256,
        replacementDigest,
      );
    changed.captureLog.observationLineSha256 = sha256(
      changed.captureLog.observationLine,
    );
    changed.observation.catalogDigestSha256 = replacementDigest;
    expect(sha256(canonicalJson(changed))).not.toBe(
      liveV70V86CatalogDigestProvenanceCanonicalSha256,
    );
    expect(() =>
      validateLiveCatalogDigestProvenance(
        changed,
        liveV70V86CatalogDigestProvenanceCanonicalSha256,
      ),
    ).toThrow("live_catalog_digest_provenance_canonical_hash_mismatch");

    expect(() =>
      validateLiveCatalogDigestProvenance(provenance, "sha256:bad"),
    ).toThrow("live_catalog_digest_provenance_trust_root_invalid");
  });

  it("binds the checked-in canonical bytes, workflow, and projection source bytes", () => {
    const provenanceBytes = readFileSync(provenancePath, "utf8");
    expect(provenanceBytes).toBe(`${canonicalJson(provenance)}\n`);
    expect(sha256(canonicalJson(provenance))).toBe(
      liveV70V86CatalogDigestProvenanceCanonicalSha256,
    );

    const workflowBytes = readFileSync(provenance.workflow.path);
    expect(workflowBytes.byteLength).toBe(provenance.workflow.bytes);
    expect(sha256(workflowBytes)).toBe(provenance.workflow.sha256);

    const adapterSource = readFileSync(adapterPath, "utf8");
    const templateStart = adapterSource.indexOf(
      "`\n",
      adapterSource.indexOf(provenance.projection.id),
    );
    const templateEnd = adapterSource.indexOf("`;", templateStart + 2);
    expect(templateStart).toBeGreaterThan(0);
    expect(templateEnd).toBeGreaterThan(templateStart);
    const projectionSourceBytes = adapterSource.slice(
      templateStart + 1,
      templateEnd,
    );
    expect(Buffer.byteLength(projectionSourceBytes)).toBe(
      provenance.projection.bytes,
    );
    expect(sha256(projectionSourceBytes)).toBe(provenance.projection.sha256);
  });
});
