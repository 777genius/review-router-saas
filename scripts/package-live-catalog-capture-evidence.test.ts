import { describe, expect, it } from "vitest";
import { packageLiveCatalogCaptureEvidence } from "./package-live-catalog-capture-evidence.mjs";
import {
  testCandidate,
  testConfiguredDigest,
  testProjectionBytes,
} from "./lib/live-catalog-attestation-test-fixtures.mjs";
import { sha256Hex } from "./lib/live-catalog-attestation-domain.mjs";

const candidate = JSON.parse(testCandidate.toString("utf8"));
const capture = (suffix: "a" | "b") =>
  Buffer.from(
    JSON.stringify({
      candidate,
      observation: {
        kind: "reviewrouter-live-catalog-successful-capture",
        version: 1,
        disposableDatabaseIdentity: `rr-disposable-1001-1-${suffix}`,
        observedCatalogDigest: testConfiguredDigest,
        receiptCatalogDigest: testConfiguredDigest,
        projectionPath:
          "packages/features/release-rollout/src/adapters/live-v70-v72-catalog-digest.mjs",
        projectionExport: "fencedLiveV70V73CatalogDigestSql",
        projectionSqlSha256: sha256Hex(testProjectionBytes),
      },
    }),
  );

describe("successful live catalog capture packager", () => {
  it("binds both successful database inputs to byte-identical candidates", () => {
    const packaged = packageLiveCatalogCaptureEvidence(
      capture("a"),
      capture("b"),
    );
    expect(packaged.candidateBytes[0]).toEqual(packaged.candidateBytes[1]);
    const evidence = JSON.parse(packaged.evidence.toString("utf8"));
    expect(evidence.observedCatalogDigest).toBe(testConfiguredDigest);
    expect(evidence.inputs.map((input: any) => input.candidateSha256)).toEqual([
      sha256Hex(packaged.candidateBytes[0]),
      sha256Hex(packaged.candidateBytes[1]),
    ]);
  }, 60_000);

  it.each([
    [
      "wrong identity",
      (value: any) =>
        (value.observation.disposableDatabaseIdentity = "production"),
    ],
    [
      "failed digest",
      (value: any) =>
        (value.observation.receiptCatalogDigest = `sha256:${"f".repeat(64)}`),
    ],
    [
      "projection",
      (value: any) => (value.observation.projectionExport = "decoy"),
    ],
    ["extra key", (value: any) => (value.observation.extra = true)],
  ])("rejects %s tampering", (_name, mutate) => {
    const second = JSON.parse(capture("b").toString("utf8"));
    mutate(second);
    expect(() =>
      packageLiveCatalogCaptureEvidence(
        capture("a"),
        Buffer.from(JSON.stringify(second)),
      ),
    ).toThrow(/live_catalog_/u);
  });
});
