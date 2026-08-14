import { randomBytes } from "node:crypto";
import {
  RolloutStep,
  type StepObservation,
  type TargetSwitchFence,
} from "../domain/release-rollout";
import { RenderApiAdapter, type RenderFetch } from "./render-api";
import {
  ProviderAuthorityOperation,
  type ProviderAuthorityDecision,
} from "../application/ports";
import { runtimeGenerationWitnessReplacement } from "./runtime-generation-witness";
import {
  BoundedProviderHttpClient,
  ProviderHttpError,
} from "./bounded-provider-io";
import type { ProviderMutationAuthorityPort } from "../application/provider-mutation-authority";
import { AuthorizedRenderMutations } from "./authorized-render-mutations";
import {
  environmentSha256,
  normalizedServicePostconditionSha256,
  sameNormalizedServicePostcondition,
  type NormalizedServicePostcondition,
} from "../domain/service-transition";
import { normalizeRenderServicePostcondition } from "./render-service-contract";

export type TargetServiceExpectation = {
  readonly serviceId: string;
  readonly provenance:
    | { readonly kind: "git"; readonly commitSha: string }
    | { readonly kind: "image"; readonly imageSha: string };
  readonly databaseEnvKey: string;
  readonly databaseName: string;
  readonly databaseRole: string;
};
export type StagedTargetService = Readonly<{
  serviceId: string;
  deployId: string;
  provenance: TargetServiceExpectation["provenance"];
  servicePostcondition: NormalizedServicePostcondition;
}>;
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
    private readonly mutationAuthority?: ProviderMutationAuthorityPort,
  ) {}
  async stage(input: {
    apiKey: string;
    targetInternalHostname: string;
    targetSystemIdentifier: string;
    targetDatabaseUrls: Readonly<Record<string, string>>;
    releaseCommitSha: string;
    targetRecoveryWitness: string;
    targetRecoveryWitnessSha256: string;
    services: readonly TargetServiceExpectation[];
    fence: TargetSwitchFence;
    decision: ProviderAuthorityDecision;
    mutationOwnerId: string;
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
      !input.services.length ||
      input.decision.decision !== "allow" ||
      input.decision.operation !== ProviderAuthorityOperation.DeployTarget ||
      input.decision.rolloutId !== input.fence.rolloutId ||
      input.decision.sourceSystemIdentifier !==
        input.fence.sourceSystemIdentifier ||
      input.decision.targetSystemIdentifier !==
        input.fence.targetSystemIdentifier ||
      input.decision.expectedReceiptSha256 !==
        input.fence.previousReceiptSha256 ||
      input.decision.activationBoundary !== "before"
    )
      throw new Error("render_target_stage_context_invalid");
    const api = new RenderApiAdapter(input.apiKey, this.fetchImpl);
    if (!this.mutationAuthority)
      throw new Error("render_mutation_authority_missing");
    const mutations = new AuthorizedRenderMutations(
      api,
      this.mutationAuthority,
      this.sleep,
    );
    const witnessReplacement = runtimeGenerationWitnessReplacement({
      witness: input.targetRecoveryWitness,
      expectedSha256: input.targetRecoveryWitnessSha256,
    });
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
        await mutations.suspend(
          {
            rolloutId: input.fence.rolloutId,
            ownerId: input.mutationOwnerId,
            operation: `target_suspend:${expected.serviceId}`,
          },
          expected.serviceId,
        );
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
      const envReplacement = await mutations.replaceEnvironment(
        {
          rolloutId: input.fence.rolloutId,
          ownerId: input.mutationOwnerId,
          operation: `target_environment:${expected.serviceId}`,
        },
        {
          serviceId: expected.serviceId,
          set: {
            [expected.databaseEnvKey]: replacement,
            ...witnessReplacement,
            REVIEW_ROUTER_RUNTIME_ROLLOUT_ID: input.fence.rolloutId,
            REVIEW_ROUTER_RUNTIME_RELEASE_COMMIT_SHA: input.releaseCommitSha,
            REVIEW_ROUTER_RUNTIME_ROLLOUT_STARTED_AT: input.fence.fencedAt,
            REVIEW_ROUTER_RUNTIME_SERVICE_ID: expected.serviceId,
            REVIEW_ROUTER_RUNTIME_DEPLOYMENT_PROVENANCE:
              expected.provenance.kind === "git"
                ? expected.provenance.commitSha
                : expected.provenance.imageSha.replace(/^sha256:/u, ""),
          },
          remove: [],
        },
      );
      if (envReplacement.status === "conflict")
        throw new Error("render_target_environment_conflict");
      if (envReplacement.status === "ambiguous")
        throw new Error("render_target_environment_ambiguous");
      const created = await mutations.createDeploy(
        {
          rolloutId: input.fence.rolloutId,
          ownerId: input.mutationOwnerId,
          operation: `target_deploy:${expected.serviceId}`,
        },
        expected.serviceId,
      );
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
      const [stagedService, stagedEnvironment] = await Promise.all([
        api.getService(expected.serviceId),
        api.listAllEnv(expected.serviceId),
      ]);
      const servicePostcondition = normalizeRenderServicePostcondition(
        stagedService,
        environmentSha256(stagedEnvironment),
      );
      if (
        !servicePostcondition.suspended ||
        servicePostcondition.environmentSha256 !==
          envReplacement.environmentSha256
      )
        throw new Error("render_target_stage_postcondition_unproven");
      facts.push({
        serviceId: expected.serviceId,
        deployId: created.id,
        provenance: expected.provenance,
        envSha256: envReplacement.environmentSha256,
        previousEnvSha256: envReplacement.previousEnvironmentSha256,
        databaseHostname: databaseUrl.hostname,
        databaseName: expected.databaseName,
        databaseRole: expected.databaseRole,
        databaseSystemIdentifier: input.targetSystemIdentifier,
        recoveryWitnessSha256: input.targetRecoveryWitnessSha256,
        suspended: true,
        targetSwitchFenceNonce: input.fence.nonce,
        targetSwitchFenceVersion: input.fence.version,
        servicePostcondition,
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
    rolloutId: string;
    sourceSystemIdentifier: string;
    targetSystemIdentifier: string;
    expectedReceiptSha256: string;
    decision: ProviderAuthorityDecision;
    mutationOwnerId: string;
    stagedServices: readonly StagedTargetService[];
  }): Promise<StepObservation> {
    if (
      !input.services.length ||
      input.stagedServices.length !== input.services.length ||
      input.decision.decision !== "allow" ||
      input.decision.operation !== ProviderAuthorityOperation.ResumeTarget ||
      input.decision.rolloutId !== input.rolloutId ||
      input.decision.sourceSystemIdentifier !== input.sourceSystemIdentifier ||
      input.decision.targetSystemIdentifier !== input.targetSystemIdentifier ||
      input.decision.expectedReceiptSha256 !== input.expectedReceiptSha256 ||
      input.decision.activationBoundary !== "activated"
    )
      throw new Error("render_target_resume_authority_invalid");
    const api = new RenderApiAdapter(input.apiKey, this.fetchImpl);
    if (!this.mutationAuthority)
      throw new Error("render_mutation_authority_missing");
    const mutations = new AuthorizedRenderMutations(
      api,
      this.mutationAuthority,
      this.sleep,
    );
    const facts = [];
    for (const expected of input.services) {
      const staged = input.stagedServices.find(
        (item) => item.serviceId === expected.serviceId,
      );
      if (
        !staged ||
        staged.deployId.length === 0 ||
        JSON.stringify(staged.provenance) !==
          JSON.stringify(expected.provenance) ||
        staged.servicePostcondition.serviceId !== expected.serviceId ||
        !staged.servicePostcondition.suspended
      )
        throw new Error("render_target_staged_postcondition_invalid");
      const beforeDeploys = await api.listAllDeploys(expected.serviceId);
      if (
        beforeDeploys.some((deploy) => active.has(deploy.status)) ||
        beforeDeploys.find((deploy) => deploy.status === "live")?.id !==
          staged.deployId
      )
        throw new Error("render_target_resume_deploy_drift");
      await mutations.resumeExact(
        {
          rolloutId: input.rolloutId,
          ownerId: input.mutationOwnerId,
          operation: `target_resume:${expected.serviceId}`,
        },
        staged.servicePostcondition,
        { deployId: staged.deployId, provenance: staged.provenance },
      );
      const [service, environment] = await Promise.all([
        api.getService(expected.serviceId),
        api.listAllEnv(expected.serviceId),
      ]);
      const finalPostcondition = normalizeRenderServicePostcondition(
        service,
        environmentSha256(environment),
      );
      if (
        !sameNormalizedServicePostcondition(finalPostcondition, {
          ...staged.servicePostcondition,
          suspended: false,
        })
      )
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
        authorityDecisionId: input.decision.decisionId,
        servicePostcondition: finalPostcondition,
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
    expectedRecoveryWitnessSha256: string;
    rolloutId: string;
    bearerToken: string;
    fetchImpl?: RenderFetch;
    expectedServices: readonly Readonly<{
      runtimeRole: "api" | "web" | "worker";
      serviceId: string;
      deployId: string;
      provenance: TargetServiceExpectation["provenance"];
      servicePostcondition: NormalizedServicePostcondition;
    }>[];
  }): Promise<StepObservation> {
    if (
      !input.url.startsWith("https://") ||
      !input.bearerToken ||
      input.expectedServices.length !== 3 ||
      input.expectedServices.map((item) => item.runtimeRole).join("\0") !==
        "api\0web\0worker" ||
      !/^[a-f0-9]{64}$/u.test(input.expectedRecoveryWitnessSha256) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:/-]{2,255}$/u.test(input.rolloutId)
    )
      throw new Error("render_target_canary_url_invalid");
    const nonce = randomBytes(24).toString("hex");
    const requestedAt = this.now().toISOString();
    const serviceFacts = input.expectedServices.map((service) => ({
      runtimeRole: service.runtimeRole,
      serviceId: service.serviceId,
      deployId: service.deployId,
      deploymentProvenance:
        service.provenance.kind === "git"
          ? service.provenance.commitSha
          : service.provenance.imageSha.replace(/^sha256:/u, ""),
      servicePostconditionSha256: normalizedServicePostconditionSha256(
        service.servicePostcondition,
      ),
    }));
    const response = await new BoundedProviderHttpClient(
      input.fetchImpl ?? this.fetchImpl,
    ).request("target_canary", input.url, {
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
        expectedGeneration: {
          systemIdentifier: input.expectedSystemIdentifier,
          recoveryWitnessSha256: input.expectedRecoveryWitnessSha256,
        },
        serviceFacts,
      }),
    });
    if (!response.ok)
      throw new ProviderHttpError(
        "target_canary",
        "response_status",
        response.status,
        true,
      );
    let value: Record<string, unknown>;
    try {
      value = (await response.json()) as Record<string, unknown>;
    } catch {
      throw new ProviderHttpError(
        "target_canary",
        "response_invalid",
        response.status,
        true,
      );
    }
    if (
      value.commitSha !== input.expectedCommitSha ||
      value.databaseSystemIdentifier !== input.expectedSystemIdentifier ||
      value.recoveryWitnessSha256 !== input.expectedRecoveryWitnessSha256 ||
      !Array.isArray(value.runtimeWitnessProofs) ||
      value.runtimeWitnessProofs.length !== 3 ||
      value.runtimeWitnessProofs.some((item, index) => {
        if (!item || typeof item !== "object" || Array.isArray(item))
          return true;
        const proof = item as Record<string, unknown>;
        const role = ["api", "web", "worker"][index];
        return (
          proof.runtimeRole !== role ||
          proof.databaseRole !== `reviewrouter_${role}` ||
          proof.recoveryWitnessSha256 !== input.expectedRecoveryWitnessSha256 ||
          proof.systemIdentifier !== input.expectedSystemIdentifier ||
          proof.releaseCommitSha !== input.expectedCommitSha ||
          proof.serviceId !== serviceFacts[index]?.serviceId ||
          proof.deploymentProvenance !==
            serviceFacts[index]?.deploymentProvenance ||
          proof.nonce !== nonce ||
          proof.requestedAt !== requestedAt ||
          !Number.isFinite(Date.parse(String(proof.provedAt))) ||
          Date.parse(String(proof.provedAt)) < Date.parse(requestedAt) ||
          Date.parse(String(proof.provedAt)) >
            Date.parse(requestedAt) + 10_000 ||
          typeof proof.provedAt !== "string"
        );
      }) ||
      value.writeReadRoundTrip !== true ||
      value.rolloutId !== input.rolloutId ||
      value.nonce !== nonce ||
      value.requestedAt !== requestedAt ||
      JSON.stringify(value.expectedGeneration) !==
        JSON.stringify({
          systemIdentifier: input.expectedSystemIdentifier,
          recoveryWitnessSha256: input.expectedRecoveryWitnessSha256,
        }) ||
      JSON.stringify(value.serviceFacts) !== JSON.stringify(serviceFacts) ||
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
        recoveryWitnessSha256: value.recoveryWitnessSha256,
        runtimeWitnessProofs: value.runtimeWitnessProofs,
        writeReadRoundTrip: true,
        rolloutId: input.rolloutId,
        nonce,
        requestedAt,
        observedAt: value.observedAt,
        expectedGeneration: value.expectedGeneration,
        serviceFacts,
      },
    };
  }
}
