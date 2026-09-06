import type { CertifiedForkReviewPromptPacket } from "../use-cases/certified-fork-review-packet.js";

export type CertifiedForkReviewBinding = Readonly<{
  sourceRepository: string;
  sourceRepositoryId: string;
  baseRepository: string;
  baseRepositoryId: string;
  pullRequestNumber: number;
  reviewHeadSha: string;
  baseSha: string;
  trustDomain: "fork";
}>;

export interface CertifiedForkReviewGatewayPort {
  assertBindingCurrent(input: {
    readonly githubInstallationId: string;
    readonly binding: CertifiedForkReviewBinding;
  }): Promise<void>;

  prepareContext(input: {
    readonly githubInstallationId: string;
    readonly binding: CertifiedForkReviewBinding;
  }): Promise<{
    readonly contextHash: string;
    readonly promptPacket: CertifiedForkReviewPromptPacket;
  }>;

  assertContextCurrent(input: {
    readonly githubInstallationId: string;
    readonly binding: CertifiedForkReviewBinding;
    readonly expectedContextHash: string;
  }): Promise<{ readonly promptPacket: CertifiedForkReviewPromptPacket }>;
}
