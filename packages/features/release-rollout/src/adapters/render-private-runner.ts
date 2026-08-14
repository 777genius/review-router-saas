import { createHash, randomUUID } from "node:crypto";
import {
  RolloutStep,
  type RunnerIdentity,
  type ProviderCreationBoundary,
  type RunnerProvenance,
  type StepObservation,
} from "../domain/release-rollout";
import {
  ExternalEffectState,
  type ExternalEffectControlReconciliation,
  type ExternalEffectRecord,
  type RunnerProvisioningIntentRecord,
} from "../domain/external-effect";
import {
  ExternalEffectDispatchUseCase,
  ExternalEffectReconciliationUseCase,
} from "../application/external-effect-protocol";
import {
  reconcileCompensationSafety,
  type CompensationSafetyReconciliation,
} from "../application/reconcile-compensation";
import type { ProviderMutationAuthorityPort } from "../application/provider-mutation-authority";
import { AuthorizedRenderMutations } from "./authorized-render-mutations";
import {
  RenderApiAdapter,
  type RenderDeploy,
  type RenderFetch,
  type RenderJob,
} from "./render-api";

const safe = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{2,511}$/u;
const terminal = new Set(["succeeded", "failed", "canceled"]);
const activeDeploy = new Set([
  "created",
  "queued",
  "build_in_progress",
  "update_in_progress",
  "pre_deploy_in_progress",
]);

export interface PersistedRunnerJob extends ProviderCreationBoundary {
  readonly rolloutId: string;
  readonly serviceId: string;
  readonly jobId: string;
  readonly observedAt: string;
  readonly cleanupCanary: string;
  readonly lifecycle: "role" | "cutover";
  readonly provisioningIntentId: string;
}
export type RunnerProvisioningIntent = RunnerProvisioningIntentRecord;
export type CreateRunnerProvisioningIntent = Omit<
  RunnerProvisioningIntent,
  "creationLeaseOwner" | "creationLeaseExpiresAt" | "effect"
> & { readonly creationLeaseOwner: string };
export interface RunnerJobLedger {
  persistProvisioningIntent(
    value: CreateRunnerProvisioningIntent,
  ): Promise<ExternalEffectRecord>;
  listProvisioningIntents(
    rolloutId: string,
  ): Promise<readonly RunnerProvisioningIntent[]>;
  acquireProviderDispatchPermit(input: {
    intentId: string;
    claimantId: string;
    startCommandSha256: string;
    expectedEpoch: number;
    leaseSeconds: number;
  }): Promise<ExternalEffectRecord>;
  abandonPreparedEffect(input: {
    intentId: string;
    claimantId: string;
    expectedEpoch: number;
  }): Promise<ExternalEffectRecord>;
  reconcileProvisioningEffect(input: {
    intentId: string;
    claimantId: string;
    expectedEpoch: number;
    jobId?: string;
    reconciliation: ExternalEffectControlReconciliation;
    observation?: StepObservation;
  }): Promise<ExternalEffectRecord>;
  persistCreatedJob(value: PersistedRunnerJob): Promise<void>;
  listOpenJobs(rolloutId: string): Promise<readonly PersistedRunnerJob[]>;
  currentRunner(
    rolloutId: string,
    lifecycle: "role" | "cutover",
  ): Promise<{ identity: RunnerIdentity; observation: StepObservation }>;
  cleanupObservation?(jobId: string): Promise<StepObservation>;
  markTerminal(jobId: string, observation: StepObservation): Promise<void>;
  persistValidatedIdentity(
    jobId: string,
    identity: RunnerIdentity,
    observation: StepObservation,
  ): Promise<void>;
}
export interface RunnerCleanupWitnessPort {
  observe(
    jobId: string,
    expectedCanary: string,
  ): Promise<{
    listenerStopped: true;
    workspaceRemoved: true;
    credentialProcessGone: true;
    canary: string;
    observedAt: string;
  }>;
}
export interface RunnerProviderWitnessPort {
  observe(jobId: string): Promise<void>;
}

export type RunnerReconciliationReport = CompensationSafetyReconciliation &
  Readonly<{ observations: readonly StepObservation[] }>;

export interface RenderRunnerRequest {
  readonly rolloutId: string;
  readonly lifecycle: "role" | "cutover";
  readonly ownerId: string;
  readonly organization: string;
  readonly repository: string;
  readonly workflowPath: string;
  readonly workflowRef: string;
  readonly event: "workflow_dispatch";
  readonly actor: string;
  readonly runId: string;
  readonly runAttempt: number;
  readonly workflowJobId: string;
  readonly workflowJobName: string;
  readonly commitSha: string;
  readonly runnerName: string;
  readonly runnerGroupId: number;
  readonly runnerGroupName: string;
  readonly baseServiceId: string;
  readonly expectedProvenance: RunnerProvenance;
  readonly imageAttestation: NonNullable<RunnerIdentity["imageAttestation"]>;
  readonly planId?: string;
  readonly apiKey: string;
}

function validate(input: RenderRunnerRequest): void {
  for (const value of [
    input.rolloutId,
    input.ownerId,
    input.organization,
    input.repository,
    input.workflowRef,
    input.actor,
    input.runId,
    input.workflowJobId,
    input.workflowJobName,
    input.runnerName,
    input.runnerGroupName,
    input.baseServiceId,
  ])
    if (!safe.test(value)) throw new Error("render_runner_context_invalid");
  if (
    !/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/u.test(input.workflowPath)
  )
    throw new Error("render_runner_context_invalid");
  if (
    !/^[a-f0-9]{40}$/u.test(input.commitSha) ||
    input.runAttempt !== 1 ||
    !Number.isSafeInteger(input.runnerGroupId) ||
    input.runnerGroupId < 1
  )
    throw new Error("render_runner_context_invalid");
  if (
    input.repository.split("/")[0] !== input.organization ||
    input.event !== "workflow_dispatch"
  )
    throw new Error("render_runner_personal_repository_forbidden");
  if (
    input.expectedProvenance.kind !== "image" ||
    !/^sha256:[a-f0-9]{64}$/u.test(input.expectedProvenance.imageSha) ||
    input.imageAttestation.subjectDigest !==
      input.expectedProvenance.imageSha ||
    input.imageAttestation.sourceCommitSha !== input.commitSha ||
    !/^sha256:[a-f0-9]{64}$/u.test(input.imageAttestation.statementSha256) ||
    !safe.test(input.imageAttestation.builderId)
  )
    throw new Error("render_runner_provenance_invalid");
}

function provenance(deploy: RenderDeploy): RunnerProvenance {
  if (deploy.commit && !deploy.image)
    return { kind: "git", deployId: deploy.id, commitSha: deploy.commit.id };
  if (deploy.image && !deploy.commit)
    return { kind: "image", deployId: deploy.id, imageSha: deploy.image.sha };
  throw new Error("render_runner_deploy_provenance_ambiguous");
}

function sameProvenance(a: RunnerProvenance, b: RunnerProvenance): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function sameValue(a: unknown, b: unknown): boolean {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, entry]) => [key, canonical(entry)]),
      );
    return value;
  };
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

export class RenderPrivateRunnerAdapter {
  constructor(
    private readonly ledger: RunnerJobLedger,
    private readonly cleanupWitness: RunnerCleanupWitnessPort,
    private readonly providerWitness: RunnerProviderWitnessPort,
    private readonly fetchImpl: RenderFetch = fetch,
    private readonly now: () => Date = () => new Date(),
    private readonly mutationAuthority?: ProviderMutationAuthorityPort,
  ) {}

  private client(token: string): RenderApiAdapter {
    return new RenderApiAdapter(token, this.fetchImpl);
  }

  private reconciliationBoundary(): ExternalEffectReconciliationUseCase {
    return new ExternalEffectReconciliationUseCase({
      reconcile: async (value) =>
        await this.ledger.reconcileProvisioningEffect({
          intentId: value.effectId,
          claimantId: value.ownerId,
          expectedEpoch: value.expectedEpoch,
          ...(value.providerId ? { jobId: value.providerId } : {}),
          reconciliation: value.reconciliation,
          ...(value.evidence
            ? { observation: value.evidence as StepObservation }
            : {}),
        }),
    });
  }

  async provision(input: RenderRunnerRequest): Promise<{
    identity: RunnerIdentity;
    observation: StepObservation;
    jobId: string;
  }> {
    validate(input);
    const api = this.client(input.apiKey);
    if (!this.mutationAuthority)
      throw new Error("render_mutation_authority_missing");
    const mutations = new AuthorizedRenderMutations(
      api,
      this.mutationAuthority,
    );
    const service = await api.getService(input.baseServiceId);
    if (
      service.id !== input.baseServiceId ||
      service.ownerId !== input.ownerId ||
      service.type !== "private_service" ||
      service.autoDeploy !== "no" ||
      service.suspended !== "not_suspended"
    )
      throw new Error("render_runner_service_policy_mismatch");
    const first = await api.listAllDeploys(input.baseServiceId);
    if (first.some((deploy) => activeDeploy.has(deploy.status)))
      throw new Error("render_runner_active_deploy_present");
    const latest = first.find((deploy) => deploy.status === "live");
    if (!latest)
      throw new Error("render_runner_latest_successful_deploy_missing");
    const observedProvenance = provenance(latest);
    if (!sameProvenance(observedProvenance, input.expectedProvenance))
      throw new Error("render_runner_latest_deploy_mismatch");
    const cleanupCanary = `rr-cleanup:${input.rolloutId}:${input.runnerName}`;
    const provisioningIntentId = `rri-${createHash("sha256")
      .update(
        `${input.rolloutId}:${input.lifecycle}:${input.runId}:${input.workflowJobId}:${input.baseServiceId}`,
      )
      .digest("hex")}`;
    const encodedContext = Buffer.from(
      JSON.stringify({
        organization: input.organization,
        repository: input.repository,
        workflowPath: input.workflowPath,
        workflowRef: input.workflowRef,
        event: input.event,
        actor: input.actor,
        runId: input.runId,
        runAttempt: input.runAttempt,
        commitSha: input.commitSha,
        workflowJobId: input.workflowJobId,
        workflowJobName: input.workflowJobName,
        runnerGroupId: input.runnerGroupId,
        runnerGroupName: input.runnerGroupName,
        runnerName: input.runnerName,
        uniqueRunnerLabel: input.runnerName,
        workFolder: `_work/${input.runnerName}`,
        rolloutId: input.rolloutId,
        lifecycle: input.lifecycle,
        provisioningIntentId,
        cleanupCanary,
      }),
    ).toString("base64url");
    const startCommand = `node /runner/bootstrap.mjs --intent ${provisioningIntentId} --context ${encodedContext}`;
    const startCommandSha256 = `sha256:${createHash("sha256").update(startCommand).digest("hex")}`;
    const claimantId = `rrc-${randomUUID()}`;
    const intentCreatedAt = this.now();
    let providerCreationNotBefore = intentCreatedAt.toISOString();
    const leaseSeconds = 120;
    const prepareInput: CreateRunnerProvisioningIntent = {
      id: provisioningIntentId,
      rolloutId: input.rolloutId,
      serviceId: input.baseServiceId,
      lifecycle: input.lifecycle,
      workflowJobId: input.workflowJobId,
      runnerName: input.runnerName,
      createdAt: intentCreatedAt.toISOString(),
      startCommandSha256,
      creationLeaseOwner: claimantId,
    };
    const dispatchBoundary = new ExternalEffectDispatchUseCase({
      prepare: async (value: CreateRunnerProvisioningIntent) =>
        await this.ledger.persistProvisioningIntent(value),
      acquireDispatchPermit: async (value) =>
        await this.ledger.acquireProviderDispatchPermit({
          intentId: value.effectId,
          claimantId: value.ownerId,
          startCommandSha256,
          expectedEpoch: value.expectedEpoch,
          leaseSeconds,
        }),
    });
    const reconciliationBoundary = this.reconciliationBoundary();
    const dispatch = await dispatchBoundary.execute({
      effectId: provisioningIntentId,
      ownerId: claimantId,
      prepare: prepareInput,
      dispatch: async () =>
        await mutations.createJob(
          {
            rolloutId: input.rolloutId,
            ownerId: claimantId,
            operation: `runner_provision:${provisioningIntentId}`,
          },
          input.baseServiceId,
          provisioningIntentId,
          {
            startCommand,
            ...(input.planId ? { planId: input.planId } : {}),
          },
        ),
    });
    const intent = dispatch.record;
    let created: RenderJob = dispatch.response as RenderJob;
    let bindingRequired = true;
    const providerCreatedByThisCall = dispatch.response !== undefined;
    let effect = intent;
    if (!providerCreatedByThisCall) {
      const current = await this.readMatchingCurrent(input, observedProvenance);
      if (current) return current;
      const bound = (await this.ledger.listOpenJobs(input.rolloutId)).filter(
        (entry) => entry.provisioningIntentId === provisioningIntentId,
      );
      if (bound.length > 1)
        throw new Error("render_runner_intent_multiple_bound_jobs");
      if (bound.length === 1) {
        bindingRequired = false;
        created = await api.getJob(input.baseServiceId, bound[0]!.jobId);
      } else {
        if (effect.state !== ExternalEffectState.Dispatching)
          throw new Error(`render_runner_effect_${effect.state}`);
        const matching = (await api.listAllJobs(input.baseServiceId)).filter(
          (job) => job.startCommand === startCommand,
        );
        if (matching.length !== 1) {
          const reconciliationResult = await reconciliationBoundary.discover({
            effectId: provisioningIntentId,
            ownerId: claimantId,
            expectedEpoch: effect.epoch,
            matchingProviderIds: matching.map((job) => job.id),
            timedOut: false,
          });
          const reconciliation = reconciliationResult.reconciliation;
          throw new Error(
            reconciliation.result === "blocked" &&
              reconciliation.reason === "duplicate"
              ? "render_runner_intent_multiple_provider_jobs"
              : "render_runner_intent_reconciliation_pending",
          );
        }
        const durableIntents = (
          await this.ledger.listProvisioningIntents(input.rolloutId)
        ).filter((entry) => entry.id === provisioningIntentId);
        if (durableIntents.length !== 1)
          throw new Error("render_runner_intent_temporal_boundary_missing");
        providerCreationNotBefore = durableIntents[0]!.createdAt;
        created = matching[0]!;
      }
    }
    // This durable write deliberately precedes every post-create validation.
    try {
      if (bindingRequired)
        await this.ledger.persistCreatedJob({
          rolloutId: input.rolloutId,
          serviceId: input.baseServiceId,
          jobId: created.id,
          observedAt: this.now().toISOString(),
          providerCreationNotBefore,
          cleanupCanary,
          lifecycle: input.lifecycle,
          provisioningIntentId,
        });
      bindingRequired = false;
      effect = (
        await reconciliationBoundary.discover({
          effectId: provisioningIntentId,
          ownerId: claimantId,
          expectedEpoch: effect.epoch,
          matchingProviderIds: [created.id],
          timedOut: false,
        })
      ).record;
    } catch (error) {
      if (!bindingRequired) throw error;
      if (!providerCreatedByThisCall) {
        const concurrentlyBound = (
          await this.ledger.listOpenJobs(input.rolloutId)
        ).some(
          (entry) =>
            entry.provisioningIntentId === provisioningIntentId &&
            entry.jobId === created.id,
        );
        if (!concurrentlyBound) throw error;
        await reconciliationBoundary.discover({
          effectId: provisioningIntentId,
          ownerId: claimantId,
          expectedEpoch: effect.epoch,
          matchingProviderIds: [created.id],
          timedOut: false,
        });
      } else {
        // The durable dispatching fence is already compensation-unsafe and can
        // never authorize another POST.  Leave transient persistence failure
        // retryable so discovery can retain and clean the provider identity.
        throw new Error("render_runner_job_persistence_failed", {
          cause: error,
        });
      }
    }
    if (
      created.serviceId !== input.baseServiceId ||
      created.startCommand !== startCommand ||
      (providerCreatedByThisCall
        ? created.status !== "pending"
        : terminal.has(created.status)) ||
      created.planId !== input.planId
    )
      throw new Error("render_runner_create_response_mismatch");
    const second = await api.listAllDeploys(input.baseServiceId);
    if (
      second.some((deploy) => activeDeploy.has(deploy.status)) ||
      !second.some(
        (deploy) => deploy.id === latest.id && deploy.status === "live",
      ) ||
      !sameProvenance(
        provenance(second.find((deploy) => deploy.id === latest.id)!),
        observedProvenance,
      )
    )
      throw new Error("render_runner_deploy_race_detected");
    const identity: RunnerIdentity = Object.freeze({
      organization: input.organization,
      repository: input.repository,
      workflowPath: input.workflowPath,
      workflowRef: input.workflowRef,
      event: input.event,
      actor: input.actor,
      runId: input.runId,
      runAttempt: input.runAttempt,
      workflowJobId: input.workflowJobId,
      workflowJobName: input.workflowJobName,
      commitSha: input.commitSha,
      runnerName: input.runnerName,
      cleanupCanary,
      renderJobId: created.id,
      baseServiceId: input.baseServiceId,
      runnerGroupId: input.runnerGroupId,
      runnerGroupName: input.runnerGroupName,
      uniqueRunnerLabel: input.runnerName,
      workFolder: `_work/${input.runnerName}`,
      ...(input.planId ? { planId: input.planId } : {}),
      provenance: observedProvenance,
      imageAttestation: Object.freeze({ ...input.imageAttestation }),
    });
    const provisionObservation: StepObservation = {
      step:
        input.lifecycle === "role"
          ? RolloutStep.ProvisionRoleRunner
          : RolloutStep.ProvisionCutoverRunner,
      observedAt: this.now().toISOString(),
      facts: identity,
      provider: {
        renderJobId: created.id,
        renderDeployId: latest.id,
        githubWorkflowJobId: input.workflowJobId,
      },
    };
    const result = {
      jobId: created.id,
      identity,
      observation: provisionObservation,
    };
    try {
      await this.ledger.persistValidatedIdentity(
        created.id,
        identity,
        provisionObservation,
      );
    } catch (error) {
      const current = await this.readMatchingCurrent(input, observedProvenance);
      if (!current || current.jobId !== created.id) throw error;
      return current;
    }
    return result;
  }

  private async readMatchingCurrent(
    input: RenderRunnerRequest,
    observedProvenance: RunnerProvenance,
  ): Promise<
    | { identity: RunnerIdentity; observation: StepObservation; jobId: string }
    | undefined
  > {
    let current: { identity: RunnerIdentity; observation: StepObservation };
    try {
      current = await this.ledger.currentRunner(
        input.rolloutId,
        input.lifecycle,
      );
    } catch {
      return undefined;
    }
    const expectedIdentity: RunnerIdentity = {
      organization: input.organization,
      repository: input.repository,
      workflowPath: input.workflowPath,
      workflowRef: input.workflowRef,
      event: input.event,
      actor: input.actor,
      runId: input.runId,
      runAttempt: input.runAttempt,
      workflowJobId: input.workflowJobId,
      workflowJobName: input.workflowJobName,
      commitSha: input.commitSha,
      runnerName: input.runnerName,
      cleanupCanary: `rr-cleanup:${input.rolloutId}:${input.runnerName}`,
      renderJobId: current.identity.renderJobId,
      baseServiceId: input.baseServiceId,
      runnerGroupId: input.runnerGroupId,
      runnerGroupName: input.runnerGroupName,
      uniqueRunnerLabel: input.runnerName,
      workFolder: `_work/${input.runnerName}`,
      ...(input.planId ? { planId: input.planId } : {}),
      provenance: observedProvenance,
      imageAttestation: input.imageAttestation,
    };
    if (
      !sameValue(current.identity, expectedIdentity) ||
      !sameValue(current.observation.facts, current.identity) ||
      current.observation.step !==
        (input.lifecycle === "role"
          ? RolloutStep.ProvisionRoleRunner
          : RolloutStep.ProvisionCutoverRunner) ||
      current.observation.provider?.renderJobId !==
        current.identity.renderJobId ||
      current.observation.provider?.renderDeployId !==
        observedProvenance.deployId ||
      current.observation.provider?.githubWorkflowJobId !== input.workflowJobId
    )
      throw new Error("render_runner_current_intent_mismatch");
    return { ...current, jobId: current.identity.renderJobId };
  }

  async cleanup(input: {
    apiKey: string;
    baseServiceId: string;
    jobId: string;
    cleanupCanary: string;
    lifecycle: "role" | "cutover";
    timeoutPolls?: number;
  }): Promise<StepObservation> {
    const api = this.client(input.apiKey);
    const observation = await this.observeCleanup({ api, ...input });
    await this.ledger.markTerminal(input.jobId, observation);
    return observation;
  }

  private async observeCleanup(input: {
    api: RenderApiAdapter;
    baseServiceId: string;
    jobId: string;
    cleanupCanary: string;
    lifecycle: "role" | "cutover";
    timeoutPolls?: number;
  }): Promise<StepObservation> {
    const api = input.api;
    let job: RenderJob | undefined;
    for (let attempt = 0; attempt < (input.timeoutPolls ?? 30); attempt += 1) {
      job = await api.getJob(input.baseServiceId, input.jobId);
      if (job.id !== input.jobId || job.serviceId !== input.baseServiceId)
        throw new Error("render_runner_cleanup_job_mismatch");
      if (terminal.has(job.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    if (!job || !terminal.has(job.status))
      throw new Error("render_runner_cleanup_terminal_timeout");
    const expectedCanary = input.cleanupCanary;
    await this.providerWitness.observe(input.jobId);
    const independent = await this.cleanupWitness.observe(
      input.jobId,
      expectedCanary,
    );
    if (
      independent.canary !== expectedCanary ||
      independent.listenerStopped !== true ||
      independent.workspaceRemoved !== true ||
      independent.credentialProcessGone !== true
    )
      throw new Error("render_runner_cleanup_canary_invalid");
    const observation: StepObservation = {
      step:
        input.lifecycle === "role"
          ? RolloutStep.CleanupRoleRunner
          : RolloutStep.CleanupCutoverRunner,
      observedAt: this.now().toISOString(),
      facts: {
        provider: {
          id: job.id,
          serviceId: job.serviceId,
          status: job.status,
          finishedAt: job.finishedAt,
        },
        runner: independent,
      },
      provider: { renderJobId: job.id },
    };
    return observation;
  }

  async reconcileOrphans(
    rolloutId: string,
    apiKey: string,
  ): Promise<RunnerReconciliationReport> {
    const open = await this.ledger.listOpenJobs(rolloutId);
    const intents = await this.ledger.listProvisioningIntents(rolloutId);
    const reconciliationBoundary = this.reconciliationBoundary();
    const observations: StepObservation[] = [];

    const knownJobIds = new Set([
      ...open.map((entry) => entry.jobId),
      ...intents.flatMap((intent) =>
        intent.effect.providerId ? [intent.effect.providerId] : [],
      ),
    ]);
    const discovered: PersistedRunnerJob[] = [];
    for (const intent of intents) {
      const jobs = await this.client(apiKey).listAllJobs(intent.serviceId);
      for (const job of jobs)
        if (
          !knownJobIds.has(job.id) &&
          job.startCommand.includes(`--intent ${intent.id} --context `)
        ) {
          knownJobIds.add(job.id);
          discovered.push({
            rolloutId,
            serviceId: intent.serviceId,
            jobId: job.id,
            observedAt: this.now().toISOString(),
            providerCreationNotBefore: intent.createdAt,
            cleanupCanary: `rr-cleanup:${rolloutId}:${intent.runnerName}`,
            lifecycle: intent.lifecycle,
            provisioningIntentId: intent.id,
          });
        }
    }
    let duplicateObserved = false;

    // Persist every newly discovered provider identity before binding,
    // blocking, or invoking either cleanup witness.  In particular, duplicate
    // jobs are all retained in the open-job ledger instead of being filtered
    // out merely because only one provider id can be bound to an intent.
    for (const entry of discovered) {
      const intent = intents.find(
        (value) => value.id === entry.provisioningIntentId,
      );
      if (!intent) continue;
      try {
        await this.ledger.persistCreatedJob(entry);
      } catch {
        duplicateObserved ||=
          intent.effect.providerId !== null &&
          intent.effect.providerId !== entry.jobId;
      }
    }
    // Persistence is idempotent and discovery also sees already-terminal
    // provider jobs.  Refresh the authority's open set so a replay never
    // repeats cleanup merely because the provider still lists that identity.
    const refreshedOpen = await this.ledger.listOpenJobs(rolloutId);
    const refreshedOpenIds = new Set(refreshedOpen.map(({ jobId }) => jobId));
    const durableDiscovered = discovered.filter(({ jobId }) =>
      refreshedOpenIds.has(jobId),
    );

    for (const intent of intents) {
      const observedProviderIds = new Set([
        ...[...refreshedOpen, ...discovered]
          .filter((entry) => entry.provisioningIntentId === intent.id)
          .map((entry) => entry.jobId),
        ...(intent.effect.providerId ? [intent.effect.providerId] : []),
      ]);
      const matching = [...refreshedOpen, ...durableDiscovered].filter(
        (entry, index, all) =>
          entry.provisioningIntentId === intent.id &&
          all.findIndex((candidate) => candidate.jobId === entry.jobId) ===
            index,
      );
      if (observedProviderIds.size > 1) {
        duplicateObserved = true;
        await reconciliationBoundary.blocked({
          effectId: intent.id,
          ownerId: intent.effect.ownerId ?? `rrc-${randomUUID()}`,
          expectedEpoch: intent.effect.epoch,
          reason: "duplicate",
        });
      } else if (intent.effect.state === ExternalEffectState.Prepared) {
        const expiresAt = intent.creationLeaseExpiresAt;
        if (
          matching.length === 0 &&
          expiresAt !== null &&
          Date.parse(expiresAt) <= this.now().getTime()
        )
          await this.ledger.abandonPreparedEffect({
            intentId: intent.id,
            claimantId: intent.effect.ownerId!,
            expectedEpoch: intent.effect.epoch,
          });
      } else if (
        matching.length === 0 &&
        intent.effect.state === ExternalEffectState.Dispatching
      ) {
        await reconciliationBoundary.discover({
          effectId: intent.id,
          ownerId: intent.effect.ownerId!,
          expectedEpoch: intent.effect.epoch,
          matchingProviderIds: [],
          timedOut: false,
        });
      } else if (
        matching.length === 1 &&
        intent.effect.state === ExternalEffectState.Dispatching
      ) {
        await reconciliationBoundary.discover({
          effectId: intent.id,
          ownerId: intent.effect.ownerId!,
          expectedEpoch: intent.effect.epoch,
          matchingProviderIds: [matching[0]!.jobId],
          timedOut: false,
        });
      }
    }
    const durableJobs = [...refreshedOpen, ...durableDiscovered].filter(
      (entry, index, all) =>
        all.findIndex((candidate) => candidate.jobId === entry.jobId) === index,
    );
    for (const entry of durableJobs) {
      let observation: StepObservation;
      try {
        observation = await this.observeCleanup({
          api: this.client(apiKey),
          baseServiceId: entry.serviceId,
          jobId: entry.jobId,
          cleanupCanary: entry.cleanupCanary,
          lifecycle: entry.lifecycle,
        });
      } catch {
        // Provider and witness reads are transient boundaries. Keep the durable
        // effect pending so the bounded caller retries; exhaustion still emits
        // a blocked recovery artifact without inventing permanent DB evidence.
        continue;
      }
      observations.push(observation);
      // The authority terminalizes the job and projects effect safety in one
      // transaction.  Do not follow a successful terminal CAS with a separate
      // clean reconciliation: that command is both redundant and forbidden by
      // the authority's independently witnessed cleanup boundary.
      await this.ledger.markTerminal(entry.jobId, observation);
    }
    const finalIntents = await this.ledger.listProvisioningIntents(rolloutId);
    const safety = duplicateObserved
      ? {
          result: "blocked" as const,
          safeForCompensation: false,
          reason: "duplicate" as const,
          intentCount: finalIntents.length,
          intents: finalIntents.map(({ id, effect }) => ({
            id,
            state: effect.state,
            safeForCompensation: effect.safeForCompensation,
          })),
        }
      : reconcileCompensationSafety(finalIntents);
    return { ...safety, observations };
  }
}
