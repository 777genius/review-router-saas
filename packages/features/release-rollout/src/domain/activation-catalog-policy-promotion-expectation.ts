import { type ActivationCatalogPolicyPromotionExpectation } from "./activation-catalog-policy-provenance-contract";

export const activationCatalogPromotionOptIn =
  "promote-reviewed-activation-catalog-v28";

export const reviewedActivationCatalogCandidate = Object.freeze({
  sha256: "ba51051d9407b4ca7b6b9c6ce74210f9ef70556e5df23512c4364024ef0800a9",
  bytes: 2_506_590,
  preactivationCatalogPolicySha256:
    "sha256:95591a9df4dd88afe9a9a10118bf11b7e5ec4694748f8262de124d5f7ba7fd59",
  activatedCatalogPolicySha256:
    "sha256:6c8f40abc68b063b835289d3d42f7ee07d9769baf269c5b05fb85db72c8cb3a0",
  artifactCanonicalSha256:
    "sha256:bb528f22b531f212641ecebdb5ea8d0b851f0291a8c830d5bb41c88b348ccb57",
});

export const reviewedActivationCatalogPromotionExpectation = Object.freeze({
  readinessReason:
    "reviewed-v28-runtime-authority-gate-promoted-with-exact-go-evidence",
  captureBaseCommit: "14774ef58ad81ac72890f96590102ac6d3dba328",
  auditedHead: "14774ef58ad81ac72890f96590102ac6d3dba328",
  captureArtifactBytes: 2_506_590,
  captureArtifactSha256:
    "ba51051d9407b4ca7b6b9c6ce74210f9ef70556e5df23512c4364024ef0800a9",
  capturePayloadOffsetBytes: 0,
  capturePrefixSha256:
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  reviewArtifactSha256:
    "050b952c3566c8b8792de874a4d2223e5d35ef01d28d0db74d01bfe4e0a6ac56",
  reviewerEvidenceSha256:
    "0057254b74da940ca9394d9449700d603cd6eee79090be34b8df2261f5179604",
  reviewerRunId: "rrpr227v27-review-v28-r1",
  reviewDecisionId: "codex:activation-policy-v28:14774ef58ad8:ba51051d9407:go",
  candidateBytes: reviewedActivationCatalogCandidate.bytes,
  candidateSha256: reviewedActivationCatalogCandidate.sha256,
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
} satisfies ActivationCatalogPolicyPromotionExpectation);
