import { readFileSync } from "node:fs";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  runCodexRotatingRolloutVerifierCli,
  sha256Utf8,
  verifyCodexRotatingRollout,
} from "./verify-codex-rotating-rollout.mjs";

describe("Codex rotating rollout verifier", () => {
  it("accepts bridge, drain, exact migration, convergence, canary, and widening evidence", () => {
    const evidence = validEvidence();
    const result = verifyCodexRotatingRollout(evidence);
    expect(result).toMatchObject({ ok: true, failures: [] });
    expect(result.canonicalResult.endsWith("\n")).toBe(true);
    expect(result.resultSha256).toBe(
      evidence.compatibilityProbe.expectedResultSha256,
    );
    expect(result.resultSha256).not.toBe(
      evidence.compatibilityProbe.sourceFileSha256,
    );
  });

  it("runs the bounded verifier CLI against actual checked-in source digests", () => {
    const directory = mkdtempSync(join(tmpdir(), "rr-rollout-proof-"));
    const evidencePath = join(directory, "evidence.json");
    writeFileSync(evidencePath, JSON.stringify(validEvidence()));

    let stdout = "";
    let stderr = "";
    const status = runCodexRotatingRolloutVerifierCli([evidencePath], {
      stdout: { write: (value: string) => (stdout += value) },
      stderr: { write: (value: string) => (stderr += value) },
    });

    expect(status, stderr).toBe(0);
    expect(stdout).toMatch(/^PASS canonical-result-sha256=[a-f0-9]{64}\n$/u);
    expect(stderr).toBe("");
  });

  it("rejects OAuth as drain switch, a short drain, repeated migration, and digest substitution", () => {
    const evidence = validEvidence();
    evidence.issuance.drainSwitch = "main_oauth";
    evidence.migration.startedAt = "2026-08-09T00:15:59.999Z";
    evidence.migration.controlledRunCount = 2;
    evidence.compatibilityProbe.sourceFileSha256 = "e".repeat(64);
    evidence.compatibilityProbe.expectedResultSha256 = "f".repeat(64);
    expect(verifyCodexRotatingRollout(evidence).failures).toEqual(
      expect.arrayContaining([
        "setup-manifest issuance must be the drain switch",
        "migration started before the 16-minute drain completed",
        "migration must run exactly once",
        "trusted probe source-file digest mismatched",
        "canonical compatibility-probe result digest mismatched",
      ]),
    );
  });

  it("rejects incomplete convergence, a changed migration, and unstable probe result fields", () => {
    const evidence = validEvidence();
    evidence.applications.pop();
    evidence.migration.sourceFileSha256 = "9".repeat(64);
    evidence.compatibilityProbe.result.generatedAt = "2026-08-09T00:00:00.000Z";
    evidence.compatibilityProbe.expectedResultSha256 = sha256Utf8(
      canonicalJson(evidence.compatibilityProbe.result),
    );

    expect(verifyCodexRotatingRollout(evidence).failures).toEqual(
      expect.arrayContaining([
        "checked-in 000060 digest mismatched",
        "application convergence must cover api, web, and worker exactly once",
        "canonical compatibility result contains missing or unstable fields",
      ]),
    );
  });
});

function validEvidence(): any {
  const targetCommit = "a".repeat(40);
  const candidateImageDigest = `sha256:${"b".repeat(64)}`;
  const probeResult = {
    probePolicy: "codex-rotating-rollback",
    probeVersion: 1,
    cases: [
      { id: "legacy-manifest-reader-restart", conclusion: "pass" },
      { id: "v2-manifest-reader-restart", conclusion: "pass" },
    ],
    readerRestartCount: 2,
    candidateImageDigest,
    candidateSourceCommit: targetCommit,
  };
  return {
    version: 1,
    targetCommit,
    candidateImageDigest,
    bridge: {
      readerReady: true,
      compatibilityProbePassed: true,
      commit: "d".repeat(40),
      observedAt: "2026-08-08T23:59:00.000Z",
    },
    issuance: {
      quiesced: true,
      quiescedAt: "2026-08-09T00:00:00.000Z",
      drainSwitch: "setup_manifest_issuance",
      mainOAuthEnabledDuringDrain: true,
      confirmationLiveDuringDrain: true,
    },
    migration: {
      id: "000060_codex_oauth_setup_serialization",
      sourceFile:
        "packages/platform/db/prisma/migrations/000060_codex_oauth_setup_serialization/migration.sql",
      sourceFileSha256: checkedInSourceSha256(
        "packages/platform/db/prisma/migrations/000060_codex_oauth_setup_serialization/migration.sql",
      ),
      controlledRunCount: 1,
      startedAt: "2026-08-09T00:16:00.000Z",
      completedAt: "2026-08-09T00:16:10.000Z",
      succeeded: true,
    },
    applications: [
      {
        name: "web",
        commit: targetCommit,
        observedAt: "2026-08-09T00:17:00.000Z",
      },
      {
        name: "api",
        commit: targetCommit,
        observedAt: "2026-08-09T00:17:00.000Z",
      },
      {
        name: "worker",
        commit: targetCommit,
        observedAt: "2026-08-09T00:17:00.000Z",
      },
    ],
    canary: {
      disposable: true,
      passed: true,
      startedAt: "2026-08-09T00:17:30.000Z",
      completedAt: "2026-08-09T00:18:00.000Z",
      commit: targetCommit,
      imageDigest: candidateImageDigest,
    },
    widening: { approved: true, startedAt: "2026-08-09T00:19:00.000Z" },
    rollback: {
      applicationOnly: true,
      databaseRollbackProhibited: true,
      directPreConfirmationRollbackProhibited: true,
    },
    compatibilityProbe: {
      sourceFile:
        "apps/web/src/server/codex-rotating-dropped-response.real.test.ts",
      sourceFileSha256: checkedInSourceSha256(
        "apps/web/src/server/codex-rotating-dropped-response.real.test.ts",
      ),
      expectedResultSha256: sha256Utf8(canonicalJson(probeResult)),
      result: probeResult,
    },
  };
}

function checkedInSourceSha256(path: string): string {
  return sha256Utf8(readFileSync(join(process.cwd(), path), "utf8"));
}
