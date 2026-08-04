import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPrismaClient,
  type PrismaClient,
} from "@reviewrouter/platform-db";
import { InvestigationShadowEvidencePersistenceStatus } from "../application/ports/investigation-shadow-evidence-ports";
import { ReviewTrustDomain } from "../domain/review-evidence-primitives";
import { PrismaInvestigationShadowEvidenceStore } from "../infrastructure/prisma/prisma-investigation-shadow-evidence-store";
import { PrismaReviewObservationStore } from "../infrastructure/prisma/prisma-review-observation-store";
import {
  shadowEvidence,
  shadowHash,
  shadowIssuedAtMs,
} from "./investigation-shadow-evidence-fixtures";

const databaseUrl = process.env.REVIEW_ROUTER_TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;

describeWithDatabase("Prisma investigation shadow evidence contract", () => {
  let prisma: PrismaClient;
  let store: PrismaInvestigationShadowEvidenceStore;
  let observations: PrismaReviewObservationStore;
  const suffix = randomUUID();
  const investigationId = `investigation-shadow-${suffix}`;
  const certificateId = `certificate-shadow-${suffix}`;
  const shadowEvidenceId = `shadow-evidence-${suffix}`;
  const scope = {
    workspaceId: `workspace-shadow-${suffix}`,
    repositoryConnectionId: `repository-shadow-${suffix}`,
    scmRepositoryIdentityId: `scm-shadow-${suffix}`,
    pullRequestNumber: 42,
    trustDomain: ReviewTrustDomain.TrustedManaged,
    authorizationScopeHash: shadowHash(`authorization-${suffix}`),
  };

  beforeAll(() => {
    prisma = createPrismaClient({ databaseUrl: databaseUrl!, poolMax: 2 });
    store = new PrismaInvestigationShadowEvidenceStore(prisma);
    observations = new PrismaReviewObservationStore(prisma);
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.reviewInvestigationShadowEvidence.deleteMany({
      where: {
        OR: [{ investigationId }, { investigationId: { endsWith: suffix } }],
      },
    });
    await prisma.$disconnect();
  });

  it("round-trips, restores idempotently, rejects conflicts and prunes", async () => {
    const candidate = shadowEvidence({
      shadowEvidenceId,
      investigationId,
      certificateId,
      certificateHash: shadowHash(`certificate-${suffix}`),
      recordHash: shadowHash(`record-${suffix}`),
      scope,
    });
    await expect(store.persist(candidate)).resolves.toMatchObject({
      status: InvestigationShadowEvidencePersistenceStatus.Persisted,
    });
    await expect(
      observations.findById(candidate.shadowEvidenceId),
    ).resolves.toBeNull();
    await expect(
      prisma.reviewEvidenceObservation.count({
        where: { observationId: candidate.shadowEvidenceId },
      }),
    ).resolves.toBe(0);
    await expect(store.persist(candidate)).resolves.toMatchObject({
      status: InvestigationShadowEvidencePersistenceStatus.Idempotent,
    });
    await expect(
      store.persist(
        shadowEvidence({
          ...candidate,
          shadowEvidenceId: `conflict-${suffix}`,
          certificateId: `conflict-certificate-${suffix}`,
          certificateHash: shadowHash(`conflict-certificate-${suffix}`),
          recordHash: shadowHash(`conflict-record-${suffix}`),
          investigationId,
        }),
      ),
    ).resolves.toEqual({
      status: InvestigationShadowEvidencePersistenceStatus.Conflict,
    });
    const uniqueIdentityConflicts = [
      { shadowEvidenceId: candidate.shadowEvidenceId },
      { certificateId: candidate.certificateId },
      { certificateHash: candidate.certificateHash },
      { recordHash: candidate.recordHash },
    ] as const;
    for (const [index, conflict] of uniqueIdentityConflicts.entries()) {
      await expect(
        store.persist(
          shadowEvidence({
            ...candidate,
            shadowEvidenceId: `unique-conflict-${index}-${suffix}`,
            investigationId: `unique-investigation-${index}-${suffix}`,
            certificateId: `unique-certificate-${index}-${suffix}`,
            certificateHash: shadowHash(
              `unique-certificate-${index}-${suffix}`,
            ),
            recordHash: shadowHash(`unique-record-${index}-${suffix}`),
            ...conflict,
          }),
        ),
      ).resolves.toEqual({
        status: InvestigationShadowEvidencePersistenceStatus.Conflict,
      });
    }
    await expect(
      prisma.reviewInvestigationShadowEvidence.count({
        where: {
          shadowEvidenceId: {
            in: [
              candidate.shadowEvidenceId,
              ...uniqueIdentityConflicts.map(
                (_conflict, index) => `unique-conflict-${index}-${suffix}`,
              ),
            ],
          },
        },
      }),
    ).resolves.toBe(1);
    await expect(
      store.findByScopeRevision({
        scope,
        reviewRevisionHash: candidate.revision.reviewRevisionHash,
        limit: 10,
      }),
    ).resolves.toHaveLength(1);
    await expect(
      store.prune({
        retainUntilOrBeforeMs: candidate.retainUntilMs,
        limit: 10,
      }),
    ).resolves.toBe(1);
    await expect(
      store.findByInvestigationId(investigationId),
    ).resolves.toBeNull();
    expect(candidate.issuedAtMs).toBe(shadowIssuedAtMs);
  });
});
