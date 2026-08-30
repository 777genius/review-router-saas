import { type ActivationCatalogPolicyPromotionExpectation } from "./activation-catalog-policy-provenance-contract";

export const activationCatalogPromotionOptIn =
  "promote-reviewed-activation-catalog-v29";

export const reviewedActivationCatalogCandidate = Object.freeze({
  sha256: "b138eb3ece6553d505debff1dc978a9b6fd8ea854cf70c037c05e364b3d0aa28",
  bytes: 2_651_682,
  liveCatalogDigest:
    "sha256:6ecfc9b47b47a6351f72c6f9793df3f408b2b33a275158f5499b09c10a6c048d",
  preactivationCatalogPolicySha256:
    "sha256:87266972e7979bb15464f470f1cb94c1cf8fee3f8ec62d36c8c866328e52925b",
  activatedCatalogPolicySha256:
    "sha256:cc35c6b43fe8b117a492705eeaf2ab9a9ac0e05f98546fa32ac9d340df89867b",
  artifactCanonicalSha256:
    "sha256:5d7a98bf13e65ab8071691086efb792699b994961caadf435ee9fd4845c2f1cf",
});

export const reviewedActivationCatalogPromotionExpectation = Object.freeze({
  readinessReason:
    "reviewed-v29-comment-token-custody-promoted-with-exact-go-evidence",
  captureBaseCommit: "7459b6d4fd8aab5c377547246292faf3376d98cb",
  auditedHead: "7459b6d4fd8aab5c377547246292faf3376d98cb",
  captureArtifactBytes: 2_651_682,
  captureArtifactSha256:
    "b138eb3ece6553d505debff1dc978a9b6fd8ea854cf70c037c05e364b3d0aa28",
  capturePayloadOffsetBytes: 0,
  capturePrefixSha256:
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  reviewArtifactSha256:
    "08df458e97033dae692f04153285f9c68a6d6f3d11dea5f2e626fb687cebcd6f",
  reviewerEvidenceSha256:
    "4620e71b3ea9369fda0396d506e0d9d0984123d0d5d28af6b237fc0f6042a3a8",
  reviewerRunId: "rrv140policy3-review-r1",
  reviewDecisionId: "RR-V29-CODEX-GO-7459B6D4-B138EB3E-20260830",
  candidateBytes: reviewedActivationCatalogCandidate.bytes,
  candidateSha256: reviewedActivationCatalogCandidate.sha256,
  liveCatalogDigest: reviewedActivationCatalogCandidate.liveCatalogDigest,
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
