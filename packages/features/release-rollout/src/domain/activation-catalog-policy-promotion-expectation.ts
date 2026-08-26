import { type ActivationCatalogPolicyPromotionExpectation } from "./activation-catalog-policy-provenance-contract";

export const activationCatalogPromotionOptIn =
  "promote-reviewed-activation-catalog-v29";

export const reviewedActivationCatalogCandidate = Object.freeze({
  sha256: "bd6aba2349266bb8165c64d309ba537c0d63846c58c425b040ed408f857ebe62",
  bytes: 2_627_574,
  preactivationCatalogPolicySha256:
    "sha256:7d511ef69e73cb040ce164de5914f8129f956ff9a351840391b0c1937958c787",
  activatedCatalogPolicySha256:
    "sha256:c2981e22c9095572a396c81acbab316ae643a5d4305a113cfeff2327f7e57c47",
  artifactCanonicalSha256:
    "sha256:ac627f7d9bb37e15ba790082586ce3b84e8c4d19361f517ba59e0d46441d3b0c",
});

export const reviewedActivationCatalogPromotionExpectation = Object.freeze({
  readinessReason:
    "reviewed-v29-comment-token-custody-promoted-with-exact-go-evidence",
  captureBaseCommit: "da0d56a73f366d3372cf3c2ebacfe431c6d21ed1",
  auditedHead: "da0d56a73f366d3372cf3c2ebacfe431c6d21ed1",
  captureArtifactBytes: 2_627_574,
  captureArtifactSha256:
    "bd6aba2349266bb8165c64d309ba537c0d63846c58c425b040ed408f857ebe62",
  capturePayloadOffsetBytes: 0,
  capturePrefixSha256:
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  reviewArtifactSha256:
    "381b82b693b96350a769a9e502336878de6211f91d1ad30b50b2251d17bfe050",
  reviewerEvidenceSha256:
    "ad68a7f422164a99b687fc9acc226e60ca6d358342c967a343527a271ba67f30",
  reviewerRunId: "rr-pr227-v29-review-r44",
  reviewDecisionId: "codex:activation-policy-v29:da0d56a73f36:bd6aba234926:go",
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
