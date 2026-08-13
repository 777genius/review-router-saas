import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createReleaseWitnessApp } from "./release-witness-composition";
import { RenderCleanupObservationAdapter } from "./release-witness-adapters";

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const seed = {
  jobId: "job-1",
  serviceId: "srv-1",
  cleanupCanary: "rr-cleanup:rollout-1:rr-runner",
  observedAt: "2026-08-12T00:00:02.000Z",
  providerCreationNotBefore: "2026-08-12T00:00:00.000Z",
};
const json = (value: unknown) =>
  new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const renderJob = (status: string) => ({
  id: seed.jobId,
  serviceId: seed.serviceId,
  startCommand: "node /runner/bootstrap.mjs",
  status,
  createdAt: "2026-08-12T00:00:01.000Z",
  finishedAt: "2026-08-12T00:02:00.000Z",
});
const renderService = {
  id: seed.serviceId,
  ownerId: "tea-owner",
  type: "private_service",
  suspended: "not_suspended",
  autoDeploy: "no",
  serviceDetails: {},
};
const cleanupReceipt = JSON.stringify({
  canary: seed.cleanupCanary,
  cleanup: {
    removedPaths: ["/runner/_work/rr-runner/repository"],
    remainingPaths: [],
  },
});
const cleanupLog = (id = "log-1") => ({
  id,
  message: cleanupReceipt,
  timestamp: "2026-08-12T00:01:59.000Z",
});

describe("release witness observation", () => {
  it("accepts a provider job created during the request before its durable observation", async () => {
    const renderFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/jobs/job-1")) return json(renderJob("succeeded"));
      if (url.endsWith("/services/srv-1")) return json(renderService);
      return json({ logs: [cleanupLog()] });
    });

    await expect(
      new RenderCleanupObservationAdapter(
        "render-read-only",
        renderFetch,
      ).observe(seed),
    ).resolves.toMatchObject({
      providerCreatedAt: "2026-08-12T00:00:01.000Z",
    });
  });

  it.each([
    ["exact boundary", "2026-08-12T00:00:01.000Z", true],
    ["two milliseconds after", "2026-08-12T00:00:01.002Z", false],
  ] as const)(
    "enforces the provider creation %s",
    async (_label, notBefore, accepted) => {
      const boundarySeed = { ...seed, providerCreationNotBefore: notBefore };
      const renderFetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes("/jobs/job-1")) return json(renderJob("succeeded"));
        if (url.endsWith("/services/srv-1")) return json(renderService);
        return json({ logs: [cleanupLog()] });
      });
      const observation = new RenderCleanupObservationAdapter(
        "render-read-only",
        renderFetch,
      ).observe(boundarySeed);

      if (accepted) await expect(observation).resolves.toBeDefined();
      else
        await expect(observation).rejects.toThrow(
          "release_witness_terminal_window_invalid",
        );
    },
  );

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

  it.each(["succeeded", "failed", "canceled"] as const)(
    "derives exact cleanup safety evidence for a %s provider job without rewriting its outcome",
    async (providerStatus) => {
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
      const renderFetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes("/jobs/job-1")) return json(renderJob(providerStatus));
        if (url.endsWith("/services/srv-1")) return json(renderService);
        return json({ logs: [cleanupLog()] });
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
        (value) =>
          typeof value === "string" && value.includes('"providerLogId"'),
      );
      const persistedEvidence = JSON.parse(String(persisted)) as Record<
        string,
        unknown
      >;
      expect(persistedEvidence).toMatchObject({
        jobId: seed.jobId,
        canary: seed.cleanupCanary,
        providerStatus,
        containerTerminated: true,
        removedPaths: ["/runner/_work/rr-runner/repository"],
        remainingPaths: [],
        providerLogId: "log-1",
        providerCreatedAt: "2026-08-12T00:00:01.000Z",
        providerObservedAt: "2026-08-12T00:01:59.000Z",
      });
      expect(persistedEvidence).not.toHaveProperty("rolloutOutcome");
      expect(persistedEvidence).not.toHaveProperty("outcome");
      if (providerStatus !== "succeeded")
        expect(String(persisted)).not.toContain('"providerStatus":"succeeded"');
      expect(String(persisted)).not.toContain("render-read-only");
      await app.close();
    },
  );

  it("rejects an active provider job even when a matching cleanup log exists", async () => {
    const prisma = {
      $queryRaw: vi.fn().mockResolvedValueOnce([{ value: seed }]),
    };
    const renderFetch = vi.fn().mockResolvedValue(json(renderJob("running")));
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

    expect(response.statusCode).toBe(500);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(renderFetch).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it.each([
    { label: "missing", logs: [] },
    { label: "ambiguous", logs: [cleanupLog("log-1"), cleanupLog("log-2")] },
  ])(
    "rejects $label exact cleanup evidence for a failed job",
    async ({ logs }) => {
      const prisma = {
        $queryRaw: vi.fn().mockResolvedValueOnce([{ value: seed }]),
      };
      const renderFetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes("/jobs/job-1")) return json(renderJob("failed"));
        if (url.endsWith("/services/srv-1")) return json(renderService);
        return json({ logs });
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

      expect(response.statusCode).toBe(500);
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
      await app.close();
    },
  );
});
