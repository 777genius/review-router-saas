import type { StepObservation } from "../domain/release-rollout";
import type { RunnerIdentity } from "../domain/release-rollout";
import type {
  CreateRunnerProvisioningIntent,
  PersistedRunnerJob,
  RunnerProvisioningIntent,
  RunnerJobLedger,
} from "./render-private-runner";
import { decomposePostgresConnection } from "./postgres-generation";
import type { CommandExecutor } from "./process-command";
import {
  assertExternalEffectRecord,
  type ExternalEffectControlReconciliation,
  type ExternalEffectRecord,
} from "../domain/external-effect";

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
      `SELECT release_authority.release_runner_persist_job(${literal(JSON.stringify(value))}::jsonb)`,
    );
    if (result !== "t") throw new Error("runner_job_identity_persist_failed");
  }
  async persistProvisioningIntent(
    value: CreateRunnerProvisioningIntent,
  ): Promise<ExternalEffectRecord> {
    return assertExternalEffectRecord(
      JSON.parse(
        this.sql(
          `SELECT release_authority.release_runner_prepare_effect(${literal(JSON.stringify(value))}::jsonb)::text`,
        ),
      ) as ExternalEffectRecord,
    );
  }
  async listProvisioningIntents(
    rolloutId: string,
  ): Promise<readonly RunnerProvisioningIntent[]> {
    const intents = JSON.parse(
      this.sql(
        `SELECT release_authority.release_runner_list_intents(${literal(rolloutId)})::text`,
      ),
    ) as RunnerProvisioningIntent[];
    for (const intent of intents) assertExternalEffectRecord(intent.effect);
    return intents;
  }
  async acquireProviderDispatchPermit(
    input: Parameters<RunnerJobLedger["acquireProviderDispatchPermit"]>[0],
  ): ReturnType<RunnerJobLedger["acquireProviderDispatchPermit"]> {
    return assertExternalEffectRecord(
      JSON.parse(
        this.sql(
          `SELECT release_authority.release_runner_acquire_dispatch_permit(${literal(JSON.stringify(input))}::jsonb)::text`,
        ),
      ) as ExternalEffectRecord,
    );
  }
  async abandonPreparedEffect(input: {
    intentId: string;
    claimantId: string;
    expectedEpoch: number;
  }): Promise<ExternalEffectRecord> {
    return assertExternalEffectRecord(
      JSON.parse(
        this.sql(
          `SELECT release_authority.release_runner_abandon_prepared(${literal(input.intentId)},${literal(input.claimantId)},${input.expectedEpoch})::text`,
        ),
      ) as ExternalEffectRecord,
    );
  }
  async reconcileProvisioningEffect(input: {
    intentId: string;
    claimantId: string;
    expectedEpoch: number;
    jobId?: string;
    reconciliation: ExternalEffectControlReconciliation;
    observation?: StepObservation;
  }): Promise<ExternalEffectRecord> {
    return assertExternalEffectRecord(
      JSON.parse(
        this.sql(
          `SELECT release_authority.release_runner_reconcile_effect(${literal(JSON.stringify(input))}::jsonb)::text`,
        ),
      ) as ExternalEffectRecord,
    );
  }
  async listOpenJobs(
    rolloutId: string,
  ): Promise<readonly PersistedRunnerJob[]> {
    const value = this.sql(
      `SELECT release_authority.release_runner_list_open_jobs(${literal(rolloutId)})::text`,
    );
    return JSON.parse(value) as PersistedRunnerJob[];
  }
  async currentRunner(
    rolloutId: string,
    lifecycle: "role" | "cutover",
  ): Promise<{ identity: RunnerIdentity; observation: StepObservation }> {
    const value = this.sql(
      `SELECT release_authority.release_runner_current(${literal(rolloutId)},${literal(lifecycle)})::text`,
    );
    if (!value) throw new Error("runner_current_identity_missing");
    return JSON.parse(value) as {
      identity: RunnerIdentity;
      observation: StepObservation;
    };
  }
  async markTerminal(
    jobId: string,
    observation: StepObservation,
  ): Promise<void> {
    const result = this.sql(
      `SELECT release_authority.release_runner_mark_terminal(${literal(jobId)},${literal(JSON.stringify(observation))}::jsonb)`,
    );
    if (result !== "t") throw new Error("runner_job_terminal_cas_failed");
  }
  async persistValidatedIdentity(
    jobId: string,
    identity: RunnerIdentity,
    observation: StepObservation,
  ): Promise<void> {
    const result = this.sql(
      `SELECT release_authority.release_runner_persist_identity(${literal(jobId)},${literal(JSON.stringify(identity))}::jsonb,${literal(JSON.stringify(observation))}::jsonb)`,
    );
    if (result !== "t") throw new Error("runner_job_identity_cas_failed");
  }
}
