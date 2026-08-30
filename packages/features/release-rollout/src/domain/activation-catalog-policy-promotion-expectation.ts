import { type ActivationCatalogPolicyPromotionExpectation } from "./activation-catalog-policy-provenance-contract";
import { canonicalReleaseMigrationArtifact } from "./release-migration-transition";

export function assertActivationCatalogLiveDigestTransitionBinding(
  candidateLiveCatalogDigest: string,
  postCatalogDigest: string,
): void {
  if (candidateLiveCatalogDigest !== postCatalogDigest)
    throw new Error("activation_catalog_policy_live_digest_transition_drift");
}

export const activationCatalogPromotionOptIn =
  "promote-reviewed-activation-catalog-v29-schema-v5-pr245";

export const reviewedActivationCatalogCandidate = Object.freeze({
  sha256: "b138eb3ece6553d505debff1dc978a9b6fd8ea854cf70c037c05e364b3d0aa28",
  bytes: 2_651_682,
  liveCatalogDigest:
    "sha256:6ecfc9b47b47a6351f72c6f9793df3f408b2b33a275158f5499b09c10a6c048d",
  liveCatalogProjectionSourceSha256:
    "39e855060bfc186c6fb92fe1cd5c72410f8f72802200da49d6c1fe45eb6ed5f4",
  normalizationSourceSha256:
    "7b23d64a1f2160398cdeb9194b0a3f3583e5566a1b20a0b2009caaf7ddbe0da1",
  preactivationCatalogPolicySha256:
    "sha256:87266972e7979bb15464f470f1cb94c1cf8fee3f8ec62d36c8c866328e52925b",
  activatedCatalogPolicySha256:
    "sha256:cc35c6b43fe8b117a492705eeaf2ab9a9ac0e05f98546fa32ac9d340df89867b",
  artifactCanonicalSha256:
    "sha256:5d7a98bf13e65ab8071691086efb792699b994961caadf435ee9fd4845c2f1cf",
});

assertActivationCatalogLiveDigestTransitionBinding(
  reviewedActivationCatalogCandidate.liveCatalogDigest,
  canonicalReleaseMigrationArtifact.postCatalogDigest,
);

export const reviewedActivationCatalogPromotionExpectation = Object.freeze({
  readinessReason:
    "reviewed-v29-schema-v5-pr245-promoted-with-evidence-contract-v2",
  evidenceContractVersion: 2,
  promotedAt: "2026-08-30T15:18:45.287Z",
  comparisonBaseline: "ee46dfbacd25d8e0f18f5cffb5a5d0b4d78f3385",
  captureBaseCommit: "79c8496d64b63c129e19331ee328666f714d82b1",
  auditedHead: "79c8496d64b63c129e19331ee328666f714d82b1",
  auditedTree: "1cdb05db1f73eb2bf294d774d517fff533ca24bc",
  captureRunId: "33315824201",
  captureRunAttempt: 1,
  captureJobId: "99268972795",
  captureArtifactId: "9733425691",
  captureArtifactName:
    "activation-catalog-policy-79c8496d64b63c129e19331ee328666f714d82b1-1",
  captureLabels: [
    "activation-catalog-policy-candidate-1.json",
    "activation-catalog-policy-candidate-2.json",
  ],
  candidateEvidencePaths: [
    "/mnt/volume_ams3_1784742570542/evidence/rr-pr245-79c8496d-schema-v5-candidate/activation-catalog-policy-candidate-1.json",
    "/mnt/volume_ams3_1784742570542/evidence/rr-pr245-79c8496d-schema-v5-candidate/activation-catalog-policy-candidate-2.json",
  ],
  reviewArtifactBytes: 12_600,
  reviewArtifactSha256:
    "7abaefccd0fa7771c6594824df794415801771f68f14bf0521d2d2461b360528",
  reviewerEvidenceBytes: 13_211,
  reviewerEvidenceSha256:
    "9db6562b268d4e1d0e264d843dfe1551168fe0845e2c29b389b16e22aceb96a1",
  reviewerRunId: "rr-pr245-r253-schema-v5-provenance-review",
  reviewerTaskId: "rr-pr245-r253-schema-v5-provenance-review",
  reviewDecisionId: "RR-PR245-SCHEMA-V5-GO-79C8496D-B138EB3E-20260830",
  reviewedAt: "2026-08-30T14:26:32Z",
  reviewerCompletedAt: "2026-08-30T14:27:44.120Z",
  supplementalEvidenceBytes: 12_791,
  supplementalEvidenceSha256:
    "19fd8a8c9c8d17b0f84688f032fa014d52dce79621251f4cb363dd24fb456005",
  supplementalReviewerRunId: "rr-pr245-r252b-schema-v5-security-review",
  supplementalReviewerTaskId: "rr-pr245-r252b-schema-v5-security-review",
  supplementalCompletedAt: "2026-08-30T14:37:20.636Z",
  candidateBytes: reviewedActivationCatalogCandidate.bytes,
  candidateSha256: reviewedActivationCatalogCandidate.sha256,
  liveCatalogDigest: reviewedActivationCatalogCandidate.liveCatalogDigest,
  liveCatalogProjectionSourceSha256:
    reviewedActivationCatalogCandidate.liveCatalogProjectionSourceSha256,
  normalizationSourceSha256:
    reviewedActivationCatalogCandidate.normalizationSourceSha256,
  sourcePg16Image:
    "postgres:16.13-bookworm@sha256:472efd9a66f2b2f1a5aeb18b28de74332e6ef88c2b93a1a5d812fb6db67a5f60",
  targetPg17Image:
    "postgres:17.5-bookworm@sha256:fbcea1bd13b6a882cd6caa6b58db3ae5c102efe50ec625b3e2a5cbc50db5bfe4",
  preactivationCatalogPolicySha256:
    reviewedActivationCatalogCandidate.preactivationCatalogPolicySha256,
  activatedCatalogPolicySha256:
    reviewedActivationCatalogCandidate.activatedCatalogPolicySha256,
  artifactCanonicalSha256:
    reviewedActivationCatalogCandidate.artifactCanonicalSha256,
  generatedArtifactSourceBytes: 2_651_797,
  generatedArtifactSourceSha256:
    "cc9be40be941b6291013cdf921afa6db84ad9e615b988fe8ff7a24a387566fc3",
} satisfies ActivationCatalogPolicyPromotionExpectation);
