import { describe, expect, it, vi } from "vitest";
import { RenderTransactionalServicesAdapter as ProductionRenderTransactionalServicesAdapter } from "./render-transactional-services";
import type { RenderService } from "./render-api";
import { TestProviderMutationAuthority } from "../test-provider-mutation-authority";

class RenderTransactionalServicesAdapter extends ProductionRenderTransactionalServicesAdapter {
  constructor(
    apiKey: string,
    fetchImpl?: typeof fetch,
    sleep?: (milliseconds: number) => Promise<void>,
  ) {
    super(apiKey, fetchImpl, sleep, new TestProviderMutationAuthority(), {
      rolloutId: "test-rollout",
      ownerId: "test-owner",
    });
  }
}

const serviceId = "srv-transactional";
const commitSha = "a".repeat(40);
const imageUrl = `registry.example.test/review-router@sha256:${"b".repeat(64)}`;
const targetContract = {
  serviceId,
  artifact: { kind: "container_image" as const, reference: imageUrl },
  environmentDelta: {},
  removeKeys: [],
  environmentSha256: `sha256:${"c".repeat(64)}`,
  configurationSha256: `sha256:${"d".repeat(64)}`,
};
const sourceService = (): RenderService => ({
  id: serviceId,
  ownerId: "tea-owner",
  type: "web_service",
  repo: "https://example.test/reviewrouter.git",
  branch: "main",
  rootDir: "apps/api",
  suspended: "suspended",
  autoDeploy: "no",
  autoDeployTrigger: "off",
  serviceDetails: {
    runtime: "node",
    preDeployCommand: "",
    region: "oregon",
    plan: "starter",
    maxShutdownDelaySeconds: 60,
    numInstances: 2,
  },
});
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
    ).quiesceDeployments(serviceId);

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
      ).reconcileSourceDeployment({
        serviceId,
        revision: commitSha,
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
      ).reconcileSourceDeployment({
        serviceId,
        revision: commitSha,
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
      ).reconcileSourceDeployment({
        serviceId,
        revision: commitSha,
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
      ).quiesceDeployments(serviceId),
    ).rejects.toThrow("service_transition_active_deploy_timeout");
    expect(fetchImpl).toHaveBeenCalledTimes(90);
    expect(sleep).toHaveBeenCalledTimes(90);
  });

  it("preserves the operational contract through the nested target PATCH", async () => {
    let service = sourceService();
    let patch: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn(
      async (_url: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "PATCH") {
          patch = JSON.parse(String(init.body)) as Record<string, unknown>;
          const details = patch.serviceDetails as Record<string, unknown>;
          service = {
            ...service,
            autoDeployTrigger: patch.autoDeployTrigger as "off",
            image: patch.image as { imagePath: string },
            serviceDetails: {
              runtime: details.runtime,
              preDeployCommand: details.preDeployCommand,
              region: details.region ?? "oregon-reset",
              plan: details.plan ?? "free-reset",
              maxShutdownDelaySeconds: details.maxShutdownDelaySeconds ?? 30,
              numInstances: details.numInstances ?? 1,
            },
          };
          return json({});
        }
        return json(service);
      },
    );

    await new RenderTransactionalServicesAdapter(
      "render-token",
      fetchImpl,
      async () => undefined,
    ).configureTarget(targetContract);

    expect(patch).toEqual({
      autoDeployTrigger: "off",
      image: { imagePath: imageUrl },
      serviceDetails: {
        runtime: "image",
        preDeployCommand: "",
        region: "oregon",
        plan: "starter",
        maxShutdownDelaySeconds: 60,
        numInstances: 2,
      },
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      `https://api.render.com/v1/services/${serviceId}`,
      expect.objectContaining({ method: "PATCH" }),
    );
  });

  it.each([
    "region",
    "plan",
    "maxShutdownDelaySeconds",
    "numInstances",
  ] as const)(
    "refuses a target PATCH when the current service omits %s",
    async (field) => {
      const incomplete = sourceService();
      delete incomplete.serviceDetails[field];
      const fetchImpl = vi.fn(async () => json(incomplete));

      await expect(
        new RenderTransactionalServicesAdapter(
          "render-token",
          fetchImpl,
        ).configureTarget(targetContract),
      ).rejects.toThrow("service_transition_operational_contract_incomplete");
      expect(fetchImpl).toHaveBeenCalledOnce();
    },
  );

  it("fails closed when Render resets an operational field after PATCH", async () => {
    let service = sourceService();
    const sleep = vi.fn(async () => undefined);
    const fetchImpl = vi.fn(
      async (_url: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "PATCH") {
          const patch = JSON.parse(String(init.body)) as Record<
            string,
            unknown
          >;
          const details = patch.serviceDetails as Record<string, unknown>;
          service = {
            ...service,
            autoDeployTrigger: "off",
            image: patch.image as { imagePath: string },
            serviceDetails: { ...details, numInstances: 1 },
          };
          return json({});
        }
        return json(service);
      },
    );

    await expect(
      new RenderTransactionalServicesAdapter(
        "render-token",
        fetchImpl,
        sleep,
      ).configureTarget(targetContract),
    ).rejects.toThrow("provider_mutation_forward_repair_required");
    expect(sleep).toHaveBeenCalledTimes(30);
  });

  it.each([
    {
      name: "git",
      expected: { kind: "source_revision" as const, revision: commitSha },
      observed: {
        id: "dep-git",
        status: "live",
        commit: { id: "c".repeat(40) },
      },
    },
    {
      name: "image",
      expected: { kind: "container_image" as const, reference: imageUrl },
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
        ).waitForDeployment(serviceId, observed.id, expected),
      ).rejects.toThrow("service_transition_deploy_provenance_mismatch");
      expect(fetchImpl).toHaveBeenCalledOnce();
    },
  );
});
