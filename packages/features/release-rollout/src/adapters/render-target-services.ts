import { createHash } from "node:crypto";
import { RolloutStep, type StepObservation } from "../domain/release-rollout";
import { RenderApiAdapter, type RenderFetch } from "./render-api";

export type TargetServiceExpectation = {
  readonly serviceId: string;
  readonly provenance:
    | { readonly kind: "git"; readonly commitSha: string }
    | { readonly kind: "image"; readonly imageSha: string };
  readonly databaseEnvKey: string;
};
const digest = (value: unknown) =>
  `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
const active = new Set([
  "created",
  "build_in_progress",
  "update_in_progress",
  "pre_deploy_in_progress",
]);
export class RenderTargetServicesAdapter {
  constructor(private readonly fetchImpl: RenderFetch = fetch) {}
  async stage(input: {
    apiKey: string;
    targetInternalHostname: string;
    releaseCommitSha: string;
    services: readonly TargetServiceExpectation[];
  }): Promise<StepObservation> {
    if (
      !input.apiKey ||
      !/\.internal$/u.test(input.targetInternalHostname) ||
      !/^[a-f0-9]{40}$/u.test(input.releaseCommitSha) ||
      !input.services.length
    )
      throw new Error("render_target_stage_context_invalid");
    const api = new RenderApiAdapter(input.apiKey, this.fetchImpl);
    const facts = [];
    for (const expected of input.services) {
      if (
        expected.provenance.kind === "git" &&
        expected.provenance.commitSha !== input.releaseCommitSha
      )
        throw new Error("render_target_release_commit_mismatch");
      const service = await api.getService(expected.serviceId);
      if (service.autoDeploy !== "no")
        throw new Error("render_target_auto_deploy_enabled");
      const deploys = await api.listDeploys(expected.serviceId);
      if (deploys.items.some((deploy) => active.has(deploy.status)))
        throw new Error("render_target_active_deploy_present");
      const latest = deploys.items.find((deploy) => deploy.status === "live");
      if (!latest) throw new Error("render_target_successful_deploy_missing");
      if (
        expected.provenance.kind === "git"
          ? latest.commit?.id !== expected.provenance.commitSha ||
            latest.image !== undefined
          : latest.image?.sha !== expected.provenance.imageSha ||
            latest.commit !== undefined
      )
        throw new Error("render_target_provenance_mismatch");
      if (service.suspended !== "suspended") {
        await api.suspend(expected.serviceId);
        if (
          (await api.getService(expected.serviceId)).suspended !== "suspended"
        )
          throw new Error("render_target_suspend_unproven");
      }
      const env = [];
      let cursor: string | undefined;
      do {
        const page = await api.getEnv(expected.serviceId, cursor);
        env.push(...page.items);
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      const database = env.find((item) => item.key === expected.databaseEnvKey);
      if (!database || !database.value.includes(input.targetInternalHostname))
        throw new Error("render_target_database_binding_mismatch");
      const rechecked = await api.listDeploys(expected.serviceId);
      const pinned = rechecked.items.find((deploy) => deploy.id === latest.id);
      if (
        rechecked.items.some((deploy) => active.has(deploy.status)) ||
        pinned?.status !== "live" ||
        (expected.provenance.kind === "git"
          ? pinned.commit?.id !== expected.provenance.commitSha ||
            pinned.image !== undefined
          : pinned.image?.sha !== expected.provenance.imageSha ||
            pinned.commit !== undefined)
      )
        throw new Error("render_target_deploy_race_detected");
      facts.push({
        serviceId: expected.serviceId,
        deployId: latest.id,
        provenance: expected.provenance,
        envSha256: digest(env.sort((a, b) => a.key.localeCompare(b.key))),
        suspended: true,
      });
    }
    return {
      step: RolloutStep.StageTargetServices,
      observedAt: new Date().toISOString(),
      facts: Object.freeze(facts),
      provider: {
        renderServiceIds: Object.freeze(facts.map((item) => item.serviceId)),
        renderDeployIds: Object.freeze(facts.map((item) => item.deployId)),
      },
    };
  }

  async resumeDeployAndObserve(input: {
    apiKey: string;
    services: readonly TargetServiceExpectation[];
  }): Promise<StepObservation> {
    const api = new RenderApiAdapter(input.apiKey, this.fetchImpl);
    const facts = [];
    for (const expected of input.services) {
      await api.resume(expected.serviceId);
      const service = await api.getService(expected.serviceId);
      if (service.suspended !== "not_suspended" || service.autoDeploy !== "no")
        throw new Error("render_target_resume_unproven");
      const deploys = await api.listDeploys(expected.serviceId);
      const latest = deploys.items.find((deploy) => deploy.status === "live");
      if (!latest) throw new Error("render_target_live_deploy_missing");
      if (
        expected.provenance.kind === "git"
          ? latest.commit?.id !== expected.provenance.commitSha ||
            latest.image !== undefined
          : latest.image?.sha !== expected.provenance.imageSha ||
            latest.commit !== undefined
      )
        throw new Error("render_target_live_deploy_provenance_mismatch");
      facts.push({
        serviceId: expected.serviceId,
        deployId: latest.id,
        resumed: true,
      });
    }
    return {
      step: RolloutStep.ResumeTargetServices,
      observedAt: new Date().toISOString(),
      facts,
      provider: {
        renderServiceIds: Object.freeze(facts.map((item) => item.serviceId)),
        renderDeployIds: Object.freeze(facts.map((item) => item.deployId)),
      },
    };
  }

  async verifyLiveCanary(input: {
    url: string;
    expectedCommitSha: string;
    expectedSystemIdentifier: string;
    fetchImpl?: RenderFetch;
  }): Promise<StepObservation> {
    if (!input.url.startsWith("https://"))
      throw new Error("render_target_canary_url_invalid");
    const response = await (input.fetchImpl ?? this.fetchImpl)(input.url, {
      headers: { Accept: "application/json" },
    });
    if (!response.ok)
      throw new Error(`render_target_canary_failed:${response.status}`);
    const value = (await response.json()) as Record<string, unknown>;
    if (
      value.commitSha !== input.expectedCommitSha ||
      value.databaseSystemIdentifier !== input.expectedSystemIdentifier ||
      value.writeReadRoundTrip !== true
    )
      throw new Error("render_target_canary_identity_mismatch");
    return {
      step: RolloutStep.VerifyLiveCanary,
      observedAt: new Date().toISOString(),
      facts: {
        commitSha: value.commitSha,
        databaseSystemIdentifier: value.databaseSystemIdentifier,
        writeReadRoundTrip: true,
      },
    };
  }
}
