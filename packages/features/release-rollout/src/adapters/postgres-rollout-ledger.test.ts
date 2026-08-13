import { describe, expect, it, vi } from "vitest";
import { PostgreSqlRolloutLedgerAdapter } from "./postgres-rollout-ledger";
import type { CommandExecutor } from "./process-command";

describe("PostgreSQL runner-effect ledger SQL contract", () => {
  it("uses the production durable identity and witnessed terminal routines for late jobs", async () => {
    const execute = vi.fn<CommandExecutor["execute"]>(() => ({
      stdout: "t\n",
    }));
    const commands: CommandExecutor = {
      execute,
      hashStdout: vi.fn(),
      executeExpectingFailure: vi.fn(),
    };
    const adapter = new PostgreSqlRolloutLedgerAdapter(
      "postgresql://reviewrouter_release_control:secret@authority.internal/reviewrouter",
      commands,
    );
    const job = {
      rolloutId: "rollout-late",
      serviceId: "svc-late",
      jobId: "job-late-'quoted",
      observedAt: "2026-08-13T00:00:00.000Z",
      cleanupCanary: "rr-cleanup:rollout-late:rr-late",
      lifecycle: "role" as const,
      provisioningIntentId: `rri-${"a".repeat(64)}`,
    };
    const observation = {
      step: "cleanup_role_runner",
      observedAt: "2026-08-13T00:01:00.000Z",
      facts: { terminal: true },
    } as const;

    await adapter.persistCreatedJob(job);
    await adapter.markTerminal(job.jobId, observation as never);

    const statements = execute.mock.calls.map(([, args]) =>
      String((args as readonly string[]).at(-1)),
    );
    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain(
      "SELECT release_authority.release_runner_persist_job(",
    );
    expect(statements[0]).toContain("::jsonb)");
    expect(statements[0]).toContain("job-late-''quoted");
    expect(statements[1]).toContain(
      "SELECT release_authority.release_runner_mark_terminal(",
    );
    expect(statements[1]).toContain("job-late-''quoted");
    expect(statements[1]).toContain("::jsonb)");
    for (const [command, args] of execute.mock.calls) {
      expect(command).toBe("psql");
      expect(args).toContain("ON_ERROR_STOP=1");
      expect(args).toContain("--no-psqlrc");
    }
  });
});
