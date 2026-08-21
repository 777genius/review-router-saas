import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

vi.mock("@reviewrouter/features-review-run-control/composition", () => ({
  PrismaReviewSafetyControlRepository: class {},
  PrismaScmRepositoryIdentityRepository: class {},
}));

vi.mock("@reviewrouter/features-action-control-plane", () => ({
  PrismaActionControlPlaneRepository: class {},
}));

describe("Review Action v2 safety-control composition", () => {
  it("constructs the global emergency runtime without provider environment", async () => {
    const { composeReviewActionV2SafetyControlRuntime } =
      await import("./review-action-v2-safety-control-composition.js");
    const runtime = composeReviewActionV2SafetyControlRuntime(
      {} as PrismaClient,
    );

    await expect(runtime.digest.digestUtf8("operator")).resolves.toBe(
      createHash("sha256").update("operator", "utf8").digest("hex"),
    );
    expect(runtime.actionRepositories).toBeDefined();
    expect(runtime.repositories.repositoryIdentities).toBeDefined();
    expect(runtime.repositories.safetyControls).toBeDefined();
    expect(runtime.runControl.safetyControls).toBeDefined();
  });
});
