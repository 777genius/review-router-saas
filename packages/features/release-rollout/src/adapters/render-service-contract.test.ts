import { describe, expect, it } from "vitest";
import type { RenderService } from "./render-api";
import { RenderServiceContractMatcher } from "./render-service-contract";

const sourceContract = {
  serviceId: "srv-source",
  runtime: "node" as const,
  imagePath: null,
  repository: "https://example.test/reviewrouter.git",
  branch: "main",
  rootDir: "apps/api",
  buildCommand: "pnpm build",
  startCommand: "pnpm start",
  preDeployCommand: "",
  healthCheckPath: "/health",
  region: "oregon",
  plan: "starter",
  maxShutdownDelaySeconds: 60,
  numInstances: 2,
  autoDeploy: "no" as const,
  autoDeployTrigger: "off" as const,
};

const sourceService = (): RenderService => ({
  id: sourceContract.serviceId,
  ownerId: "tea-owner",
  type: "web_service",
  repo: sourceContract.repository,
  branch: sourceContract.branch,
  rootDir: sourceContract.rootDir,
  suspended: "suspended",
  autoDeploy: sourceContract.autoDeploy,
  autoDeployTrigger: sourceContract.autoDeployTrigger,
  serviceDetails: {
    runtime: sourceContract.runtime,
    envSpecificDetails: {
      buildCommand: sourceContract.buildCommand,
      startCommand: sourceContract.startCommand,
      preDeployCommand: sourceContract.preDeployCommand,
      healthCheckPath: sourceContract.healthCheckPath,
    },
    region: sourceContract.region,
    plan: sourceContract.plan,
    maxShutdownDelaySeconds: sourceContract.maxShutdownDelaySeconds,
    numInstances: sourceContract.numInstances,
  },
});

describe("Render service contract postcondition", () => {
  it("accepts a complete source contract with no image aliases", () => {
    expect(
      new RenderServiceContractMatcher(sourceContract).matches(sourceService()),
    ).toBe(true);
  });

  it.each([
    [
      "image",
      (service: RenderService) => ({ ...service, imagePath: "stale-image" }),
    ],
    ["repository", (service: RenderService) => ({ ...service, repo: "other" })],
    ["branch", (service: RenderService) => ({ ...service, branch: "other" })],
    [
      "root directory",
      (service: RenderService) => ({ ...service, rootDir: "other" }),
    ],
    [
      "auto deploy",
      (service: RenderService) => ({ ...service, autoDeploy: "yes" as const }),
    ],
    [
      "auto deploy trigger",
      (service: RenderService) => ({
        ...service,
        autoDeployTrigger: "commit" as const,
      }),
    ],
    [
      "runtime",
      (service: RenderService) => ({
        ...service,
        serviceDetails: { ...service.serviceDetails, runtime: "image" },
      }),
    ],
    [
      "build command",
      (service: RenderService) => ({
        ...service,
        serviceDetails: {
          ...service.serviceDetails,
          envSpecificDetails: {
            ...(service.serviceDetails.envSpecificDetails as object),
            buildCommand: "other",
          },
        },
      }),
    ],
    [
      "start command",
      (service: RenderService) => ({
        ...service,
        serviceDetails: {
          ...service.serviceDetails,
          envSpecificDetails: {
            ...(service.serviceDetails.envSpecificDetails as object),
            startCommand: "other",
          },
        },
      }),
    ],
    [
      "pre-deploy command",
      (service: RenderService) => ({
        ...service,
        serviceDetails: {
          ...service.serviceDetails,
          envSpecificDetails: {
            ...(service.serviceDetails.envSpecificDetails as object),
            preDeployCommand: "other",
          },
        },
      }),
    ],
    [
      "health check",
      (service: RenderService) => ({
        ...service,
        serviceDetails: {
          ...service.serviceDetails,
          envSpecificDetails: {
            ...(service.serviceDetails.envSpecificDetails as object),
            healthCheckPath: "/other",
          },
        },
      }),
    ],
    [
      "region",
      (service: RenderService) => ({
        ...service,
        serviceDetails: { ...service.serviceDetails, region: "other" },
      }),
    ],
    [
      "plan",
      (service: RenderService) => ({
        ...service,
        serviceDetails: { ...service.serviceDetails, plan: "other" },
      }),
    ],
    [
      "shutdown delay",
      (service: RenderService) => ({
        ...service,
        serviceDetails: {
          ...service.serviceDetails,
          maxShutdownDelaySeconds: 30,
        },
      }),
    ],
    [
      "instance count",
      (service: RenderService) => ({
        ...service,
        serviceDetails: { ...service.serviceDetails, numInstances: 1 },
      }),
    ],
  ])(
    "rejects a partial source application with the wrong %s",
    (_field, mutate) => {
      const matcher = new RenderServiceContractMatcher(sourceContract);
      expect(matcher.matches(mutate(sourceService()))).toBe(false);
    },
  );

  it.each(["autoDeployTrigger", "runtime", "preDeployCommand", "numInstances"])(
    "fails closed when the provider omits %s",
    (field) => {
      const service = sourceService();
      if (field === "autoDeployTrigger")
        delete (service as { autoDeployTrigger?: string }).autoDeployTrigger;
      else if (field === "runtime") delete service.serviceDetails.runtime;
      else if (field === "numInstances")
        delete service.serviceDetails.numInstances;
      else
        delete (
          service.serviceDetails.envSpecificDetails as Record<string, unknown>
        ).preDeployCommand;

      expect(
        new RenderServiceContractMatcher(sourceContract).matches(service),
      ).toBe(false);
    },
  );

  it.each([
    [
      "runtime",
      (service: RenderService) => {
        service.serviceDetails.envSpecificDetails = {
          ...(service.serviceDetails.envSpecificDetails as object),
          runtime: "image",
        };
      },
    ],
    [
      "pre-deploy command",
      (service: RenderService) => {
        service.serviceDetails.preDeployCommand = "other";
      },
    ],
    [
      "health check path",
      (service: RenderService) => {
        service.serviceDetails.healthCheckPath = "/other";
      },
    ],
    [
      "image path",
      (service: RenderService) => {
        const mutable = service as unknown as Record<string, unknown>;
        mutable.imagePath = "stale-image";
        mutable.image = { imagePath: "different-stale-image" };
      },
    ],
  ])("rejects conflicting %s aliases", (_field, addConflict) => {
    const service = sourceService();
    addConflict(service);

    expect(
      new RenderServiceContractMatcher(sourceContract).matches(service),
    ).toBe(false);
  });

  it("requires the complete target image contract", () => {
    const matcher = new RenderServiceContractMatcher({
      serviceId: "srv-target",
      runtime: "image",
      imagePath: "registry.example.test/app@sha256:digest",
      autoDeploy: "no",
      autoDeployTrigger: "off",
      preDeployCommand: "",
    });
    const complete: RenderService = {
      id: "srv-target",
      ownerId: "tea-owner",
      type: "web_service",
      suspended: "suspended",
      autoDeploy: "no",
      autoDeployTrigger: "off",
      image: { imagePath: "registry.example.test/app@sha256:digest" },
      serviceDetails: { runtime: "image", preDeployCommand: "" },
    };
    const { autoDeployTrigger: _omitted, ...missingTrigger } = complete;

    expect(matcher.matches(complete)).toBe(true);
    expect(matcher.matches(missingTrigger)).toBe(false);
    expect(
      matcher.matches({
        ...complete,
        serviceDetails: { ...complete.serviceDetails, runtime: "unknown" },
      }),
    ).toBe(false);
    expect(
      matcher.matches({ ...complete, image: { imagePath: "other" } }),
    ).toBe(false);
  });
});
