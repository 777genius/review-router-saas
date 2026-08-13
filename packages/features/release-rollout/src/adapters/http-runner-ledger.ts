import type {
  CreateRunnerProvisioningIntent,
  PersistedRunnerJob,
  RunnerProvisioningIntent,
  RunnerCleanupWitnessPort,
  RunnerJobLedger,
} from "./render-private-runner";
import type { RenderFetch } from "./render-api";
import type {
  ActivationAuthorization,
  ActivationReceipt,
  AuthoritativeGenerationLedger,
  StepObservation,
  TargetSwitchFence,
} from "../domain/release-rollout";
import type { ServiceTransitionCheckpoint } from "../application/transactional-service-cutover";
import type { ServiceTransitionLedger } from "../application/transactional-service-cutover";
import type { RunnerIdentity } from "../domain/release-rollout";
import type { CompensationCheckpoint } from "../application/ports";
import {
  assertExternalEffectRecord,
  assertRunnerProvisioningIntentRecord,
  type ExternalEffectControlReconciliation,
  type ExternalEffectRecord,
} from "../domain/external-effect";

export class AuthenticatedRunnerLedgerAdapter
  implements
    RunnerJobLedger,
    RunnerCleanupWitnessPort,
    AuthoritativeGenerationLedger
{
  constructor(
    private readonly origin: string,
    private readonly token: string,
    private readonly fetchImpl: RenderFetch = fetch,
  ) {
    if (!origin.startsWith("https://") || !token)
      throw new Error("runner_ledger_configuration_invalid");
  }
  private async request(
    path: string,
    init: RequestInit = {},
  ): Promise<unknown> {
    const response = await this.fetchImpl(
      `${this.origin.replace(/\/$/u, "")}${path}`,
      {
        ...init,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/json",
          "Content-Type": "application/json",
          ...(init.headers ?? {}),
        },
      },
    );
    if (!response.ok)
      throw new Error(`runner_ledger_request_failed:${response.status}`);
    return response.status === 204 ? null : await response.json();
  }
  async persistCreatedJob(value: PersistedRunnerJob): Promise<void> {
    await this.request("/v1/runner-jobs", {
      method: "POST",
      body: JSON.stringify(value),
    });
  }
  async persistProvisioningIntent(
    value: CreateRunnerProvisioningIntent,
  ): Promise<ExternalEffectRecord> {
    const result = (await this.request("/v1/runner-jobs/intents", {
      method: "POST",
      body: JSON.stringify(value),
    })) as Record<string, unknown>;
    return assertExternalEffectRecord(
      result as unknown as ExternalEffectRecord,
    );
  }
  async listProvisioningIntents(
    rolloutId: string,
  ): Promise<readonly RunnerProvisioningIntent[]> {
    const value = await this.request(
      `/v1/runner-jobs/intents?rollout_id=${encodeURIComponent(rolloutId)}`,
    );
    if (!Array.isArray(value))
      throw new Error("runner_ledger_provisioning_intents_invalid");
    try {
      for (const entry of value) assertRunnerProvisioningIntentRecord(entry);
    } catch {
      throw new Error("runner_ledger_provisioning_intents_invalid");
    }
    return value as RunnerProvisioningIntent[];
  }
  async acquireProviderDispatchPermit(
    input: Parameters<RunnerJobLedger["acquireProviderDispatchPermit"]>[0],
  ): ReturnType<RunnerJobLedger["acquireProviderDispatchPermit"]> {
    const value = (await this.request(
      `/v1/runner-jobs/intents/${encodeURIComponent(input.intentId)}/dispatch-permit`,
      { method: "POST", body: JSON.stringify(input) },
    )) as Record<string, unknown>;
    return assertExternalEffectRecord(value as unknown as ExternalEffectRecord);
  }
  async abandonPreparedEffect(input: {
    intentId: string;
    claimantId: string;
    expectedEpoch: number;
  }): Promise<ExternalEffectRecord> {
    const value = await this.request(
      `/v1/runner-jobs/intents/${encodeURIComponent(input.intentId)}/abandon`,
      { method: "POST", body: JSON.stringify(input) },
    );
    return assertExternalEffectRecord(value as ExternalEffectRecord);
  }
  async reconcileProvisioningEffect(input: {
    intentId: string;
    claimantId: string;
    expectedEpoch: number;
    jobId?: string;
    reconciliation: ExternalEffectControlReconciliation;
    observation?: StepObservation;
  }): Promise<ExternalEffectRecord> {
    const value = await this.request(
      `/v1/runner-jobs/intents/${encodeURIComponent(input.intentId)}/reconciliation`,
      { method: "POST", body: JSON.stringify(input) },
    );
    return assertExternalEffectRecord(value as ExternalEffectRecord);
  }
  async listOpenJobs(
    rolloutId: string,
  ): Promise<readonly PersistedRunnerJob[]> {
    const value = await this.request(
      `/v1/runner-jobs?rollout_id=${encodeURIComponent(rolloutId)}&state=open`,
    );
    if (!Array.isArray(value))
      throw new Error("runner_ledger_open_jobs_invalid");
    return value as PersistedRunnerJob[];
  }
  async markTerminal(
    jobId: string,
    observation: StepObservation,
  ): Promise<void> {
    await this.request(
      `/v1/runner-jobs/${encodeURIComponent(jobId)}/terminal`,
      { method: "PUT", body: JSON.stringify({ observation }) },
    );
  }
  async persistValidatedIdentity(
    jobId: string,
    identity: RunnerIdentity,
    observation: StepObservation,
  ): Promise<void> {
    await this.request(
      `/v1/runner-jobs/${encodeURIComponent(jobId)}/identity`,
      { method: "PUT", body: JSON.stringify({ identity, observation }) },
    );
  }
  async persistRegistration(input: {
    rolloutId: string;
    lifecycle: "role" | "cutover";
    workflowJobId: string;
    registration: {
      runnerId: number;
      runnerGroupId: number;
      labels: readonly string[];
      uniqueLabel: string;
      workFolder: string;
    };
  }): Promise<void> {
    await this.request("/v1/runner-jobs/registration", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }
  async currentRunner(
    rolloutId: string,
    lifecycle: "role" | "cutover",
  ): Promise<{ identity: RunnerIdentity; observation: StepObservation }> {
    const value = (await this.request(
      `/v1/runner-jobs/current?rollout_id=${encodeURIComponent(rolloutId)}&lifecycle=${lifecycle}`,
    )) as Record<string, unknown>;
    if (!value.identity || !value.observation)
      throw new Error("runner_ledger_current_identity_invalid");
    return value as unknown as {
      identity: RunnerIdentity;
      observation: StepObservation;
    };
  }
  async cleanupObservation(jobId: string): Promise<StepObservation> {
    const value = await this.request(
      `/v1/runner-jobs/${encodeURIComponent(jobId)}/cleanup-observation`,
    );
    if (
      !value ||
      typeof value !== "object" ||
      typeof (value as StepObservation).step !== "string"
    )
      throw new Error("runner_ledger_cleanup_observation_invalid");
    return value as StepObservation;
  }
  async observe(
    jobId: string,
    expectedCanary: string,
  ): Promise<{
    providerStatus: "succeeded" | "failed" | "canceled";
    listenerStopped: true;
    workspaceRemoved: true;
    credentialProcessGone: true;
    canary: string;
    observedAt: string;
  }> {
    const value = (await this.request(
      `/v1/runner-jobs/${encodeURIComponent(jobId)}/cleanup-witness`,
    )) as Record<string, unknown>;
    if (
      !["succeeded", "failed", "canceled"].includes(
        String(value.providerStatus),
      ) ||
      value.listenerStopped !== true ||
      value.workspaceRemoved !== true ||
      value.credentialProcessGone !== true ||
      value.canary !== expectedCanary ||
      typeof value.observedAt !== "string"
    )
      throw new Error("runner_ledger_cleanup_witness_invalid");
    return value as {
      providerStatus: "succeeded" | "failed" | "canceled";
      listenerStopped: true;
      workspaceRemoved: true;
      credentialProcessGone: true;
      canary: string;
      observedAt: string;
    };
  }
  async claim(input: {
    rolloutId: string;
    expectedCommitSha: string;
    runId: string;
    runAttempt: number;
    sourceSystemIdentifier: string;
    targetSystemIdentifier: string;
  }): Promise<"claimed" | "duplicate"> {
    const value = (await this.request("/v1/rollouts/claim", {
      method: "POST",
      body: JSON.stringify(input),
    })) as Record<string, unknown>;
    if (value.result !== "claimed" && value.result !== "duplicate")
      throw new Error("runner_ledger_rollout_claim_invalid");
    return value.result;
  }
  async compareAndSet(input: {
    rolloutId: string;
    expectedCommitSha: string;
    runId: string;
    runAttempt: number;
    sourceSystemIdentifier: string;
    targetSystemIdentifier: string;
    step: import("../domain/release-rollout").RolloutStep;
    provider: StepObservation["provider"];
    expectedReceiptSha256: string;
    nextReceiptSha256: string;
    authoritativeSystemIdentifier: string;
    expectedActivationBoundary: "before" | "activated" | "uncertain";
    nextActivationBoundary: "before" | "activated" | "uncertain";
  }): Promise<boolean> {
    const value = (await this.request(
      `/v1/rollouts/${encodeURIComponent(input.rolloutId)}/cas`,
      { method: "POST", body: JSON.stringify(input) },
    )) as Record<string, unknown>;
    if (typeof value.changed !== "boolean")
      throw new Error("runner_ledger_rollout_cas_invalid");
    return value.changed;
  }
  async markActivationUncertain(input: {
    rolloutId: string;
    expectedCommitSha: string;
    runId: string;
    runAttempt: number;
    sourceSystemIdentifier: string;
    targetSystemIdentifier: string;
  }): Promise<void> {
    const value = (await this.request(
      `/v1/rollouts/${encodeURIComponent(input.rolloutId)}/activation-uncertain`,
      { method: "PUT", body: JSON.stringify(input) },
    )) as Record<string, unknown>;
    if (value.marked !== true)
      throw new Error("runner_ledger_activation_uncertain_mark_invalid");
  }
  async fenceTargetSwitch(input: {
    rolloutId: string;
    expectedCommitSha: string;
    runId: string;
    runAttempt: number;
    sourceSystemIdentifier: string;
    targetSystemIdentifier: string;
    previousReceiptSha256: string;
  }): Promise<TargetSwitchFence | null> {
    const value = (await this.request(
      `/v1/rollouts/${encodeURIComponent(input.rolloutId)}/target-switch-fence`,
      { method: "POST", body: JSON.stringify(input) },
    )) as { changed?: unknown; fence?: TargetSwitchFence };
    if (value.changed === false) return null;
    const fence = value.fence;
    if (
      value.changed !== true ||
      !fence ||
      fence.rolloutId !== input.rolloutId ||
      fence.expectedCommitSha !== input.expectedCommitSha ||
      fence.runId !== input.runId ||
      fence.runAttempt !== input.runAttempt ||
      fence.sourceSystemIdentifier !== input.sourceSystemIdentifier ||
      fence.targetSystemIdentifier !== input.targetSystemIdentifier ||
      fence.previousReceiptSha256 !== input.previousReceiptSha256 ||
      !/^[a-f0-9]{32}$/u.test(fence.nonce) ||
      !Number.isSafeInteger(fence.version) ||
      fence.version < 1
    )
      throw new Error("runner_ledger_target_switch_fence_invalid");
    return fence;
  }
  async authorizeActivation(input: {
    rolloutId: string;
    expectedCommitSha: string;
    runId: string;
    jobId: string;
    runAttempt: number;
    sourceSystemIdentifier: string;
    targetSystemIdentifier: string;
    previousReceiptSha256: string;
    targetDeployIds: readonly string[];
    postgresMajor: 17;
    migrationChecksum: string;
  }): Promise<ActivationAuthorization> {
    const value = (await this.request(
      `/v1/rollouts/${encodeURIComponent(input.rolloutId)}/activation-authorization`,
      { method: "POST", body: JSON.stringify(input) },
    )) as Record<string, unknown>;
    const authorization = value.authorization as
      | ActivationAuthorization
      | undefined;
    if (
      !authorization ||
      authorization.rolloutId !== input.rolloutId ||
      authorization.expectedCommitSha !== input.expectedCommitSha ||
      authorization.postgresMajor !== input.postgresMajor ||
      authorization.migrationChecksum !== input.migrationChecksum ||
      authorization.sourceSystemIdentifier !== input.sourceSystemIdentifier ||
      authorization.targetSystemIdentifier !== input.targetSystemIdentifier ||
      authorization.previousReceiptSha256 !== input.previousReceiptSha256 ||
      JSON.stringify(authorization.targetDeployIds) !==
        JSON.stringify(input.targetDeployIds) ||
      !/^[a-f0-9]{32}$/u.test(authorization.nonce) ||
      !Number.isSafeInteger(authorization.epoch) ||
      authorization.epoch < 1 ||
      Number.isNaN(Date.parse(authorization.authorizedAt))
    )
      throw new Error("runner_ledger_activation_authorization_invalid");
    return authorization;
  }
  async finalizeActivation(input: {
    authorization: ActivationAuthorization;
    provider: StepObservation["provider"];
    nextReceiptSha256: string;
    activationReceipt: ActivationReceipt;
  }): Promise<boolean> {
    const value = (await this.request(
      `/v1/rollouts/${encodeURIComponent(input.authorization.rolloutId)}/activation-finalize`,
      { method: "POST", body: JSON.stringify(input) },
    )) as Record<string, unknown>;
    if (typeof value.changed !== "boolean")
      throw new Error("runner_ledger_activation_finalize_invalid");
    return value.changed;
  }
  async observeActivationState(input: {
    rolloutId: string;
    sourceSystemIdentifier: string;
    targetSystemIdentifier: string;
  }): Promise<"before" | "uncertain" | "activated"> {
    const value = (await this.request(
      `/v1/rollouts/${encodeURIComponent(input.rolloutId)}/activation-state?source_system_identifier=${encodeURIComponent(input.sourceSystemIdentifier)}&target_system_identifier=${encodeURIComponent(input.targetSystemIdentifier)}`,
    )) as Record<string, unknown>;
    if (!["before", "uncertain", "activated"].includes(String(value.state)))
      throw new Error("runner_ledger_activation_state_invalid");
    return value.state as "before" | "uncertain" | "activated";
  }
  async observeCompensationCheckpoint(input: {
    rolloutId: string;
    sourceSystemIdentifier: string;
    targetSystemIdentifier: string;
  }): Promise<CompensationCheckpoint> {
    const value = (await this.request(
      `/v1/rollouts/${encodeURIComponent(input.rolloutId)}/compensation-checkpoint?source_system_identifier=${encodeURIComponent(input.sourceSystemIdentifier)}&target_system_identifier=${encodeURIComponent(input.targetSystemIdentifier)}`,
    )) as Record<string, unknown>;
    if (
      !["before", "uncertain", "activated"].includes(
        String(value.activationBoundary),
      ) ||
      ![
        "pre_activation",
        "compensating",
        "compensated",
        "activation_authorized",
        "activated",
        "outcome_unknown",
        "forward_repair_required",
      ].includes(String(value.state)) ||
      !/^sha256:[a-f0-9]{64}$/u.test(String(value.lastReceiptSha256)) ||
      (value.lastStep !== null && typeof value.lastStep !== "string") ||
      !Number.isSafeInteger(value.receiptCount) ||
      Number(value.receiptCount) < 0
    )
      throw new Error("runner_ledger_compensation_checkpoint_invalid");
    return value as unknown as CompensationCheckpoint;
  }
  async begin(
    input: Parameters<ServiceTransitionLedger["begin"]>[0],
  ): Promise<"created" | "existing"> {
    const value = (await this.request("/v1/service-transitions", {
      method: "POST",
      body: JSON.stringify(input),
    })) as Record<string, unknown>;
    if (value.result !== "created" && value.result !== "existing")
      throw new Error("runner_ledger_service_transition_begin_invalid");
    return value.result;
  }
  async readContract(
    rolloutId: string,
  ): Promise<Awaited<ReturnType<ServiceTransitionLedger["readContract"]>>> {
    return (await this.request(
      `/v1/service-transitions/${encodeURIComponent(rolloutId)}/contract`,
    )) as Awaited<ReturnType<ServiceTransitionLedger["readContract"]>>;
  }
  async append(
    checkpoint: Omit<ServiceTransitionCheckpoint, "sequence">,
  ): Promise<ServiceTransitionCheckpoint> {
    const value = (await this.request(
      `/v1/service-transitions/${encodeURIComponent(checkpoint.rolloutId)}/checkpoints`,
      { method: "POST", body: JSON.stringify(checkpoint) },
    )) as Record<string, unknown>;
    if (!value.checkpoint || typeof value.checkpoint !== "object")
      throw new Error("runner_ledger_service_transition_checkpoint_invalid");
    return value.checkpoint as ServiceTransitionCheckpoint;
  }
  async read(
    rolloutId: string,
  ): Promise<readonly ServiceTransitionCheckpoint[]> {
    const value = await this.request(
      `/v1/service-transitions/${encodeURIComponent(rolloutId)}/checkpoints`,
    );
    if (!Array.isArray(value))
      throw new Error("runner_ledger_service_transition_read_invalid");
    return value as ServiceTransitionCheckpoint[];
  }
  async complete(input: {
    rolloutId: string;
    outcome: "target_staged" | "source_recovered";
  }): Promise<void> {
    await this.request(
      `/v1/service-transitions/${encodeURIComponent(input.rolloutId)}/complete`,
      { method: "POST", body: JSON.stringify({ outcome: input.outcome }) },
    );
  }
  async verifyFinalAuthority(input: {
    rolloutId: string;
    expectedCommitSha: string;
    runId: string;
    runAttempt: number;
    sourceSystemIdentifier: string;
    targetSystemIdentifier: string;
    expectedReceiptSha256: string;
    activationReceipt: ActivationReceipt;
  }): Promise<boolean> {
    const value = (await this.request(
      `/v1/rollouts/${encodeURIComponent(input.rolloutId)}/verify-final-authority`,
      { method: "POST", body: JSON.stringify(input) },
    )) as Record<string, unknown>;
    if (typeof value.verified !== "boolean")
      throw new Error("runner_ledger_final_authority_response_invalid");
    return value.verified;
  }
  async reconcileRollout(rolloutId: string): Promise<{
    state:
      | "pre_activation_compensated"
      | "activated_forward_only"
      | "activation_uncertain_forward_only";
    sourceEligible: boolean;
    sourceAclRestored: boolean;
    sourceServicesResumed: boolean;
    openRunnerJobs: 0;
  }> {
    const value = (await this.request(
      `/v1/rollouts/${encodeURIComponent(rolloutId)}/reconcile`,
      { method: "POST", body: "{}" },
    )) as Record<string, unknown>;
    const state =
      value.state === "activated"
        ? "activated_forward_only"
        : value.state === "forward_repair_required"
          ? "activation_uncertain_forward_only"
          : value.state;
    if (
      ![
        "pre_activation_compensated",
        "activated_forward_only",
        "activation_uncertain_forward_only",
      ].includes(String(state)) ||
      value.openRunnerJobs !== 0 ||
      (state === "pre_activation_compensated"
        ? value.sourceEligible !== true ||
          value.sourceAclRestored !== true ||
          value.sourceServicesResumed !== true
        : value.sourceEligible !== false ||
          value.sourceAclRestored !== false ||
          value.sourceServicesResumed !== false)
    )
      throw new Error("runner_ledger_rollout_reconciliation_invalid");
    return { ...value, state } as {
      state:
        | "pre_activation_compensated"
        | "activated_forward_only"
        | "activation_uncertain_forward_only";
      sourceEligible: boolean;
      sourceAclRestored: boolean;
      sourceServicesResumed: boolean;
      openRunnerJobs: 0;
    };
  }
}

/** Triggers the separately credentialed provider-side observer by job identity. */
export class AuthenticatedProviderWitnessAdapter {
  constructor(
    private readonly origin: string,
    private readonly token: string,
    private readonly fetchImpl: RenderFetch = fetch,
  ) {
    if (!origin.startsWith("https://") || !token)
      throw new Error("runner_witness_configuration_invalid");
  }

  async observe(jobId: string): Promise<void> {
    const response = await this.fetchImpl(
      `${this.origin.replace(/\/$/u, "")}/v1/runner-jobs/${encodeURIComponent(jobId)}/cleanup-observation`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: "{}",
      },
    );
    if (!response.ok)
      throw new Error(`runner_witness_request_failed:${response.status}`);
  }
}
