import { createHash, randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { PrismaActionControlPlaneRepository } from "@reviewrouter/features-action-control-plane";
import {
  ManageReviewSafetyControls,
  type Sha256DigestPort,
} from "@reviewrouter/features-review-run-control";
import {
  PrismaReviewSafetyControlRepository,
  PrismaScmRepositoryIdentityRepository,
} from "@reviewrouter/features-review-run-control/composition";
import { SystemClock } from "@reviewrouter/shared";

export function composeReviewActionV2SafetyControlRuntime(
  prisma: PrismaClient,
) {
  const clock = new SystemClock();
  const digest: Sha256DigestPort = {
    async digestUtf8(value) {
      return createHash("sha256").update(value, "utf8").digest("hex");
    },
  };
  const safetyControls = new PrismaReviewSafetyControlRepository(prisma);
  const repositoryIdentities = new PrismaScmRepositoryIdentityRepository(
    prisma,
  );
  const actionRepositories = new PrismaActionControlPlaneRepository(prisma);
  const management = new ManageReviewSafetyControls({
    clock,
    identifiers: { nextId: (prefix) => `${prefix}-${randomUUID()}` },
    inspections: safetyControls,
    policyCommands: safetyControls,
    emergencyCommands: safetyControls,
  });

  return Object.freeze({
    actionRepositories,
    digest,
    repositories: Object.freeze({ repositoryIdentities, safetyControls }),
    runControl: Object.freeze({ safetyControls: management }),
  });
}
