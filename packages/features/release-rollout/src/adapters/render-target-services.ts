import { randomBytes } from "node:crypto";
import {
  RolloutStep,
  type StepObservation,
  type TargetSwitchFence,
} from "../domain/release-rollout";
import { RenderApiAdapter, type RenderFetch } from "./render-api";

export type TargetServiceExpectation = {
  readonly serviceId: string;
  readonly provenance:
    | { readonly kind: "git"; readonly commitSha: string }
    | { readonly kind: "image"; readonly imageSha: string };
  readonly databaseEnvKey: string;
  readonly databaseName: string;
  readonly databaseRole: string;
};
const active = new Set([
  "created",
  "queued",
  "build_in_progress",
  "update_in_progress",
  "pre_deploy_in_progress",
]);
export class RenderTargetServicesAdapter {
  private readonly consumedCanaryNonces = new Set<string>();
  constructor(
    private readonly fetchImpl: RenderFetch = fetch,
    private readonly sleep: (milliseconds: number) => Promise<void> = (
      milliseconds,
    ) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    private readonly now: () => Date = () => new Date(),
  ) {}
  async stage(input: {
    apiKey: string;
    targetInternalHostname: string;
    targetSystemIdentifier: string;
    targetDatabaseUrls: Readonly<Record<string, string>>;
    releaseCommitSha: string;
    services: readonly TargetServiceExpectation[];
    fence: TargetSwitchFence;
  }): Promise<StepObservation> {
    if (
      !input.apiKey ||
      !/\.internal$/u.test(input.targetInternalHostname) ||
      !/^[0-9]+$/u.test(input.targetSystemIdentifier) ||
      !/^[a-f0-9]{40}$/u.test(input.releaseCommitSha) ||
      input.fence.expectedCommitSha !== input.releaseCommitSha ||
      input.fence.targetSystemIdentifier !== input.targetSystemIdentifier ||
      !/^[a-f0-9]{32}$/u.test(input.fence.nonce) ||
      input.fence.version < 1 ||
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
      if (
        !/^[A-Za-z_][A-Za-z0-9_-]*$/u.test(expected.databaseName) ||
        !/^[A-Za-z_][A-Za-z0-9_-]*$/u.test(expected.databaseRole)
      )
        throw new Error("render_target_database_expectation_invalid");
      const service = await api.getService(expected.serviceId);
      if (service.autoDeploy !== "no")
        throw new Error("render_target_auto_deploy_enabled");
      const deploys = await api.listAllDeploys(expected.serviceId);
      if (deploys.some((deploy) => active.has(deploy.status)))
        throw new Error("render_target_active_deploy_present");
      const latest = deploys.find((deploy) => deploy.status === "live");
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
        let suspended = await api.getService(expected.serviceId);
        for (
          let poll = 0;
          suspended.suspended !== "suspended" && poll < 29;
          poll += 1
        ) {
          await this.sleep(2_000);
          suspended = await api.getService(expected.serviceId);
        }
        if (suspended.suspended !== "suspended")
          throw new Error("render_target_suspend_unproven");
      }
      const replacement = input.targetDatabaseUrls[expected.serviceId];
      if (!replacement) throw new Error("render_target_database_url_missing");
      let databaseUrl: URL;
      try {
        databaseUrl = new URL(replacement ?? "");
      } catch {
        throw new Error("render_target_database_url_invalid");
      }
      if (
        !["postgres:", "postgresql:"].includes(databaseUrl.protocol) ||
        databaseUrl.hostname !== input.targetInternalHostname ||
        decodeURIComponent(databaseUrl.pathname.slice(1)) !==
          expected.databaseName ||
        decodeURIComponent(databaseUrl.username) !== expected.databaseRole
      )
        throw new Error("render_target_database_binding_mismatch");
      const envReplacement = await api.replaceEnvPreservingAll(
        expected.serviceId,
        { [expected.databaseEnvKey]: replacement },
      );
      const created = await api.createDeploy(expected.serviceId);
      let rechecked = await api.listAllDeploys(expected.serviceId);
      let pinned = rechecked.find((deploy) => deploy.id === created.id);
      for (let poll = 0; pinned?.status !== "live" && poll < 44; poll += 1) {
        if (pinned && !active.has(pinned.status)) break;
        await this.sleep(2_000);
        rechecked = await api.listAllDeploys(expected.serviceId);
        pinned = rechecked.find((deploy) => deploy.id === created.id);
      }
      if (
        rechecked.some(
          (deploy) => deploy.id !== created.id && active.has(deploy.status),
        ) ||
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
        deployId: created.id,
        provenance: expected.provenance,
        envSha256: envReplacement.afterSha256,
        previousEnvSha256: envReplacement.beforeSha256,
        databaseHostname: databaseUrl.hostname,
        databaseName: expected.databaseName,
        databaseRole: expected.databaseRole,
        databaseSystemIdentifier: input.targetSystemIdentifier,
        suspended: true,
        targetSwitchFenceNonce: input.fence.nonce,
        targetSwitchFenceVersion: input.fence.version,
      });
    }
    return {
      step: RolloutStep.StageTargetServices,
      observedAt: new Date().toISOString(),
      facts: Object.freeze(facts),
      provider: {
        renderServiceIds: Object.freeze(facts.map((item) => item.serviceId)),
        renderDeployIds: Object.freeze(facts.map((item) => item.deployId)),
        targetSwitchFenceNonce: input.fence.nonce,
        targetSwitchFenceVersion: input.fence.version,
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
      let service = await api.getService(expected.serviceId);
      for (
        let poll = 0;
        service.suspended !== "not_suspended" && poll < 29;
        poll += 1
      ) {
        await this.sleep(2_000);
        service = await api.getService(expected.serviceId);
      }
      if (service.suspended !== "not_suspended" || service.autoDeploy !== "no")
        throw new Error("render_target_resume_unproven");
      const deploys = await api.listAllDeploys(expected.serviceId);
      if (deploys.some((deploy) => active.has(deploy.status)))
        throw new Error("render_target_active_deploy_present");
      const latest = deploys.find((deploy) => deploy.status === "live");
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
    rolloutId: string;
    bearerToken: string;
    fetchImpl?: RenderFetch;
  }): Promise<StepObservation> {
    if (
      !input.url.startsWith("https://") ||
      !input.bearerToken ||
      !/^[A-Za-z0-9][A-Za-z0-9._:/-]{2,255}$/u.test(input.rolloutId)
    )
      throw new Error("render_target_canary_url_invalid");
    const nonce = randomBytes(24).toString("hex");
    const requestedAt = this.now().toISOString();
    const response = await (input.fetchImpl ?? this.fetchImpl)(input.url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${input.bearerToken}`,
        "Cache-Control": "no-store",
      },
      body: JSON.stringify({
        rolloutId: input.rolloutId,
        nonce,
        requestedAt,
      }),
    });
    if (!response.ok)
      throw new Error(`render_target_canary_failed:${response.status}`);
    const value = (await response.json()) as Record<string, unknown>;
    if (
      value.commitSha !== input.expectedCommitSha ||
      value.databaseSystemIdentifier !== input.expectedSystemIdentifier ||
      value.writeReadRoundTrip !== true ||
      value.rolloutId !== input.rolloutId ||
      value.nonce !== nonce ||
      value.requestedAt !== requestedAt ||
      typeof value.observedAt !== "string" ||
      !response.headers.get("cache-control")?.includes("no-store") ||
      this.consumedCanaryNonces.has(nonce) ||
      Date.parse(value.observedAt) < Date.parse(requestedAt) ||
      Date.parse(value.observedAt) > this.now().getTime() + 30_000
    )
      throw new Error("render_target_canary_identity_mismatch");
    this.consumedCanaryNonces.add(nonce);
    return {
      step: RolloutStep.VerifyLiveCanary,
      observedAt: new Date().toISOString(),
      facts: {
        commitSha: value.commitSha,
        databaseSystemIdentifier: value.databaseSystemIdentifier,
        writeReadRoundTrip: true,
        rolloutId: input.rolloutId,
        nonce,
        requestedAt,
        observedAt: value.observedAt,
      },
    };
  }
}
