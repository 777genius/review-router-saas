import { describe, expect, it, vi } from "vitest";
import { RenderTransactionalServicesAdapter } from "./render-transactional-services";

const serviceId = "srv-transactional";
const commitSha = "a".repeat(40);
const imageUrl = `registry.example.test/review-router@sha256:${"b".repeat(64)}`;
const json = (value: unknown) =>
  new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
const deployList = (
  deploys: readonly {
    readonly id: string;
    readonly status: string;
    readonly commit?: { readonly id: string };
    readonly image?: { readonly sha: string; readonly ref?: string };
    readonly createdAt?: string;
  }[],
) =>
  json(
    deploys.map((deploy) => ({
      deploy,
      cursor: null,
    })),
  );

describe("Render transactional services", () => {
  it("waits for an active deploy to become live before declaring quiescence", async () => {
    const sleep = vi.fn(async () => undefined);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        deployList([{ id: "dep-1", status: "build_in_progress" }]),
      )
      .mockResolvedValueOnce(deployList([{ id: "dep-1", status: "live" }]));

    await new RenderTransactionalServicesAdapter(
      "render-token",
      fetchImpl,
      sleep,
    ).quiesceDeploys(serviceId);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenCalledWith(
      `https://api.render.com/v1/services/${serviceId}/deploys`,
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer render-token",
        }),
      }),
    );
    expect(sleep).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(2_000);
  });

  it("reconciles the exact live commit created after the deploy intent", async () => {
    const intended = {
      id: "dep-intended",
      status: "live",
      commit: { id: commitSha },
      createdAt: "2026-08-12T00:00:00.500Z",
    };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(deployList([intended]))
      .mockResolvedValueOnce(
        deployList([
          {
            ...intended,
            id: "dep-too-old",
            createdAt: "2026-08-11T23:59:58.999Z",
          },
          {
            ...intended,
            id: "dep-wrong-commit",
            commit: { id: "c".repeat(40) },
          },
          intended,
        ]),
      );

    await expect(
      new RenderTransactionalServicesAdapter(
        "render-token",
        fetchImpl,
      ).reconcileCommitDeploy({
        serviceId,
        commitSha,
        intentAt: "2026-08-12T00:00:00.000Z",
      }),
    ).resolves.toBe("dep-intended");
  });

  it("ignores a failed candidate with the intended commit", async () => {
    const failed = {
      id: "dep-failed",
      status: "build_failed",
      commit: { id: commitSha },
      createdAt: "2026-08-12T00:00:01.000Z",
    };
    const live = {
      ...failed,
      id: "dep-live",
      status: "live",
    };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(deployList([failed, live]))
      .mockResolvedValueOnce(deployList([failed, live]));

    await expect(
      new RenderTransactionalServicesAdapter(
        "render-token",
        fetchImpl,
      ).reconcileCommitDeploy({
        serviceId,
        commitSha,
        intentAt: "2026-08-12T00:00:00.000Z",
      }),
    ).resolves.toBe("dep-live");
  });

  it("fails closed when multiple live deploys match the intent", async () => {
    const candidates = ["dep-a", "dep-b"].map((id) => ({
      id,
      status: "live",
      commit: { id: commitSha },
      createdAt: "2026-08-12T00:00:00.000Z",
    }));
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(deployList(candidates))
      .mockResolvedValueOnce(deployList(candidates));

    await expect(
      new RenderTransactionalServicesAdapter(
        "render-token",
        fetchImpl,
      ).reconcileCommitDeploy({
        serviceId,
        commitSha,
        intentAt: "2026-08-12T00:00:00.000Z",
      }),
    ).rejects.toThrow("service_transition_deploy_reconciliation_ambiguous");
  });

  it("times out when active deploys never quiesce", async () => {
    const sleep = vi.fn(async () => undefined);
    const fetchImpl = vi.fn(async () =>
      deployList([{ id: "dep-active", status: "update_in_progress" }]),
    );

    await expect(
      new RenderTransactionalServicesAdapter(
        "render-token",
        fetchImpl,
        sleep,
      ).quiesceDeploys(serviceId),
    ).rejects.toThrow("service_transition_active_deploy_timeout");
    expect(fetchImpl).toHaveBeenCalledTimes(90);
    expect(sleep).toHaveBeenCalledTimes(90);
  });

  it.each([
    {
      name: "git",
      expected: { kind: "git" as const, commitSha },
      observed: {
        id: "dep-git",
        status: "live",
        commit: { id: "c".repeat(40) },
      },
    },
    {
      name: "image",
      expected: { kind: "image" as const, imageUrl },
      observed: {
        id: "dep-image",
        status: "live",
        image: {
          sha: `sha256:${"d".repeat(64)}`,
          ref: imageUrl,
        },
      },
    },
  ])(
    "rejects an exact $name provenance mismatch",
    async ({ expected, observed }) => {
      const fetchImpl = vi.fn().mockResolvedValue(json(observed));

      await expect(
        new RenderTransactionalServicesAdapter(
          "render-token",
          fetchImpl,
        ).waitForDeploy(serviceId, observed.id, expected),
      ).rejects.toThrow("service_transition_deploy_provenance_mismatch");
      expect(fetchImpl).toHaveBeenCalledOnce();
    },
  );
});
