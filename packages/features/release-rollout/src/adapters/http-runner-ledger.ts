import type {
  PersistedRunnerJob,
  RunnerCleanupWitnessPort,
  RunnerJobLedger,
} from "./render-private-runner";
import type { RenderFetch } from "./render-api";
import type {
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
