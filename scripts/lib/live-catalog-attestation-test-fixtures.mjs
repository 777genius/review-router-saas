import { readFileSync } from "node:fs";
import canonicalArtifact from "../../packages/features/release-rollout/src/domain/activation-catalog-policy-artifact.generated.js";
import { sha256Hex } from "./live-catalog-attestation-domain.mjs";

export const testConfiguredDigest = `sha256:${"1".repeat(64)}`;
export const testProjectionSource = Buffer.from(
  `export const fencedLiveV70V73CatalogDigestSql = \`SELECT 'ok'\`;\n` +
    `export const liveV70V73CatalogDigestSha256 = "${testConfiguredDigest}";\n`,
);
export const testProjectionBytes = Buffer.from("SELECT 'ok'");

export const testCandidate = Buffer.from(
  JSON.stringify({
    kind: "reviewrouter-activation-catalog-policy-artifact-candidate",
    version: 1,
    policies: canonicalArtifact.policies,
  }),
);

export const testCaptureEvidence = Buffer.from(
  `${JSON.stringify(
    {
      kind: "reviewrouter-live-catalog-successful-capture-evidence",
      version: 1,
      observedCatalogDigest: testConfiguredDigest,
      projection: {
        path: "packages/features/release-rollout/src/adapters/live-v70-v72-catalog-digest.mjs",
        export: "fencedLiveV70V73CatalogDigestSql",
        sqlSha256: sha256Hex(testProjectionBytes),
      },
      inputs: [1, 2].map((number) => ({
        disposableDatabaseIdentity: `rr-disposable-1001-1-${number === 1 ? "a" : "b"}`,
        candidateName: `activation-catalog-policy-candidate-${number}.json`,
        candidateSize: testCandidate.length,
        candidateSha256: sha256Hex(testCandidate),
        receiptCatalogDigest: testConfiguredDigest,
      })),
    },
    null,
    2,
  )}\n`,
);

export const testWorkflowSource = readFileSync(".github/workflows/ci.yml");
