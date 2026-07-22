import { JoseRotatingCapabilityCodec } from "@reviewrouter/platform-signed-capabilities";
import type { ProducerReleaseQueryPort } from "../application/ports/producer-release-ports";
import type { Sha256DigestPort } from "../application/ports/platform-ports";
import {
  ConfiguredProducerReleaseAttestationRegistry,
  readConfiguredProducerReleaseAttestations,
} from "../infrastructure/configured-producer-release-attestation";
import { CanonicalGitHubReviewRevisionResolver } from "../infrastructure/github/canonical-github-review-revision-resolver";
import { OctokitGitHubReviewRevisionSource } from "../infrastructure/github/octokit-github-review-revision-source";
import { createReviewRunAuthorizationKeyRingFromEnv } from "../infrastructure/signed-capabilities/env-review-run-authorization-key-ring";
import { ReviewRunAuthorizationSignedCapabilityAdapter } from "../infrastructure/signed-capabilities/review-run-authorization-token-adapter";

export function composeProductionReviewRunAuthorizationPrerequisites(input: {
  readonly githubAppId: string;
  readonly githubAppPrivateKey: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly releases: ProducerReleaseQueryPort;
  readonly digest: Sha256DigestPort;
  readonly maximumClockSkewSeconds?: number | undefined;
}) {
  if (!input.githubAppId || !input.githubAppPrivateKey) {
    throw new Error("review_run_authorization_github_app_config_missing");
  }
  const keyRing = createReviewRunAuthorizationKeyRingFromEnv(input.env);
  const tokenCodec = new JoseRotatingCapabilityCodec(
    keyRing,
    input.maximumClockSkewSeconds,
  );
  return {
    revisionResolver: new CanonicalGitHubReviewRevisionResolver(
      new OctokitGitHubReviewRevisionSource({
        appId: input.githubAppId,
        privateKey: input.githubAppPrivateKey,
      }),
      input.digest,
    ),
    releaseAttestations: new ConfiguredProducerReleaseAttestationRegistry(
      readConfiguredProducerReleaseAttestations(input.env),
      input.releases,
    ),
    tokens: new ReviewRunAuthorizationSignedCapabilityAdapter(
      tokenCodec,
      keyRing,
    ),
  } as const;
}
