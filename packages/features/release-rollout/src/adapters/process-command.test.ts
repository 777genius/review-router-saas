import { describe, expect, it } from "vitest";
import {
  RedactedProcessCommandAdapter,
  assertSafeProcessBoundary,
} from "./process-command";

describe("redacted process command diagnostics", () => {
  it("does not cross stdout, stderr, argv, env, or nested process errors", () => {
    const canaries = [
      "stdout-secret-canary",
      "stderr-secret-canary",
      "argv-secret-canary",
      "env-secret-canary",
    ] as const;
    let caught: unknown;
    try {
      new RedactedProcessCommandAdapter().execute(
        "node",
        [
          "-e",
          `process.stdout.write(${JSON.stringify(canaries[0])});process.stderr.write(${JSON.stringify(canaries[1])});process.exit(23)`,
          canaries[2],
        ],
        {
          env: {
            PATH: "/usr/local/bin:/usr/bin:/bin",
            LANG: "C.UTF-8",
          },
        },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
    for (const output of [String(caught), JSON.stringify(caught)]) {
      expect(output.length).toBeLessThan(768);
      for (const canary of canaries) expect(output).not.toContain(canary);
    }
  });

  it("rejects secret-bearing argv and environment without echoing them", () => {
    const secrets = [
      "postgresql://owner:dsn-canary@db.invalid/app",
      "token=github-canary",
    ];
    for (const invoke of [
      () => assertSafeProcessBoundary("psql", [secrets[0]!]),
      () =>
        assertSafeProcessBoundary("psql", [], {
          LANG: `${secrets[1]}.UTF-8`,
        }),
    ]) {
      let caught: unknown;
      try {
        invoke();
      } catch (error) {
        caught = error;
      }
      const output = `${String(caught)}${JSON.stringify(caught)}`;
      expect(output).toContain("release_rollout_process_boundary_rejected");
      for (const secret of secrets) expect(output).not.toContain(secret);
    }
  });

  it("allows only a path to the nested migration credential file", () => {
    expect(() =>
      assertSafeProcessBoundary("psql", [], {
        PATH: "/usr/local/bin:/usr/bin:/bin",
        REVIEW_ROUTER_DATABASE_URL_FILE:
          "/tmp/rr-db-credential-safe/database-url",
      }),
    ).not.toThrow();
    expect(() =>
      assertSafeProcessBoundary("psql", [], {
        REVIEW_ROUTER_DATABASE_URL_FILE:
          "postgresql://owner:secret@db.internal/review_router",
      }),
    ).toThrow("release_rollout_process_boundary_rejected");
  });

  it("bounds timeout diagnostics without exposing aborted process data", () => {
    let caught: unknown;
    try {
      new RedactedProcessCommandAdapter().execute(
        "node",
        [
          "-e",
          "process.stderr.write('timeout-secret-canary');setInterval(()=>{},1000)",
        ],
        {
          env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
          timeoutMs: 20,
        },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
    const output = `${String(caught)}${JSON.stringify(caught)}`;
    expect(output).toContain('"timedOut":true');
    expect(output).not.toContain("timeout-secret-canary");
    expect(output.length).toBeLessThan(1_536);
  });
});
