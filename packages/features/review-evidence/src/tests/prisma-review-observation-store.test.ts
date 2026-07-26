import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { ReviewObservationAcceptPersistenceStatus } from "../application/ports/review-observation-ports";
import { ReviewObservationQualityFlag } from "../domain/review-evidence-primitives";
import { PrismaReviewObservationStore } from "../infrastructure/prisma/prisma-review-observation-store";
import { observation } from "./fixtures";

describe("Prisma review observation store", () => {
  it("returns a successful insert with every supported quality flag", async () => {
    const qualityFlags = [
      ReviewObservationQualityFlag.ModelFallback,
      ReviewObservationQualityFlag.LowConfidence,
      ReviewObservationQualityFlag.ProviderWarning,
      ReviewObservationQualityFlag.ContextInspectionIncomplete,
      ReviewObservationQualityFlag.ContextAttestationUnavailable,
      ReviewObservationQualityFlag.CrossRevisionReuseDisabled,
    ] as const;
    const create = vi.fn(async ({ data }: { data: unknown }) => data);
    const store = new PrismaReviewObservationStore({
      reviewEvidenceObservation: { create },
    } as unknown as PrismaClient);
    const candidate = observation({ qualityFlags });

    await expect(store.acceptObservation(candidate)).resolves.toMatchObject({
      status: ReviewObservationAcceptPersistenceStatus.Accepted,
      observation: { qualityFlags: candidate.qualityFlags },
    });
    expect(create).toHaveBeenCalledOnce();
  });

  it("rejects inherited object keys as persisted quality flags", async () => {
    const create = vi.fn(
      async ({ data }: { data: Record<string, unknown> }) => ({
        ...data,
        qualityFlagsJson: ["toString"],
      }),
    );
    const store = new PrismaReviewObservationStore({
      reviewEvidenceObservation: { create },
    } as unknown as PrismaClient);

    await expect(store.acceptObservation(observation())).rejects.toThrow(
      "review_observation_quality_flag_invalid:toString",
    );
  });
});
