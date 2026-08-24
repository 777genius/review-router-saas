import { type ActivationCatalogPolicyPromotionExpectation } from "./activation-catalog-policy-provenance-contract";

export const activationCatalogPromotionOptIn =
  "promote-reviewed-activation-catalog-v24";

export const reviewedActivationCatalogCandidate = Object.freeze({
  sha256: "8f4f5d60707cd57eff560218f3cdeeaf4a56f1934dab9939ba4eeb1630947630",
  bytes: 2_477_044,
  preactivationCatalogPolicySha256:
    "sha256:fe9c71391557f194d84070689100ba55e31fe9e89a768b39879ff43619726c37",
  activatedCatalogPolicySha256:
    "sha256:b5b56feebf9be6e17e6d4aaf17d7f5409b7a3df0f6fe5692ea588043d5a7e4c1",
  artifactCanonicalSha256:
    "sha256:5f4dc73eff4574cea5d6953173b0d35d4332fdc1d2e8b74190dce69569b3292d",
});

export const reviewedActivationCatalogPromotionExpectation = Object.freeze({
  readinessReason:
    "reviewed-v24-production-shaped-pg17-candidate-promoted-with-exact-go-evidence",
  captureBaseCommit: "012e8bec2f8ee3d7bb36a9daa394d2fe1a024b8e",
  auditedHead: "012e8bec2f8ee3d7bb36a9daa394d2fe1a024b8e",
  captureArtifactBytes: 2_477_207,
  captureArtifactSha256:
    "3bce2a00d3cf1230f31fac391e1cb50de40ff76195fbbc880e3f5282fccf1b1d",
  capturePayloadOffsetBytes: 163,
  capturePrefixSha256:
    "8a904502926643c979ec68f5a4b7a0dc91affba2cb200bc73a96136ca012a4ca",
  reviewArtifactSha256:
    "b2b57ec757ea2ffd0f052ab9675f243a98e245841d54d275593160b6c87e49d1",
  reviewerEvidenceSha256:
    "b64b5a6d8031dd7be3742bf556c0be262303387772faab3f3b024489ed42626f",
  reviewerRunId: "rr-activation-policy-v24-review",
  reviewDecisionId: "codex:activation-policy-v24:012e8bec2f8e:8f4f5d60707c:go",
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
