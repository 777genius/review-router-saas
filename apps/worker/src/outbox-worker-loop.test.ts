import { describe, expect, it } from "vitest";
import type { Logger } from "@reviewrouter/platform-logger";
import {
  runOutboxWorkerLoop,
  safeWorkerErrorSummary,
  type SleepPort,
} from "./outbox-worker-loop";

class MemoryLogger implements Logger {
  readonly infoMessages: Array<{
    message: string;
    context: Record<string, unknown> | undefined;
  }> = [];
  readonly errorMessages: Array<{
    message: string;
    context: Record<string, unknown> | undefined;
  }> = [];

  info(message: string, context?: Record<string, unknown>): void {
    this.infoMessages.push({ message, context });
  }

  warn(): void {
    // Not used by this test logger.
  }

  error(message: string, context?: Record<string, unknown>): void {
    this.errorMessages.push({ message, context });
  }
}

const result = (claimed: number) => ({
  claimed,
  processed: claimed,
  retried: 0,
  deadLettered: 0,
});

describe("outbox worker loop", () => {
  it("uses busy delay after claimed work and idle delay after empty batches", async () => {
    const logger = new MemoryLogger();
    const sleeps: number[] = [];
    const sleep: SleepPort = async (milliseconds) => {
      sleeps.push(milliseconds);
    };
    const batches = [result(2), result(0), result(1)];

    const summary = await runOutboxWorkerLoop(
      {
        signal: new AbortController().signal,
        busyDelayMs: 10,
        idleDelayMs: 100,
        errorDelayMs: 1000,
        maxIterations: 3,
      },
      {
        logger,
        sleep,
        processor: {
          processBatch: async () => batches.shift() ?? result(0),
        },
      },
    );

    expect(summary).toEqual({
      iterations: 3,
      claimed: 3,
      processed: 3,
      retried: 0,
      deadLettered: 0,
      errors: 0,
    });
    expect(sleeps).toEqual([10, 100]);
  });

  it("logs safe errors and continues polling", async () => {
    const logger = new MemoryLogger();
    const sleeps: number[] = [];
    let call = 0;
    const githubToken = "gh" + "p_secret";

    const summary = await runOutboxWorkerLoop(
      {
        signal: new AbortController().signal,
        busyDelayMs: 10,
        idleDelayMs: 100,
        errorDelayMs: 1000,
        maxIterations: 2,
      },
      {
        logger,
        sleep: async (milliseconds) => {
          sleeps.push(milliseconds);
        },
        processor: {
          processBatch: async () => {
            call += 1;
            if (call === 1) {
              throw new Error(
                `failed for postgresql://user:secret@localhost/db?token=abc and ${githubToken}`,
              );
            }
            return result(0);
          },
        },
      },
    );

    expect(summary.errors).toBe(1);
    expect(summary.iterations).toBe(2);
    expect(sleeps).toEqual([1000]);
    expect(logger.errorMessages[0]?.context).toEqual({
      safeErrorSummary:
        "failed for postgresql://<redacted>@localhost/db?token=<redacted> and <redacted>",
    });
  });

  it("redacts common token shapes in worker errors", () => {
    const openAiToken = "s" + "k-secret123456";
    const githubToken = "github" + "_pat_abcdef";

    expect(
      safeWorkerErrorSummary(
        new Error(`token ${openAiToken} and ${githubToken} should not leak`),
      ),
    ).toBe("token <redacted> and <redacted> should not leak");
  });
});
