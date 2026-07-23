import type { PrismaClient } from "@prisma/client";
import { PrismaProducerReleaseRepository } from "../infrastructure/prisma/prisma-producer-release-repository";
import { PrismaReviewMutationAuthorityRepository } from "../infrastructure/prisma/prisma-review-mutation-authority-repository";
import { PrismaReviewRunAuthorizationRepository } from "../infrastructure/prisma/prisma-review-run-authorization-repository";
import { PrismaReviewSafetyControlRepository } from "../infrastructure/prisma/prisma-review-safety-control-repository";
import { PrismaScmRepositoryIdentityRepository } from "../infrastructure/prisma/prisma-scm-repository-identity-repository";

export function createPrismaReviewRunControlRepositories(prisma: PrismaClient) {
  const producerReleases = new PrismaProducerReleaseRepository(prisma);
  const repositoryIdentities = new PrismaScmRepositoryIdentityRepository(
    prisma,
  );
  const mutationAuthorities = new PrismaReviewMutationAuthorityRepository(
    prisma,
  );
  const safetyControls = new PrismaReviewSafetyControlRepository(prisma);
  const authorizations = new PrismaReviewRunAuthorizationRepository(prisma);
  return {
    producerReleases,
    repositoryIdentities,
    mutationAuthorities,
    safetyControls,
    authorizations,
  } as const;
}

export {
  PrismaProducerReleaseRepository,
  PrismaReviewMutationAuthorityRepository,
  PrismaReviewRunAuthorizationRepository,
  PrismaReviewSafetyControlRepository,
  PrismaScmRepositoryIdentityRepository,
};
