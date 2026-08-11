import {
  RolloutStep,
  sha256Canonical,
  type StepReceipt,
} from "../domain/release-rollout";
import type { RenderFetch } from "./render-private-runner";

const activeDeployStates = new Set([
  "build_in_progress",
  "update_in_progress",
  "pre_deploy_in_progress",
  "created",
]);
const idPattern = /^srv-[A-Za-z0-9-]+$/u;

function exact(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

export class RenderProviderFreezeAdapter {
  constructor(private readonly fetchImpl: RenderFetch = fetch) {}

  async freezeAndObserve(input: {
    serviceIds: readonly string[];
    ownerId: string;
    apiKey: string;
  }): Promise<StepReceipt> {
    if (
      !input.apiKey ||
      !/^tea-[A-Za-z0-9-]+$/u.test(input.ownerId) ||
      input.serviceIds.length === 0 ||
      new Set(input.serviceIds).size !== input.serviceIds.length ||
      input.serviceIds.some((id) => !idPattern.test(id))
    )
      throw new Error("render_freeze_context_invalid");
    const observations: unknown[] = [];
    for (const serviceId of input.serviceIds) {
      const headers = {
        Authorization: `Bearer ${input.apiKey}`,
        Accept: "application/json",
      };
      const [serviceResponse, deployResponse] = await Promise.all([
        this.fetchImpl(`https://api.render.com/v1/services/${serviceId}`, {
          headers,
        }),
        this.fetchImpl(
          `https://api.render.com/v1/services/${serviceId}/deploys?limit=20`,
          { headers },
        ),
      ]);
      if (!serviceResponse.ok || !deployResponse.ok)
        throw new Error("render_freeze_observation_failed");
      const service = (await serviceResponse.json()) as unknown;
      const deploys = (await deployResponse.json()) as unknown;
      if (
        !exact(service, [
          "id",
          "ownerId",
          "autoDeployTrigger",
          "serviceDetails",
        ]) ||
        service.id !== serviceId ||
        service.ownerId !== input.ownerId ||
        service.autoDeployTrigger !== "off" ||
        !exact(service.serviceDetails, ["envSpecificDetails"]) ||
        !exact(service.serviceDetails.envSpecificDetails, [
          "preDeployCommand",
        ]) ||
        service.serviceDetails.envSpecificDetails.preDeployCommand !== ""
      )
        throw new Error("render_service_not_frozen");
      if (
        !Array.isArray(deploys) ||
        deploys.some(
          (item) =>
            !exact(item, ["id", "status"]) ||
            typeof item.id !== "string" ||
            typeof item.status !== "string",
        ) ||
        deploys.some((item) => activeDeployStates.has(String(item.status)))
      )
        throw new Error("render_service_active_deploy_or_response_drift");
      observations.push({
        serviceId,
        autoDeployTrigger: "off",
        preDeployCommand: "",
        activeDeployCount: 0,
      });
    }
    return Object.freeze({
      step: RolloutStep.FreezeProviderServices,
      receiptId: `render-freeze-${sha256Canonical(observations).slice(0, 24)}`,
      observedAt: new Date().toISOString(),
      payloadSha256: `sha256:${sha256Canonical(observations)}`,
    });
  }
}
