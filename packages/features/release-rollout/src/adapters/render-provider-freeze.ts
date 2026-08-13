import { RolloutStep, type StepObservation } from "../domain/release-rollout";
import { RenderApiAdapter, type RenderFetch } from "./render-api";
import { createHash } from "node:crypto";
import {
  ProviderAuthorityOperation,
  type DatabaseAclWitness,
  type ProviderAuthorityDecision,
  type ProviderStateWitness,
} from "../application/ports";
import { sourceWriterServiceIdsAreValid } from "../domain/source-writer-service-ids";

const active = new Set([
  "created",
  "queued",
  "build_in_progress",
  "update_in_progress",
  "pre_deploy_in_progress",
]);
export class RenderProviderFreezeAdapter {
  constructor(
    private readonly fetchImpl: RenderFetch = fetch,
    private readonly sleep: (milliseconds: number) => Promise<void> = (
      milliseconds,
    ) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  ) {}
  async freezeAndObserve(input: {
    apiKey: string;
    ownerId: string;
    sourceWriterServiceIds: readonly string[];
    prepareMutation?: (evidence: {
      serviceId: string;
      latestSuccessfulDeployId: string;
      observedAt: string;
      beforeSuspended: boolean;
    }) => Promise<boolean>;
    recordMutation?: (evidence: {
      serviceId: string;
      latestSuccessfulDeployId: string;
      observedAt: string;
    }) => Promise<void>;
  }): Promise<StepObservation> {
    if (
      !input.apiKey ||
      !input.ownerId ||
      !sourceWriterServiceIdsAreValid(input.sourceWriterServiceIds)
    )
      throw new Error("render_freeze_context_invalid");
    const api = new RenderApiAdapter(input.apiKey, this.fetchImpl);
    const declared = [...input.sourceWriterServiceIds].sort();
    const ownerServices = (await api.listAllServices()).filter(
      (service) => service.ownerId === input.ownerId,
    );
    const credentialBearing: Array<{
      serviceId: string;
      serviceType: string;
      credentialKeys: readonly string[];
    }> = [];
    for (const service of ownerServices) {
      const credentialKeys = (await api.listAllEnv(service.id))
        .map(({ key }) => key)
        .filter((key) =>
          /(?:DATABASE(?:_URL|_HOST|_PASSWORD|_NAME)?|DIRECT_URL|PGHOST|PGPASSWORD|PGDATABASE)/u.test(
            key,
          ),
        )
        .sort();
      if (credentialKeys.length)
        credentialBearing.push({
          serviceId: service.id,
          serviceType: service.type,
          credentialKeys: Object.freeze(credentialKeys),
        });
    }
    const discovered = credentialBearing
      .map(({ serviceId }) => serviceId)
      .sort();
    if (JSON.stringify(discovered) !== JSON.stringify(declared))
      throw new Error("render_freeze_writer_inventory_mismatch");
    const inventorySha256 = `sha256:${createHash("sha256")
      .update(JSON.stringify(credentialBearing))
      .digest("hex")}`;
    const observations = [];
    const durablyRecordedMutationIds: string[] = [];
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
      const latestSuccessfulDeployId = deploys.find(
        (deploy) => deploy.status === "live",
      )!.id;
      const mutationRequired = input.prepareMutation
        ? await input.prepareMutation({
            serviceId,
            latestSuccessfulDeployId,
            observedAt: new Date().toISOString(),
            beforeSuspended: before.suspended === "suspended",
          })
        : before.suspended !== "suspended";
      if (mutationRequired && before.suspended !== "suspended")
        await api.suspend(serviceId);
      if (!mutationRequired && before.suspended !== "suspended")
        throw new Error("render_freeze_preparation_state_contradiction");
      let after = await api.getService(serviceId);
      for (
        let poll = 0;
        after.suspended !== "suspended" && poll < 29;
        poll += 1
      ) {
        await this.sleep(2_000);
        after = await api.getService(serviceId);
      }
      if (after.suspended !== "suspended" || after.autoDeploy !== "no")
        throw new Error("render_freeze_suspension_unproven");
      const serviceObservation = {
        serviceId,
        suspended: true as const,
        observedAt: new Date().toISOString(),
        latestSuccessfulDeployId,
      };
      if (mutationRequired && input.recordMutation) {
        await input.recordMutation(serviceObservation);
        durablyRecordedMutationIds.push(serviceId);
      }
      observations.push(serviceObservation);
    }
    return Object.freeze({
      step: RolloutStep.FreezeProviderServices,
      observedAt: new Date().toISOString(),
      facts: {
        services: Object.freeze(observations),
        writerInventory: Object.freeze(credentialBearing),
        writerInventorySha256: inventorySha256,
        complete: true,
      },
      provider: {
        renderServiceIds: Object.freeze(
          observations.map((item) => item.serviceId),
        ),
        renderDeployIds: Object.freeze(
          observations.map((item) => item.latestSuccessfulDeployId),
        ),
        renderMutatedServiceIds: Object.freeze(durablyRecordedMutationIds),
      },
    });
  }

  async compensateAndObserve(input: {
    apiKey: string;
    sourceWriterServiceIds: readonly string[];
    sourceSystemIdentifier: string;
    decision: ProviderAuthorityDecision;
    databaseWitness: DatabaseAclWitness;
  }): Promise<ProviderStateWitness> {
    if (
      !input.apiKey ||
      !sourceWriterServiceIdsAreValid(input.sourceWriterServiceIds) ||
      input.decision.decision !== "allow" ||
      input.decision.operation !== ProviderAuthorityOperation.ResumeSource ||
      input.decision.sourceSystemIdentifier !== input.sourceSystemIdentifier ||
      input.decision.activationBoundary !== "before" ||
      input.databaseWitness.systemIdentifier !== input.sourceSystemIdentifier ||
      input.databaseWitness.sourceWritesRestored !== true ||
      !/^sha256:[a-f0-9]{64}$/u.test(input.databaseWitness.aclSha256)
    )
      throw new Error("render_source_compensation_authority_invalid");
    const api = new RenderApiAdapter(input.apiKey, this.fetchImpl);
    const deployIds: string[] = [];
    for (const serviceId of input.sourceWriterServiceIds) {
      const before = await api.getService(serviceId);
      if (
        !["suspended", "not_suspended"].includes(before.suspended) ||
        before.autoDeploy !== "no"
      )
        throw new Error("render_source_compensation_precondition_invalid");
      const deploys = await api.listAllDeploys(serviceId);
      if (deploys.some((deploy) => active.has(deploy.status)))
        throw new Error("render_source_compensation_deploy_state_unsafe");
      const latest = deploys.find((deploy) => deploy.status === "live");
      if (!latest)
        throw new Error("render_source_compensation_live_deploy_missing");
      if (before.suspended === "suspended") await api.resume(serviceId);
      let after = await api.getService(serviceId);
      for (
        let poll = 0;
        after.suspended !== "not_suspended" && poll < 29;
        poll += 1
      ) {
        await this.sleep(2_000);
        after = await api.getService(serviceId);
      }
      if (after.suspended !== "not_suspended" || after.autoDeploy !== "no")
        throw new Error("render_source_compensation_resume_unproven");
      deployIds.push(latest.id);
    }
    return Object.freeze({
      serviceIds: Object.freeze([...input.sourceWriterServiceIds]),
      deployIds: Object.freeze(deployIds),
      observedAt: new Date().toISOString(),
      resumed: true as const,
    });
  }
}
