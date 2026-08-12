import type {
  AuthoritativeGenerationLedger,
  StepObservation,
} from "../domain/release-rollout";
import type { RunnerIdentity } from "../domain/release-rollout";
import type {
  PersistedRunnerJob,
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
    expectedReceiptSha256: string;
    nextReceiptSha256: string;
    authoritativeSystemIdentifier: string;
    activationBoundary: "before" | "activated" | "uncertain";
  }): Promise<boolean> {
    const result = this.sql(
      `UPDATE reviewrouter_bootstrap.release_rollout_ledger SET last_receipt_sha256=${literal(input.nextReceiptSha256)}, authoritative_system_identifier=${literal(input.authoritativeSystemIdentifier)}, activation_boundary=${literal(input.activationBoundary)}, source_permanently_ineligible=(source_permanently_ineligible OR ${input.activationBoundary === "before" ? "false" : "true"}) WHERE rollout_id=${literal(input.rolloutId)} AND last_receipt_sha256=${literal(input.expectedReceiptSha256)} AND NOT (source_permanently_ineligible AND ${literal(input.authoritativeSystemIdentifier)}=source_system_identifier) RETURNING rollout_id`,
    );
    return result === input.rolloutId;
  }
  async persistCreatedJob(value: PersistedRunnerJob): Promise<void> {
    const result = this.sql(
      `INSERT INTO reviewrouter_bootstrap.release_runner_job_ledger(rollout_id,service_id,job_id,observed_at,cleanup_canary,lifecycle) VALUES (${literal(value.rolloutId)},${literal(value.serviceId)},${literal(value.jobId)},${literal(value.observedAt)}::timestamptz,${literal(value.cleanupCanary)},${literal(value.lifecycle)}) ON CONFLICT (job_id) DO NOTHING RETURNING job_id`,
    );
    if (result !== value.jobId)
      throw new Error("runner_job_identity_already_persisted");
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
