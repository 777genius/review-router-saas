#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { normalizePrivatePg17ActivationCatalogPolicyArtifactCandidate } from "./capture-private-pg17-activation-catalog-policy.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const canonicalJson = (value) => `${JSON.stringify(value, null, 2)}\n`;

function exactKeys(value, keys) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify([...keys].sort())
  );
}

export function packageLiveCatalogCaptureEvidence(firstBytes, secondBytes) {
  let captures;
  try {
    captures = [firstBytes, secondBytes].map((bytes) =>
      JSON.parse(Buffer.from(bytes).toString("utf8")),
    );
  } catch {
    throw new Error("live_catalog_capture_result_not_json");
  }
  const candidates = captures.map((capture) => {
    if (!exactKeys(capture, ["candidate", "observation"]))
      throw new Error("live_catalog_capture_result_shape_invalid");
    return normalizePrivatePg17ActivationCatalogPolicyArtifactCandidate(
      capture.candidate,
    );
  });
  const candidateBytes = candidates.map((candidate) =>
    Buffer.from(JSON.stringify(candidate)),
  );
  if (!candidateBytes[0].equals(candidateBytes[1]))
    throw new Error("live_catalog_capture_candidates_differ");
  const observations = captures.map(({ observation }, index) => {
    if (
      !exactKeys(observation, [
        "kind",
        "version",
        "disposableDatabaseIdentity",
        "observedCatalogDigest",
        "receiptCatalogDigest",
        "projectionPath",
        "projectionExport",
        "projectionSqlSha256",
      ]) ||
      observation.kind !== "reviewrouter-live-catalog-successful-capture" ||
      observation.version !== 1 ||
      !/^rr-disposable-[a-z0-9][a-z0-9._-]{7,127}$/u.test(
        observation.disposableDatabaseIdentity ?? "",
      ) ||
      !observation.disposableDatabaseIdentity.endsWith(
        index === 0 ? "-a" : "-b",
      ) ||
      !/^sha256:[a-f0-9]{64}$/u.test(observation.observedCatalogDigest ?? "") ||
      observation.receiptCatalogDigest !== observation.observedCatalogDigest ||
      observation.projectionPath !==
        "packages/features/release-rollout/src/adapters/live-v70-v72-catalog-digest.mjs" ||
      observation.projectionExport !== "fencedLiveV70V73CatalogDigestSql" ||
      !/^[a-f0-9]{64}$/u.test(observation.projectionSqlSha256 ?? "")
    )
      throw new Error("live_catalog_capture_observation_invalid");
    return observation;
  });
  if (
    observations[0].observedCatalogDigest !==
      observations[1].observedCatalogDigest ||
    observations[0].projectionSqlSha256 !== observations[1].projectionSqlSha256
  )
    throw new Error("live_catalog_capture_observations_differ");
  const evidence = {
    kind: "reviewrouter-live-catalog-successful-capture-evidence",
    version: 1,
    observedCatalogDigest: observations[0].observedCatalogDigest,
    projection: {
      path: observations[0].projectionPath,
      export: observations[0].projectionExport,
      sqlSha256: observations[0].projectionSqlSha256,
    },
    inputs: observations.map((observation, index) => ({
      disposableDatabaseIdentity: observation.disposableDatabaseIdentity,
      candidateName: `activation-catalog-policy-candidate-${index + 1}.json`,
      candidateSize: candidateBytes[index].length,
      candidateSha256: sha256(candidateBytes[index]),
      receiptCatalogDigest: observation.receiptCatalogDigest,
    })),
  };
  return Object.freeze({
    candidateBytes,
    evidence: Buffer.from(canonicalJson(evidence)),
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  if (process.argv.length !== 4)
    throw new Error(
      "usage: package-live-catalog-capture-evidence.mjs <first> <second>",
    );
  const packaged = packageLiveCatalogCaptureEvidence(
    readFileSync(process.argv[2]),
    readFileSync(process.argv[3]),
  );
  packaged.candidateBytes.forEach((bytes, index) =>
    writeFileSync(
      `activation-catalog-policy-candidate-${index + 1}.json`,
      bytes,
      {
        flag: "wx",
        mode: 0o600,
      },
    ),
  );
  writeFileSync(
    "live-catalog-successful-capture-evidence.json",
    packaged.evidence,
    {
      flag: "wx",
      mode: 0o600,
    },
  );
}
