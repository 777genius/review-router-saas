import type { StepObservation } from "../domain/release-rollout";
import type { RunnerIdentity } from "../domain/release-rollout";
import type {
  PersistedRunnerJob,
  RunnerProvisioningIntent,
  RunnerJobLedger,
} from "./render-private-runner";
import { decomposePostgresConnection } from "./postgres-generation";
import type { CommandExecutor } from "./process-command";

const literal = (value: string): string => `'${value.replaceAll("'", "''")}'`;
export class PostgreSqlRolloutLedgerAdapter implements RunnerJobLedger {
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
