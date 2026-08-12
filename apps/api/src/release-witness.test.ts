import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createReleaseWitnessApp } from "./release-witness-composition";

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const seed = {
  jobId: "job-1",
  serviceId: "srv-1",
  cleanupCanary: "rr-cleanup:rollout-1:rr-runner",
  observedAt: "2026-08-12T00:00:00.000Z",
};
const json = (value: unknown) =>
  new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

describe("release witness observation", () => {
  it("rejects caller-supplied facts before querying Render or the database", async () => {
    const prisma = { $queryRaw: vi.fn() };
    const renderFetch = vi.fn();
    const app = await createReleaseWitnessApp({
      witnessPrisma: prisma as never,
      triggerTokenSha256: digest("trigger"),
      renderReadToken: "render-read-only",
      renderFetch,
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/runner-jobs/job-1/cleanup-observation",
      headers: { authorization: "Bearer trigger" },
      payload: { providerStatus: "succeeded", remainingPaths: [] },
    });

    expect(response.statusCode).toBe(400);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(renderFetch).not.toHaveBeenCalled();
    await app.close();
  });

  it("derives and persists normalized evidence from its own Render reads", async () => {
    const queries: { values?: readonly unknown[] }[] = [];
    const prisma = {
      $queryRaw: vi
        .fn()
        .mockImplementationOnce(
          async (query: { values?: readonly unknown[] }) => {
            queries.push(query);
            return [{ value: seed }];
          },
        )
        .mockImplementationOnce(
          async (query: { values?: readonly unknown[] }) => {
            queries.push(query);
            return [{ value: true }];
          },
        ),
    };
    const receipt = JSON.stringify({
      canary: seed.cleanupCanary,
      cleanup: {
        removedPaths: ["/runner/_work/rr-runner/repository"],
        remainingPaths: [],
      },
    });
    const renderFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/jobs/job-1"))
        return json({
          id: seed.jobId,
          serviceId: seed.serviceId,
          startCommand: "node /runner/bootstrap.mjs",
          status: "succeeded",
          createdAt: "2026-08-12T00:00:01.000Z",
          finishedAt: "2026-08-12T00:02:00.000Z",
        });
      if (url.endsWith("/services/srv-1"))
        return json({
          id: seed.serviceId,
          ownerId: "tea-owner",
          type: "private_service",
          suspended: "not_suspended",
          autoDeploy: "no",
          serviceDetails: {},
        });
      return json({
        logs: [
          {
            id: "log-1",
            message: receipt,
            timestamp: "2026-08-12T00:01:59.000Z",
          },
        ],
      });
    });
    const app = await createReleaseWitnessApp({
      witnessPrisma: prisma as never,
      triggerTokenSha256: digest("trigger"),
      renderReadToken: "render-read-only",
      renderFetch,
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/runner-jobs/job-1/cleanup-observation",
      headers: { authorization: "Bearer trigger" },
      payload: {},
    });

    expect(response.statusCode).toBe(204);
    expect(renderFetch).toHaveBeenCalledTimes(3);
    const persisted = queries[1]?.values?.find(
      (value) => typeof value === "string" && value.includes('"providerLogId"'),
    );
    expect(JSON.parse(String(persisted))).toMatchObject({
      jobId: seed.jobId,
      canary: seed.cleanupCanary,
      providerStatus: "succeeded",
      containerTerminated: true,
      removedPaths: ["/runner/_work/rr-runner/repository"],
      remainingPaths: [],
      providerLogId: "log-1",
      providerObservedAt: "2026-08-12T00:01:59.000Z",
    });
    expect(String(persisted)).not.toContain("render-read-only");
    await app.close();
  });
});
