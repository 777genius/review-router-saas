import { RolloutStep, type StepObservation } from "../domain/release-rollout";
import { RenderApiAdapter, type RenderFetch } from "./render-api";

const active = new Set([
  "created",
  "queued",
  "build_in_progress",
  "update_in_progress",
  "pre_deploy_in_progress",
]);
export class RenderProviderFreezeAdapter {
  constructor(private readonly fetchImpl: RenderFetch = fetch) {}
  async freezeAndObserve(input: {
    apiKey: string;
    ownerId: string;
    sourceWriterServiceIds: readonly string[];
  }): Promise<StepObservation> {
    if (
      !input.apiKey ||
      !input.ownerId ||
      !input.sourceWriterServiceIds.length ||
      new Set(input.sourceWriterServiceIds).size !==
        input.sourceWriterServiceIds.length
    )
      throw new Error("render_freeze_context_invalid");
    const api = new RenderApiAdapter(input.apiKey, this.fetchImpl);
    const observations = [];
    for (const serviceId of input.sourceWriterServiceIds) {
      const before = await api.getService(serviceId);
      if (before.ownerId !== input.ownerId || before.autoDeploy !== "no")
        throw new Error("render_freeze_service_policy_mismatch");
      const deploys = await api.listAllDeploys(serviceId);
      if (
        deploys.some((deploy) => active.has(deploy.status)) ||
        !deploys.some((deploy) => deploy.status === "live")
      )
        throw new Error("render_freeze_deploy_state_unsafe");
      if (before.suspended !== "suspended") await api.suspend(serviceId);
      let after = await api.getService(serviceId);
      for (
        let poll = 0;
        after.suspended !== "suspended" && poll < 29;
        poll += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        after = await api.getService(serviceId);
      }
      if (after.suspended !== "suspended" || after.autoDeploy !== "no")
        throw new Error("render_freeze_suspension_unproven");
      observations.push({
        serviceId,
        suspended: true as const,
        observedAt: new Date().toISOString(),
        latestSuccessfulDeployId: deploys.find(
          (deploy) => deploy.status === "live",
        )!.id,
      });
    }
    return Object.freeze({
      step: RolloutStep.FreezeProviderServices,
      observedAt: new Date().toISOString(),
      facts: { services: Object.freeze(observations), complete: true },
      provider: {
        renderServiceIds: Object.freeze(
          observations.map((item) => item.serviceId),
        ),
        renderDeployIds: Object.freeze(
          observations.map((item) => item.latestSuccessfulDeployId),
        ),
      },
    });
  }
}
