import { randomBytes } from "node:crypto";
import type {
  ActivationFence,
  ActivationReceipt,
  AuthoritativeGenerationLedger,
  RolloutStep,
  StepObservation,
} from "../domain/release-rollout";
import type { RunnerIdentity } from "../domain/release-rollout";
import type {
  PersistedRunnerJob,
  RunnerProvisioningIntent,
  RunnerJobLedger,
} from "./render-private-runner";
import { decomposePostgresConnection } from "./postgres-generation";
import type { CommandExecutor } from "./process-command";

const literal = (value: string): string => `'${value.replaceAll("'", "''")}'`;
export class PostgreSqlRolloutLedgerAdapter
  implements AuthoritativeGenerationLedger, RunnerJobLedger
{
  constructor(
    private readonly databaseUrl: string,
    private readonly commands: CommandExecutor,
  ) {}
  private sql(statement: string): string {
    const connection = decomposePostgresConnection(this.databaseUrl);
    try {
      return this.commands
        .execute(
          "psql",
          [
            ...connection.args,
            "--no-psqlrc",
            "--set",
            "ON_ERROR_STOP=1",
            "--tuples-only",
            "--no-align",
            "--command",
            statement,
          ],
          { env: connection.env },
        )
        .stdout.trim();
    } finally {
      connection.cleanup();
    }
  }
  async claim(input: {
    rolloutId: string;
    expectedCommitSha: string;
    runId: string;
    runAttempt: number;
    sourceSystemIdentifier: string;
    targetSystemIdentifier: string;
  }): Promise<"claimed" | "duplicate"> {
    const result = this.sql(
      `INSERT INTO reviewrouter_bootstrap.release_rollout_ledger(rollout_id,expected_commit_sha,run_id,run_attempt,source_system_identifier,target_system_identifier,authoritative_system_identifier,activation_boundary,last_receipt_sha256) VALUES (${literal(input.rolloutId)},${literal(input.expectedCommitSha)},${literal(input.runId)},${input.runAttempt},${literal(input.sourceSystemIdentifier)},${literal(input.targetSystemIdentifier)},${literal(input.sourceSystemIdentifier)},'before','sha256:${"0".repeat(64)}') ON CONFLICT (rollout_id) DO NOTHING RETURNING rollout_id`,
    );
    return result === input.rolloutId ? "claimed" : "duplicate";
  }
  async compareAndSet(input: {
    rolloutId: string;
    expectedCommitSha: string;
    runId: string;
    runAttempt: number;
    sourceSystemIdentifier: string;
    targetSystemIdentifier: string;
    step: RolloutStep;
    provider: StepObservation["provider"];
    expectedReceiptSha256: string;
    nextReceiptSha256: string;
    authoritativeSystemIdentifier: string;
    activationBoundary: "before" | "activated" | "uncertain";
  }): Promise<boolean> {
    const result = this.sql(
      `WITH changed AS (UPDATE reviewrouter_bootstrap.release_rollout_ledger SET last_receipt_sha256=${literal(input.nextReceiptSha256)}, authoritative_system_identifier=${literal(input.authoritativeSystemIdentifier)}, activation_boundary=${literal(input.activationBoundary)}, source_permanently_ineligible=(source_permanently_ineligible OR ${input.activationBoundary === "before" ? "false" : "true"}) WHERE rollout_id=${literal(input.rolloutId)} AND expected_commit_sha=${literal(input.expectedCommitSha)} AND run_id=${literal(input.runId)} AND run_attempt=${input.runAttempt} AND source_system_identifier=${literal(input.sourceSystemIdentifier)} AND target_system_identifier=${literal(input.targetSystemIdentifier)} AND last_receipt_sha256=${literal(input.expectedReceiptSha256)} AND NOT (source_permanently_ineligible AND ${literal(input.authoritativeSystemIdentifier)}=source_system_identifier) RETURNING rollout_id) INSERT INTO reviewrouter_bootstrap.release_rollout_receipt_ledger(rollout_id,expected_commit_sha,run_id,run_attempt,source_system_identifier,target_system_identifier,step,provider_binding,previous_receipt_sha256,receipt_sha256,activation_boundary) SELECT rollout_id,${literal(input.expectedCommitSha)},${literal(input.runId)},${input.runAttempt},${literal(input.sourceSystemIdentifier)},${literal(input.targetSystemIdentifier)},${literal(input.step)},${literal(JSON.stringify(input.provider ?? null))}::jsonb,${literal(input.expectedReceiptSha256)},${literal(input.nextReceiptSha256)},${literal(input.activationBoundary)} FROM changed RETURNING rollout_id`,
    );
    return result === input.rolloutId;
  }
  async markActivationUncertain(input: {
    rolloutId: string;
    expectedCommitSha: string;
    runId: string;
    runAttempt: number;
    sourceSystemIdentifier: string;
    targetSystemIdentifier: string;
  }): Promise<void> {
    const result = this.sql(
      `UPDATE reviewrouter_bootstrap.release_rollout_ledger SET authoritative_system_identifier=target_system_identifier, activation_boundary='uncertain', source_permanently_ineligible=true WHERE rollout_id=${literal(input.rolloutId)} AND expected_commit_sha=${literal(input.expectedCommitSha)} AND run_id=${literal(input.runId)} AND run_attempt=${input.runAttempt} AND source_system_identifier=${literal(input.sourceSystemIdentifier)} AND target_system_identifier=${literal(input.targetSystemIdentifier)} RETURNING rollout_id`,
    );
    if (result !== input.rolloutId)
      throw new Error("activation_uncertain_ledger_binding_mismatch");
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
  }): Promise<ActivationFence | null> {
    const nonce = randomBytes(16).toString("hex");
    const value = this.sql(
      `UPDATE reviewrouter_bootstrap.release_rollout_ledger SET authoritative_system_identifier=target_system_identifier, activation_boundary='uncertain', source_permanently_ineligible=true, activation_fence_nonce=${literal(nonce)}, activation_fence_version=activation_fence_version+1, activation_job_id=${literal(input.jobId)}, activation_fenced_at=clock_timestamp() WHERE rollout_id=${literal(input.rolloutId)} AND expected_commit_sha=${literal(input.expectedCommitSha)} AND run_id=${literal(input.runId)} AND run_attempt=${input.runAttempt} AND source_system_identifier=${literal(input.sourceSystemIdentifier)} AND target_system_identifier=${literal(input.targetSystemIdentifier)} AND last_receipt_sha256=${literal(input.previousReceiptSha256)} AND activation_boundary='before' AND activation_fence_nonce IS NULL RETURNING json_build_object('schemaVersion',1,'rolloutId',rollout_id,'expectedCommitSha',expected_commit_sha,'runId',run_id,'jobId',activation_job_id,'runAttempt',run_attempt,'sourceSystemIdentifier',source_system_identifier,'targetSystemIdentifier',target_system_identifier,'previousReceiptSha256',last_receipt_sha256,'nonce',activation_fence_nonce,'version',activation_fence_version,'fencedAt',to_char(activation_fenced_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))::text`,
    );
    return value ? (JSON.parse(value) as ActivationFence) : null;
  }
  async finalizeActivation(input: {
    fence: ActivationFence;
    provider: StepObservation["provider"];
    nextReceiptSha256: string;
    activationReceipt: ActivationReceipt;
  }): Promise<boolean> {
    const result = this.sql(
      `WITH changed AS (UPDATE reviewrouter_bootstrap.release_rollout_ledger SET activation_boundary='activated', last_receipt_sha256=${literal(input.nextReceiptSha256)}, activation_receipt=${literal(JSON.stringify(input.activationReceipt))}::jsonb WHERE rollout_id=${literal(input.fence.rolloutId)} AND expected_commit_sha=${literal(input.fence.expectedCommitSha)} AND run_id=${literal(input.fence.runId)} AND run_attempt=${input.fence.runAttempt} AND source_system_identifier=${literal(input.fence.sourceSystemIdentifier)} AND target_system_identifier=${literal(input.fence.targetSystemIdentifier)} AND activation_boundary='uncertain' AND source_permanently_ineligible=true AND last_receipt_sha256=${literal(input.fence.previousReceiptSha256)} AND activation_fence_nonce=${literal(input.fence.nonce)} AND activation_fence_version=${input.fence.version} AND activation_job_id=${literal(input.fence.jobId)} RETURNING rollout_id) INSERT INTO reviewrouter_bootstrap.release_rollout_receipt_ledger(rollout_id,expected_commit_sha,run_id,run_attempt,source_system_identifier,target_system_identifier,step,provider_binding,previous_receipt_sha256,receipt_sha256,activation_boundary) SELECT rollout_id,${literal(input.fence.expectedCommitSha)},${literal(input.fence.runId)},${input.fence.runAttempt},${literal(input.fence.sourceSystemIdentifier)},${literal(input.fence.targetSystemIdentifier)},'activate_target_generation',${literal(JSON.stringify(input.provider ?? null))}::jsonb,${literal(input.fence.previousReceiptSha256)},${literal(input.nextReceiptSha256)},'activated' FROM changed RETURNING rollout_id`,
    );
    return result === input.fence.rolloutId;
  }
  async observeActivationState(input: {
    rolloutId: string;
    sourceSystemIdentifier: string;
    targetSystemIdentifier: string;
  }): Promise<"before" | "uncertain" | "activated"> {
    const result = this.sql(
      `SELECT activation_boundary FROM reviewrouter_bootstrap.release_rollout_ledger WHERE rollout_id=${literal(input.rolloutId)} AND source_system_identifier=${literal(input.sourceSystemIdentifier)} AND target_system_identifier=${literal(input.targetSystemIdentifier)}`,
    );
    if (!["before", "uncertain", "activated"].includes(result))
      throw new Error("activation_state_binding_mismatch");
    return result as "before" | "uncertain" | "activated";
  }
  async persistCreatedJob(value: PersistedRunnerJob): Promise<void> {
    const result = this.sql(
      `INSERT INTO reviewrouter_bootstrap.release_runner_job_ledger(rollout_id,service_id,job_id,observed_at,cleanup_canary,lifecycle,provisioning_intent_id) VALUES (${literal(value.rolloutId)},${literal(value.serviceId)},${literal(value.jobId)},${literal(value.observedAt)}::timestamptz,${literal(value.cleanupCanary)},${literal(value.lifecycle)},${literal(value.provisioningIntentId)}) ON CONFLICT (job_id) DO NOTHING RETURNING job_id`,
    );
    if (result !== value.jobId)
      throw new Error("runner_job_identity_already_persisted");
  }
  async persistProvisioningIntent(
    value: RunnerProvisioningIntent,
  ): Promise<"created" | "existing"> {
    const result = this.sql(
      `INSERT INTO reviewrouter_bootstrap.release_runner_provisioning_intent(intent_id,rollout_id,service_id,lifecycle,workflow_job_id,runner_name,created_at) VALUES (${literal(value.id)},${literal(value.rolloutId)},${literal(value.serviceId)},${literal(value.lifecycle)},${literal(value.workflowJobId)},${literal(value.runnerName)},${literal(value.createdAt)}::timestamptz) ON CONFLICT (intent_id) DO NOTHING RETURNING intent_id`,
    );
    if (result === value.id) return "created";
    const existing = this.sql(
      `SELECT intent_id FROM reviewrouter_bootstrap.release_runner_provisioning_intent WHERE intent_id=${literal(value.id)} AND rollout_id=${literal(value.rolloutId)} AND service_id=${literal(value.serviceId)} AND lifecycle=${literal(value.lifecycle)} AND workflow_job_id=${literal(value.workflowJobId)} AND runner_name=${literal(value.runnerName)}`,
    );
    if (existing !== value.id)
      throw new Error("runner_provisioning_intent_conflict");
    return "existing";
  }
  async listProvisioningIntents(
    rolloutId: string,
  ): Promise<readonly RunnerProvisioningIntent[]> {
    return JSON.parse(
      this.sql(
        `SELECT coalesce(json_agg(json_build_object('id',intent_id,'rolloutId',rollout_id,'serviceId',service_id,'lifecycle',lifecycle,'workflowJobId',workflow_job_id,'runnerName',runner_name,'createdAt',to_char(created_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) ORDER BY created_at),'[]'::json)::text FROM reviewrouter_bootstrap.release_runner_provisioning_intent WHERE rollout_id=${literal(rolloutId)}`,
      ),
    ) as RunnerProvisioningIntent[];
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
    const result = this.sql(
      `UPDATE reviewrouter_bootstrap.release_runner_provisioning_intent SET provider_job_id=${literal(input.jobId)}, outcome=${literal(input.outcome)}, reconciliation_observation=${literal(JSON.stringify(input.observation ?? null))}::jsonb, reconciled_at=clock_timestamp() WHERE intent_id=${literal(input.intentId)} AND (provider_job_id IS NULL OR provider_job_id=${literal(input.jobId)}) RETURNING intent_id`,
    );
    if (result !== input.intentId)
      throw new Error("runner_provisioning_outcome_cas_failed");
  }
  async listOpenJobs(
    rolloutId: string,
  ): Promise<readonly PersistedRunnerJob[]> {
    const value = this.sql(
      `SELECT coalesce(json_agg(json_build_object('rolloutId',rollout_id,'serviceId',service_id,'jobId',job_id,'observedAt',to_char(observed_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'cleanupCanary',cleanup_canary,'lifecycle',lifecycle) ORDER BY observed_at),'[]'::json) FROM reviewrouter_bootstrap.release_runner_job_ledger WHERE rollout_id=${literal(rolloutId)} AND terminal_at IS NULL`,
    );
    return JSON.parse(value) as PersistedRunnerJob[];
  }
  async markTerminal(
    jobId: string,
    observation: StepObservation,
  ): Promise<void> {
    const result = this.sql(
      `UPDATE reviewrouter_bootstrap.release_runner_job_ledger SET terminal_at=clock_timestamp(), cleanup_observation=${literal(JSON.stringify(observation))}::jsonb WHERE job_id=${literal(jobId)} AND terminal_at IS NULL RETURNING job_id`,
    );
    if (result !== jobId) throw new Error("runner_job_terminal_cas_failed");
  }
  async persistValidatedIdentity(
    jobId: string,
    identity: RunnerIdentity,
    observation: StepObservation,
  ): Promise<void> {
    const result = this.sql(
      `UPDATE reviewrouter_bootstrap.release_runner_job_ledger SET runner_identity=${literal(JSON.stringify(identity))}::jsonb, provision_observation=${literal(JSON.stringify(observation))}::jsonb WHERE job_id=${literal(jobId)} AND runner_identity IS NULL RETURNING job_id`,
    );
    if (result !== jobId) throw new Error("runner_job_identity_cas_failed");
  }
}
