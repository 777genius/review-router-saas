import { describe, expect, it } from "vitest";
import {
  createSanitizedDiagnostic,
  sanitizedDiagnosticError,
} from "./sanitized-diagnostic.js";

describe("sanitized release diagnostics", () => {
  it("serializes only bounded allowlisted fields", () => {
    const canaries = [
      "stdout-canary",
      "stderr-canary",
      "argv-canary",
      "env-canary",
      "nested-cause-canary",
      "postgresql://owner:dsn-canary@db.invalid/app",
      "ghp_github-token-canary",
      "Bearer render-token-canary",
      "cookie=session-canary",
      '{"auth":"auth-json-canary"}',
    ];
    const diagnostic = createSanitizedDiagnostic({
      code: "release_rollout_process_failed",
      phase: "process_execute",
      exitCode: 19,
      signal: "SIGTERM",
      // Unknown properties model accidental adapter forwarding and are ignored.
      stdout: canaries[0],
      stderr: canaries[1],
      argv: canaries[2],
      env: canaries[3],
      cause: new Error(canaries.slice(4).join(" ")),
    });
    const serialized = JSON.stringify(diagnostic);
    expect(serialized.length).toBeLessThan(512);
    for (const canary of canaries) expect(serialized).not.toContain(canary);
    expect(diagnostic).toEqual({
      version: 1,
      code: "release_rollout_process_failed",
      phase: "process_execute",
      exit: { code: 19, signal: "SIGTERM" },
      metadata: {},
      operatorHint:
        "Inspect the named rollout phase and rerun after correcting the local dependency.",
    });
  });

  it("keeps Error strings and JSON secret-free without traversing causes", () => {
    const error = sanitizedDiagnosticError({
      code: "provider_http_request_failed",
      phase: "provider_request",
      timedOut: true,
      ambiguousWrite: true,
      message: "response-body-canary",
      headers: { authorization: "header-canary" },
      cause: new Error("nested-canary"),
    });
    const outputs = [String(error), JSON.stringify(error)];
    for (const output of outputs) {
      expect(output.length).toBeLessThan(768);
      expect(output).not.toMatch(
        /response-body-canary|header-canary|nested-canary/u,
      );
    }
  });
});
