import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { ReviewRunAuthorizationCreateStatus } from "../application/ports/review-run-authorization-ports";
import { ProducerReleaseState } from "../domain/review-run-control-types";
import { PrismaReviewRunAuthorizationRepository } from "../infrastructure/prisma/prisma-review-run-authorization-repository";
import { createReviewRunControlTestKit } from "../testing/review-run-control-test-kit";
import { provisionV2AuthorizationContext } from "./fixtures";

// Execute the production transaction callback without opening a database connection.
describe("Prisma selected-release admission precondition", () => {
  it.each(["missing", "revoked", "identity drift", "registered", "unmatched"])(
    "checks the attested base inside the transaction: %s",
    async (state) => {
      const kit = createReviewRunControlTestKit();
      const fixture = await provisionV2AuthorizationContext(kit);
      const admit = vi.spyOn(
        kit.store,
        "createOrRestoreReviewRunAuthorizationAtomically",
      );
      await kit.control.authorizations.authorizeReviewRun(
        fixture.authorizeInput,
      );
      const original = admit.mock.calls[0]![0];
      const expectedBase = {
        ...original.fence.producerRelease,
        producerReleaseId: "attested_base",
      };
      const row = {
        ...expectedBase,
        state:
          state === "revoked"
            ? ProducerReleaseState.Revoked
            : ProducerReleaseState.Registered,
        runtimeCommitSha:
          state === "identity drift"
            ? "f".repeat(40)
            : expectedBase.runtimeCommitSha,
        reviewInvestigationCapability: null,
        reviewInvestigationCoverageProfileHash: null,
        reviewInvestigationPolicyHash: null,
      };
      const create = vi.fn();
      const furtherFenceRead = new Error("base_precondition_passed");
      const transaction = {
        $queryRaw: vi.fn(async () => []),
        reviewRunAuthorization: { findUnique: vi.fn(async () => null), create },
        scmRepositoryIdentity: { findUnique: vi.fn(async () => ({})) },
        reviewMutationAuthority: { findUnique: vi.fn(async () => ({})) },
        producerRelease: {
          findUnique: vi.fn(
            async ({ where }: { where: { producerReleaseId: string } }) =>
              where.producerReleaseId === expectedBase.producerReleaseId &&
              state === "missing"
                ? null
                : row,
          ),
        },
        reviewProtocolLimitsV2: {
          findUnique: vi.fn(async () => {
            throw furtherFenceRead;
          }),
        },
      };
      const transact = vi.fn(
        async (callback: (tx: typeof transaction) => Promise<unknown>) =>
          callback(transaction),
      );
      const repository = new PrismaReviewRunAuthorizationRepository({
        $transaction: transact,
      } as unknown as PrismaClient);
      const result = repository.createOrRestoreReviewRunAuthorizationAtomically(
        {
          candidate: original.candidate,
          fence: {
            ...original.fence,
            ...(state === "unmatched"
              ? {}
              : { expectedBaseProducerRelease: expectedBase }),
          },
        },
      );
      if (state === "registered" || state === "unmatched") {
        // Remaining fence checks still execute; this is not a full admission success mock.
        await expect(result).rejects.toBe(furtherFenceRead);
      } else {
        await expect(result).resolves.toEqual({
          status: ReviewRunAuthorizationCreateStatus.EligibilityChanged,
        });
        expect(
          transaction.reviewProtocolLimitsV2.findUnique,
        ).not.toHaveBeenCalled();
      }
      expect(
        transaction.producerRelease.findUnique.mock.calls.map(
          ([input]) => input.where.producerReleaseId,
        ),
      ).toEqual(
        state === "unmatched"
          ? [original.candidate.producerReleaseId]
          : [
              original.candidate.producerReleaseId,
              expectedBase.producerReleaseId,
            ],
      );
      expect(transact).toHaveBeenCalledWith(expect.any(Function), {
        isolationLevel: "Serializable",
      });
      expect(create).not.toHaveBeenCalled();
    },
  );
});
