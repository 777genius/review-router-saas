import { createHash } from "node:crypto";
import { ManageProducerReleases } from "@reviewrouter/features-review-run-control";
import { PrismaProducerReleaseRepository } from "@reviewrouter/features-review-run-control/composition";
import type { PrismaClient } from "@prisma/client";
import { SystemClock } from "@reviewrouter/shared";
import { reviewActionV2AbsoluteProtocolMaxima } from "./review-action-v2-protocol-policy.js";

export function composeReviewActionV2ReleaseRegistry(prisma: PrismaClient) {
  const clock = new SystemClock();
  const digest = {
    async digestUtf8(value: string) {
      return createHash("sha256").update(value, "utf8").digest("hex");
    },
  };
  const repository = new PrismaProducerReleaseRepository(prisma);
  const producerReleases = new ManageProducerReleases({
    clock,
    digest,
    protocolLimitsQueries: repository,
    protocolLimitsCommands: repository,
    operationalSloQueries: repository,
    operationalSloCommands: repository,
    releaseQueries: repository,
    releaseCommands: repository,
    absoluteProtocolMaxima: reviewActionV2AbsoluteProtocolMaxima,
  });

  return Object.freeze({
    digest,
    runControl: Object.freeze({ producerReleases }),
  });
}
