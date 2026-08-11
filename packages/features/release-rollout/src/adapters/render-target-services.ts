import {
  RolloutStep,
  sha256Canonical,
  type StepReceipt,
} from "../domain/release-rollout";
import type { RenderFetch } from "./render-private-runner";

export interface TargetServiceExpectation {
  readonly serviceId: string;
  readonly deployId: string;
  readonly imageDigest: string;
}

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

export class RenderTargetServicesAdapter {
  constructor(private readonly fetchImpl: RenderFetch = fetch) {}

  async stage(input: {
    apiKey: string;
    targetDatabaseResourceId: string;
    releaseCommitSha: string;
    services: readonly TargetServiceExpectation[];
  }): Promise<StepReceipt> {
    if (
      !input.apiKey ||
      !/^dpg-[A-Za-z0-9-]+$/u.test(input.targetDatabaseResourceId) ||
      !/^[a-f0-9]{40}$/u.test(input.releaseCommitSha) ||
      input.services.length === 0
    )
      throw new Error("render_target_stage_context_invalid");
    const observations = [];
    for (const expected of input.services) {
      if (
        !/^srv-[A-Za-z0-9-]+$/u.test(expected.serviceId) ||
        !/^dep-[A-Za-z0-9-]+$/u.test(expected.deployId) ||
        !/^sha256:[a-f0-9]{64}$/u.test(expected.imageDigest)
      )
        throw new Error("render_target_stage_identity_invalid");
      const headers = {
        Authorization: `Bearer ${input.apiKey}`,
        Accept: "application/json",
      };
      let response = await this.fetchImpl(
        `https://api.render.com/v1/services/${expected.serviceId}`,
        { headers },
      );
      if (!response.ok)
        throw new Error("render_target_stage_observation_failed");
      let service = (await response.json()) as unknown;
      if (
        exact(service, ["id", "suspended", "serviceDetails"]) &&
        service.suspended === "not_suspended"
      ) {
        const suspend = await this.fetchImpl(
          `https://api.render.com/v1/services/${expected.serviceId}/suspend`,
          { method: "POST", headers },
        );
        if (!suspend.ok) throw new Error("render_target_suspend_failed");
        response = await this.fetchImpl(
          `https://api.render.com/v1/services/${expected.serviceId}`,
          { headers },
        );
        if (!response.ok)
          throw new Error("render_target_stage_observation_failed");
        service = (await response.json()) as unknown;
      }
      if (
        !exact(service, ["id", "suspended", "serviceDetails"]) ||
        service.id !== expected.serviceId ||
        service.suspended !== "suspended" ||
        !exact(service.serviceDetails, [
          "deployId",
          "imageDigest",
          "commitSha",
          "envSpecificDetails",
        ]) ||
        service.serviceDetails.deployId !== expected.deployId ||
        service.serviceDetails.imageDigest !== expected.imageDigest ||
        service.serviceDetails.commitSha !== input.releaseCommitSha ||
        !exact(service.serviceDetails.envSpecificDetails, [
          "databaseResourceId",
          "preDeployCommand",
        ]) ||
        service.serviceDetails.envSpecificDetails.databaseResourceId !==
          input.targetDatabaseResourceId ||
        service.serviceDetails.envSpecificDetails.preDeployCommand !== ""
      )
        throw new Error("render_target_stage_observation_mismatch");
      observations.push({ ...expected, suspended: true });
    }
    return Object.freeze({
      step: RolloutStep.StageTargetServices,
      receiptId: `render-target-stage-${sha256Canonical(observations).slice(0, 24)}`,
      observedAt: new Date().toISOString(),
      payloadSha256: `sha256:${sha256Canonical(observations)}`,
    });
  }
}
