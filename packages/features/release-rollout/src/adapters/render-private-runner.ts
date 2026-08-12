import { createHash } from "node:crypto";
import {
  RolloutStep,
  type RunnerIdentity,
  type RunnerProvenance,
  type StepObservation,
} from "../domain/release-rollout";
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

export interface PersistedRunnerJob {
  readonly rolloutId: string;
  readonly serviceId: string;
  readonly jobId: string;
  readonly observedAt: string;
  readonly cleanupCanary: string;
  readonly lifecycle: "role" | "cutover";
  readonly provisioningIntentId: string;
}
export interface RunnerProvisioningIntent {
  readonly id: string;
  readonly rolloutId: string;
  readonly serviceId: string;
  readonly lifecycle: "role" | "cutover";
  readonly workflowJobId: string;
  readonly runnerName: string;
  readonly createdAt: string;
}
export interface RunnerJobLedger {
  persistProvisioningIntent(
    value: RunnerProvisioningIntent,
  ): Promise<"created" | "existing">;
  listProvisioningIntents(
    rolloutId: string,
  ): Promise<readonly RunnerProvisioningIntent[]>;
  recordProvisioningOutcome(input: {
    intentId: string;
    jobId: string;
    outcome:
      | "bound"
      | "persistence_failed_cleaned"
      | "persistence_failed_unknown";
    observation?: StepObservation;
  }): Promise<void>;
  persistCreatedJob(value: PersistedRunnerJob): Promise<void>;
  listOpenJobs(rolloutId: string): Promise<readonly PersistedRunnerJob[]>;
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
  persist(
    jobId: string,
    witness: Readonly<Record<string, unknown>>,
  ): Promise<void>;
}

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

export class RenderPrivateRunnerAdapter {
  constructor(
    private readonly ledger: RunnerJobLedger,
    private readonly cleanupWitness: RunnerCleanupWitnessPort,
    private readonly fetchImpl: RenderFetch = fetch,
    private readonly now: () => Date = () => new Date(),
    private readonly providerWitness?: RunnerProviderWitnessPort,
  ) {}

  private client(token: string): RenderApiAdapter {
    return new RenderApiAdapter(token, this.fetchImpl);
  }

  async provision(input: RenderRunnerRequest): Promise<{
    identity: RunnerIdentity;
    observation: StepObservation;
    jobId: string;
  }> {
    validate(input);
    const api = this.client(input.apiKey);
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
    await this.ledger.persistProvisioningIntent({
      id: provisioningIntentId,
      rolloutId: input.rolloutId,
      serviceId: input.baseServiceId,
      lifecycle: input.lifecycle,
      workflowJobId: input.workflowJobId,
      runnerName: input.runnerName,
      createdAt: this.now().toISOString(),
    });
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
    const created = await api.createJob(input.baseServiceId, {
      startCommand,
      ...(input.planId ? { planId: input.planId } : {}),
    });
    // This durable write deliberately precedes every post-create validation.
    try {
      await this.ledger.persistCreatedJob({
        rolloutId: input.rolloutId,
        serviceId: input.baseServiceId,
        jobId: created.id,
        observedAt: this.now().toISOString(),
        cleanupCanary,
        lifecycle: input.lifecycle,
        provisioningIntentId,
      });
      await this.ledger.recordProvisioningOutcome({
        intentId: provisioningIntentId,
        jobId: created.id,
        outcome: "bound",
      });
    } catch (error) {
      let observation: StepObservation | undefined;
      try {
        observation = await this.observeCleanup({
          api,
          baseServiceId: input.baseServiceId,
          jobId: created.id,
          cleanupCanary,
          lifecycle: input.lifecycle,
          timeoutPolls: 30,
        });
      } finally {
        await this.ledger.recordProvisioningOutcome({
          intentId: provisioningIntentId,
          jobId: created.id,
          outcome: observation
            ? "persistence_failed_cleaned"
            : "persistence_failed_unknown",
          ...(observation ? { observation } : {}),
        });
      }
      throw new Error("render_runner_job_persistence_failed", { cause: error });
    }
    if (
      created.serviceId !== input.baseServiceId ||
      created.startCommand !== startCommand ||
      created.status !== "pending" ||
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
    await this.ledger.persistValidatedIdentity(
      created.id,
      identity,
      provisionObservation,
    );
    return {
      jobId: created.id,
      identity,
      observation: provisionObservation,
    };
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
    if (this.providerWitness) {
      if (!job.createdAt || !job.finishedAt)
        throw new Error("render_runner_cleanup_log_window_missing");
      const service = await api.getService(input.baseServiceId);
      const logs = await api.listLogs({
        ownerId: service.ownerId,
        resourceId: input.baseServiceId,
        startTime: job.createdAt,
        endTime: job.finishedAt,
      });
      const receipts = logs.flatMap((log) => {
        try {
          const parsed = JSON.parse(log.message) as {
            canary?: unknown;
            cleanup?: {
              removedPaths?: unknown;
              remainingPaths?: unknown;
            };
          };
          return parsed.canary === expectedCanary && parsed.cleanup
            ? [{ log, parsed }]
            : [];
        } catch {
          return [];
        }
      });
      if (receipts.length !== 1)
        throw new Error("render_runner_cleanup_provider_log_ambiguous");
      const receipt = receipts[0]!;
      if (
        !Array.isArray(receipt.parsed.cleanup!.removedPaths) ||
        !Array.isArray(receipt.parsed.cleanup!.remainingPaths) ||
        receipt.parsed.cleanup!.remainingPaths.length !== 0
      )
        throw new Error("render_runner_cleanup_provider_log_invalid");
      await this.providerWitness.persist(input.jobId, {
        jobId: input.jobId,
        canary: expectedCanary,
        containerTerminated: true,
        logSha256: `sha256:${createHash("sha256")
          .update(receipt.log.message)
          .digest("hex")}`,
        removedPaths: receipt.parsed.cleanup!.removedPaths,
        remainingPaths: [],
        providerLogId: receipt.log.id,
        providerObservedAt: receipt.log.timestamp,
      });
    }
    const local = await this.cleanupWitness.observe(
      input.jobId,
      expectedCanary,
    );
    if (
      local.canary !== expectedCanary ||
      local.listenerStopped !== true ||
      local.workspaceRemoved !== true ||
      local.credentialProcessGone !== true
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
        runner: local,
      },
      provider: { renderJobId: job.id },
    };
    return observation;
  }

  async reconcileOrphans(
    rolloutId: string,
    apiKey: string,
  ): Promise<readonly StepObservation[]> {
    const open = await this.ledger.listOpenJobs(rolloutId);
    const intents = await this.ledger.listProvisioningIntents(rolloutId);
    const knownJobIds = new Set(open.map((entry) => entry.jobId));
    const discovered: PersistedRunnerJob[] = [];
    for (const intent of intents) {
      let cursor: string | undefined;
      do {
        const page = await this.client(apiKey).listJobs(
          intent.serviceId,
          cursor,
        );
        for (const job of page.items)
          if (
            !knownJobIds.has(job.id) &&
            job.startCommand.includes(`--intent ${intent.id} --context `)
          ) {
            knownJobIds.add(job.id);
            discovered.push({
              rolloutId,
              serviceId: intent.serviceId,
              jobId: job.id,
              observedAt: job.createdAt ?? intent.createdAt,
              cleanupCanary: `rr-cleanup:${rolloutId}:${intent.runnerName}`,
              lifecycle: intent.lifecycle,
              provisioningIntentId: intent.id,
            });
          }
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
    }
    const observations: StepObservation[] = [];
    for (const entry of [...open, ...discovered]) {
      const observation = await this.observeCleanup({
        api: this.client(apiKey),
        baseServiceId: entry.serviceId,
        jobId: entry.jobId,
        cleanupCanary: entry.cleanupCanary,
        lifecycle: entry.lifecycle,
      });
      observations.push(observation);
      if (open.some((known) => known.jobId === entry.jobId))
        await this.ledger.markTerminal(entry.jobId, observation);
      else
        await this.ledger.recordProvisioningOutcome({
          intentId: entry.provisioningIntentId,
          jobId: entry.jobId,
          outcome: "persistence_failed_cleaned",
          observation,
        });
    }
    return observations;
  }
}
