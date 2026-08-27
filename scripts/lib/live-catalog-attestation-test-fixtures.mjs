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

export const testWorkflowSource = Buffer.from(`jobs:
  private-pg16-to-pg17-rehearsal:
    name: Full private PG16 to PG17 rehearsal
    runs-on: ubuntu-24.04
    steps:
      - name: Capture two reproducible activation catalog policies
        if: \${{ inputs.activation_catalog_policy_capture }}
        env:
          REVIEW_ROUTER_PRIVATE_PG17_REHEARSAL: "1"
          REVIEW_ROUTER_PRIVATE_PG17_ACTIVATION_CATALOG_POLICY_CAPTURE_ONLY: "1"
          REVIEW_ROUTER_REHEARSAL_PG16_IMAGE: postgres:16.13-bookworm@sha256:${"2".repeat(64)}
          REVIEW_ROUTER_REHEARSAL_PG17_IMAGE: postgres:17.5-bookworm@sha256:fbcea1bd13b6a882cd6caa6b58db3ae5c102efe50ec625b3e2a5cbc50db5bfe4
        run: |
          export REVIEW_ROUTER_ACTIVATION_CATALOG_DISPOSABLE_DATABASE_IDENTITY="rr-disposable-\${GITHUB_RUN_ID}-\${GITHUB_RUN_ATTEMPT}-a"
          node --import tsx scripts/rehearse-private-pg17-rollout.mjs > activation-catalog-capture-result-1.json
          export REVIEW_ROUTER_ACTIVATION_CATALOG_DISPOSABLE_DATABASE_IDENTITY="rr-disposable-\${GITHUB_RUN_ID}-\${GITHUB_RUN_ATTEMPT}-b"
          node --import tsx scripts/rehearse-private-pg17-rollout.mjs > activation-catalog-capture-result-2.json
          node --import tsx scripts/package-live-catalog-capture-evidence.mjs activation-catalog-capture-result-1.json activation-catalog-capture-result-2.json
          cmp activation-catalog-policy-candidate-1.json activation-catalog-policy-candidate-2.json
          sha256sum activation-catalog-policy-candidate-1.json activation-catalog-policy-candidate-2.json live-catalog-successful-capture-evidence.json
      - name: Upload activation catalog policy captures
        if: \${{ inputs.activation_catalog_policy_capture }}
        uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02
        with:
          name: activation-catalog-policy-\${{ github.sha }}-\${{ github.run_attempt }}
          path: |
            activation-catalog-policy-candidate-1.json
            activation-catalog-policy-candidate-2.json
            live-catalog-successful-capture-evidence.json
          if-no-files-found: error
          retention-days: 14
`);
