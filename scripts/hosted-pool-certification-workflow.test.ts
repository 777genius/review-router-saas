import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
const qualityJob = workflow
  .split(/^ {2}(?=[a-z][a-z0-9-]+:\n)/mu)
  .find((job) => job.startsWith("quality:\n"));

if (!qualityJob) throw new Error("hosted_certification_quality_job_missing");

const stepNames = [
  "Bind hosted certification input bytes",
  "Hosted pool security certification",
  "Hosted pool populated migration rehearsal",
  "Hosted pool PostgreSQL 17 E2E",
  "Seal SHA-bound hosted certification evidence",
  "Upload hosted certification evidence",
  "Enforce hosted certification gates",
] as const;

describe("hosted certification workflow contract", () => {
  it("captures clean input before every gate and seals only after every gate", () => {
    const positions = stepNames.map((name) => {
      const position = qualityJob.indexOf(`- name: ${name}`);
      expect(position, `${name} must exist`).toBeGreaterThanOrEqual(0);
      return position;
    });

    expect(positions).toEqual(
      [...positions].sort((left, right) => left - right),
    );
    expect(qualityJob).toContain(
      "REVIEW_ROUTER_HOSTED_CERTIFICATION_WORKSPACE_SNAPSHOT: ${{ runner.temp }}/hosted-certification-workspace.json",
    );
  });

  it("keeps logs and valid evidence outside the repository and uploads that exact source", () => {
    expect(qualityJob).not.toContain(".artifacts/hosted-certification");
    expect(qualityJob).toContain(
      "REVIEW_ROUTER_HOSTED_CERTIFICATION_OUTPUT: ${{ runner.temp }}/hosted-certification",
    );
    expect(qualityJob).toContain(
      "REVIEW_ROUTER_HOSTED_CERTIFICATION_DB_EXPORT: ${{ runner.temp }}/hosted-certification/logs/relay-effect-rows.jsonl",
    );
    expect(qualityJob).toContain(
      'mkdir -p "$REVIEW_ROUTER_HOSTED_CERTIFICATION_OUTPUT/logs"',
    );
    expect(qualityJob).toContain(
      '"$REVIEW_ROUTER_HOSTED_CERTIFICATION_OUTPUT/logs/verify.log"',
    );
    expect(qualityJob).toContain(
      '"$REVIEW_ROUTER_HOSTED_CERTIFICATION_OUTPUT/logs/migration.log"',
    );
    expect(qualityJob).toContain(
      '"$REVIEW_ROUTER_HOSTED_CERTIFICATION_OUTPUT/logs/postgres-e2e.log"',
    );
    expect(qualityJob).toContain(
      "name: hosted-security-certification-${{ github.sha }}",
    );
    expect(qualityJob).toContain(
      "path: ${{ runner.temp }}/hosted-certification/hosted-certification-evidence.json",
    );
  });
});
