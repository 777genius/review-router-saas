import { type ActivationCatalogPolicyPromotionExpectation } from "./activation-catalog-policy-provenance-contract";

export const activationCatalogPromotionOptIn =
  "promote-reviewed-activation-catalog-v25";

export const reviewedActivationCatalogCandidate = Object.freeze({
  sha256: "3f20cac0f84591e99f2f4f4a555faac4e2900fc5e6271238d20c71b67a6538bb",
  bytes: 2_489_008,
  preactivationCatalogPolicySha256:
    "sha256:36e6e4875c530beba1cb6bfc580a358d031895334e6af6a6bad193148e1beebe",
  activatedCatalogPolicySha256:
    "sha256:d0ccc9a760f69c467d3c9df56502704abb1f03116a2be156eb206100b35f5866",
  artifactCanonicalSha256:
    "sha256:539eead0f59e75f283d217be840280c61a3813d928e24a48ed9b34687ef5111d",
});

export const reviewedActivationCatalogPromotionExpectation = Object.freeze({
  readinessReason:
    "reviewed-v25-production-shaped-pg17-candidate-promoted-with-exact-go-evidence",
  captureBaseCommit: "09183587fc304628f41a8a6ee271eb82ad3544d4",
  auditedHead: "09183587fc304628f41a8a6ee271eb82ad3544d4",
  captureArtifactBytes: 2_489_008,
  captureArtifactSha256:
    "3f20cac0f84591e99f2f4f4a555faac4e2900fc5e6271238d20c71b67a6538bb",
  capturePayloadOffsetBytes: 0,
  capturePrefixSha256:
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  reviewArtifactSha256:
    "45fc64145269314a76790e0b6be032522a22f373b05daa4c26cf94af2132f8af",
  reviewerEvidenceSha256:
    "bf50f0ed18914f048f67bf042b49e35ccf69c2f9db08a8515f62f8e48c2c314c",
  reviewerRunId: "rr-activation-policy-v25-review-r1",
  reviewDecisionId: "codex:activation-policy-v25:09183587fc30:3f20cac0f845:go",
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
