import { type ActivationCatalogPolicyPromotionExpectation } from "./activation-catalog-policy-provenance-contract";

export const activationCatalogPromotionOptIn =
  "promote-reviewed-activation-catalog-v26";

export const reviewedActivationCatalogCandidate = Object.freeze({
  sha256: "f2eeaf4ed03dbb72c7b551a483201aa6086788c3ee3d3b8118ded067ae5f3d1f",
  bytes: 2_490_382,
  preactivationCatalogPolicySha256:
    "sha256:b95cc2c1fdd94b64056f6d8cd9316d361dce87a8a6a8064c8db51db65a886e68",
  activatedCatalogPolicySha256:
    "sha256:118834866426337911d13e47f2752f2f982c1393792668036e359b0062117c6f",
  artifactCanonicalSha256:
    "sha256:95a5b1adcb36e6917fa9113a17e7392772d344e4c9dfbef3d206e57e959f01d3",
});

export const reviewedActivationCatalogPromotionExpectation = Object.freeze({
  readinessReason:
    "reviewed-v26-output-budget-guard-promoted-with-exact-go-evidence",
  captureBaseCommit: "83e55ce8772e54757b97e0214721af56af18ae0b",
  auditedHead: "83e55ce8772e54757b97e0214721af56af18ae0b",
  captureArtifactBytes: 2_490_382,
  captureArtifactSha256:
    "f2eeaf4ed03dbb72c7b551a483201aa6086788c3ee3d3b8118ded067ae5f3d1f",
  capturePayloadOffsetBytes: 0,
  capturePrefixSha256:
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  reviewArtifactSha256:
    "245b68e5869802816acbf06278648a5b85ea1089cc2967ac2f61208c78eb6c02",
  reviewerEvidenceSha256:
    "45cfc438e5c3ceef5be281bee7d007a0849921d50dac20e0f62dbea03e8b5a7c",
  reviewerRunId: "rr-activation-policy-v26-review-r1",
  reviewDecisionId: "codex:activation-policy-v26:83e55ce8772:f2eeaf4ed03d:go",
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
