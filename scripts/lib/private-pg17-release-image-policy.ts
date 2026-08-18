import {
  sha256Canonical,
  type TrustedReleaseImagePolicy,
} from "../../packages/features/release-rollout/src/index";

export const PRIVATE_PG17_RELEASE_IMAGE_CONFIGURATION = Object.freeze({
  provider: "github-actions",
  workflowPath: ".github/workflows/release.yml",
  sourceRef: "refs/heads/main",
  imageRepository: "ghcr.io/777genius/review-router-saas-runtime",
  denySelfHostedRunners: true,
} as const);

export interface PrivatePg17ReleaseImagePolicyInput {
  readonly sourceRepository: string;
  readonly sourceRevision: string;
}

export function privatePg17AttestationPolicy(
  input: PrivatePg17ReleaseImagePolicyInput,
) {
  return {
    provider: PRIVATE_PG17_RELEASE_IMAGE_CONFIGURATION.provider,
    sourceRepository: input.sourceRepository,
    sourceRevision: input.sourceRevision,
    workflowPath: PRIVATE_PG17_RELEASE_IMAGE_CONFIGURATION.workflowPath,
    sourceRef: PRIVATE_PG17_RELEASE_IMAGE_CONFIGURATION.sourceRef,
    imageRepository: PRIVATE_PG17_RELEASE_IMAGE_CONFIGURATION.imageRepository,
    attestation: {
      denySelfHostedRunners:
        PRIVATE_PG17_RELEASE_IMAGE_CONFIGURATION.denySelfHostedRunners,
      signerWorkflow: `github.com/${input.sourceRepository}/${PRIVATE_PG17_RELEASE_IMAGE_CONFIGURATION.workflowPath}`,
      sourceDigest: input.sourceRevision,
    },
  } as const;
}

export function privatePg17ReleaseImagePolicy(
  input: PrivatePg17ReleaseImagePolicyInput,
): TrustedReleaseImagePolicy {
  return Object.freeze({
    sourceRepository: input.sourceRepository,
    sourceRevision: input.sourceRevision,
    imageRepository: PRIVATE_PG17_RELEASE_IMAGE_CONFIGURATION.imageRepository,
    verificationPolicySha256: `sha256:${sha256Canonical(
      privatePg17AttestationPolicy(input),
    )}`,
  });
}
