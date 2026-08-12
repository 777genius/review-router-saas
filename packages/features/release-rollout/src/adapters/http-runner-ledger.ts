import type {
  PersistedRunnerJob,
  RunnerProvisioningIntent,
  RunnerCleanupWitnessPort,
  RunnerJobLedger,
} from "./render-private-runner";
import type { RenderFetch } from "./render-api";
import type {
  ActivationFence,
  ActivationReceipt,
  AuthoritativeGenerationLedger,
  StepObservation,
} from "../domain/release-rollout";
import type { RunnerIdentity } from "../domain/release-rollout";

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
    value: RunnerProvisioningIntent,
  ): Promise<"created" | "existing"> {
    const result = (await this.request("/v1/runner-jobs/intents", {
      method: "POST",
      body: JSON.stringify(value),
    })) as Record<string, unknown>;
    if (result.result !== "created" && result.result !== "existing")
      throw new Error("runner_ledger_provisioning_intent_invalid");
    return result.result;
  }
  async listProvisioningIntents(
    rolloutId: string,
  ): Promise<readonly RunnerProvisioningIntent[]> {
    const value = await this.request(
      `/v1/runner-jobs/intents?rollout_id=${encodeURIComponent(rolloutId)}`,
    );
    if (!Array.isArray(value))
      throw new Error("runner_ledger_provisioning_intents_invalid");
    return value as RunnerProvisioningIntent[];
  }
  async recordProvisioningOutcome(input: {
    intentId: string;
    jobId: string;
    outcome:
      | "bound"
      | "persistence_failed_cleaned"
      | "persistence_failed_unknown";
    observation?: StepObservation;
  }): Promise<void> {
    await this.request(
      `/v1/runner-jobs/intents/${encodeURIComponent(input.intentId)}/outcome`,
      { method: "PUT", body: JSON.stringify(input) },
    );
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
      value.listenerStopped !== true ||
      value.workspaceRemoved !== true ||
      value.credentialProcessGone !== true ||
      value.canary !== expectedCanary ||
      typeof value.observedAt !== "string"
    )
      throw new Error("runner_ledger_cleanup_witness_invalid");
    return value as {
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
    activationBoundary: "before" | "activated" | "uncertain";
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
  async fenceActivation(input: {
    rolloutId: string;
    expectedCommitSha: string;
    runId: string;
    jobId: string;
    runAttempt: number;
    sourceSystemIdentifier: string;
    targetSystemIdentifier: string;
    previousReceiptSha256: string;
    targetDeployIds: readonly string[];
  }): Promise<ActivationFence | null> {
    const value = (await this.request(
      `/v1/rollouts/${encodeURIComponent(input.rolloutId)}/activation-fence`,
      { method: "POST", body: JSON.stringify(input) },
    )) as Record<string, unknown>;
    if (value.changed === false) return null;
    const fence = value.fence as ActivationFence | undefined;
    if (
      value.changed !== true ||
      fence?.rolloutId !== input.rolloutId ||
      fence.expectedCommitSha !== input.expectedCommitSha ||
      fence.runId !== input.runId ||
      fence.jobId !== input.jobId ||
      fence.runAttempt !== input.runAttempt ||
      fence.sourceSystemIdentifier !== input.sourceSystemIdentifier ||
      fence.targetSystemIdentifier !== input.targetSystemIdentifier ||
      fence.previousReceiptSha256 !== input.previousReceiptSha256 ||
      fence.claimVersion < 1 ||
      JSON.stringify(fence.targetDeployIds) !==
        JSON.stringify(input.targetDeployIds) ||
      !/^[a-f0-9]{32}$/u.test(fence.nonce) ||
      !Number.isSafeInteger(fence.version) ||
      fence.version < 1
    )
      throw new Error("runner_ledger_activation_fence_invalid");
    return fence;
  }
  async finalizeActivation(input: {
    fence: ActivationFence;
    provider: StepObservation["provider"];
    nextReceiptSha256: string;
    activationReceipt: ActivationReceipt;
  }): Promise<boolean> {
    const value = (await this.request(
      `/v1/rollouts/${encodeURIComponent(input.fence.rolloutId)}/activation-finalize`,
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
    if (
      ![
        "pre_activation_compensated",
        "activated_forward_only",
        "activation_uncertain_forward_only",
      ].includes(String(value.state)) ||
      value.openRunnerJobs !== 0 ||
      (value.state === "pre_activation_compensated"
        ? value.sourceEligible !== true ||
          value.sourceAclRestored !== true ||
          value.sourceServicesResumed !== true
        : value.sourceEligible !== false ||
          value.sourceAclRestored !== false ||
          value.sourceServicesResumed !== false)
    )
      throw new Error("runner_ledger_rollout_reconciliation_invalid");
    return value as {
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
