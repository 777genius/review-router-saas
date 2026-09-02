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
