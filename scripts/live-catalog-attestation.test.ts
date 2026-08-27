import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import {
  assertSourceWorkflowPg17Image,
  candidateToObservedDigest,
  extractConfiguredCatalogDigest,
  extractProjectionBytes,
  LIVE_CATALOG_PG17_IMAGE,
  sha256Hex,
} from "./lib/live-catalog-attestation-domain.mjs";

const fixture = JSON.parse(
  readFileSync(
    "scripts/fixtures/live-catalog-attestation/historical-v29.json",
    "utf8",
  ),
);

describe("historical non-authoritative live catalog rejection fixture", () => {
  it("records the historical non-main source and mismatched API job name", () => {
    expect(fixture.sourceBranch).not.toBe("main");
    expect(fixture.pg17JobName).toBe("Full private PG16 to PG17 rehearsal");
    expect(fixture.pg17JobName).not.toBe(
      "Dedicated Release Authority PG17 contract",
    );
  });

  it("retains supplied bytes only as deterministic rejection evidence", () => {
    const historicalFailureLine = Buffer.from(fixture.observationLine);
    expect(historicalFailureLine).toHaveLength(265);
    expect(sha256Hex(historicalFailureLine)).toBe(
      fixture.observationLineSha256,
    );
    expect(fixture.runId).toBe("33020660492");
    expect(fixture.runAttempt).toBe(1);
    expect(fixture.qualityJobId).toBe("98349971837");
    expect(fixture.pg17JobId).toBe("98349971721");
    expect(fixture.artifactId).toBe("9626432342");
    expect(fixture.archiveSha256).toBe(
      "9e88f3da90218591477f8b8fd2a7dacdb52f120597c67406ea63090453818244",
    );
    expect(fixture.candidateSize).toBe(2627574);
    expect(fixture.candidateSha256).toBe(
      "bd6aba2349266bb8165c64d309ba537c0d63846c58c425b040ed408f857ebe62",
    );
    expect(fixture.qualityLogSha256).toBe(
      "dd75255a145d455e4a9388bf88b542338889518e9d723832337ef0b37b79bd1a",
    );
    expect(fixture.qualityLogSize).toBe(415725);
    expect(fixture.pg17Image).toBe(LIVE_CATALOG_PG17_IMAGE);
    expect(fixture.projectionExport).toBe("fencedLiveV70V73CatalogDigestSql");
    expect(fixture.configuredCatalogDigestExport).toBe(
      "liveV70V73CatalogDigestSha256",
    );
    expect(
      candidateToObservedDigest(
        [1, 2].map((number) => ({
          name: `activation-catalog-policy-candidate-${number}.json`,
          size: fixture.candidateSize,
          sha256: fixture.candidateSha256,
        })),
        fixture.observedCatalogDigest,
      ),
    ).toBe(fixture.candidateToObservedDigest);
  });

  it("recomputes immutable source facts and rejects its computed projection export", () => {
    const show = (path: string) =>
      execFileSync("/usr/bin/git", ["show", `${fixture.sourceCommit}:${path}`]);
    const workflow = show(".github/workflows/ci.yml");
    const projectionSource = show(
      "packages/features/release-rollout/src/adapters/live-v70-v72-catalog-digest.mjs",
    );
    expect(sha256Hex(workflow)).toBe(fixture.workflowSha256);
    expect(() => extractProjectionBytes(projectionSource)).toThrow(
      "live_catalog_projection_export_not_static_template",
    );
    expect(extractConfiguredCatalogDigest(projectionSource)).toBe(
      fixture.configuredCatalogDigest,
    );
    expect(
      execFileSync(
        "/usr/bin/git",
        ["show", "-s", "--format=%T", fixture.sourceCommit],
        {
          encoding: "utf8",
        },
      ).trim(),
    ).toBe(fixture.sourceTree);
  });
});

describe("live catalog attestor workflow", () => {
  const raw = readFileSync(
    ".github/workflows/attest-live-catalog-digest.yml",
    "utf8",
  );
  const workflow = parse(raw);
  const job = workflow.jobs.attest;

  it("is manual, non-deploying, protected-main attempt-one, and production-release reviewed", () => {
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
    expect(job["runs-on"]).toBe("ubuntu-24.04");
    expect(job.environment).toBe("production-release");
    expect(workflow.permissions).toEqual({
      actions: "read",
      contents: "read",
      "id-token": "write",
      attestations: "write",
    });
    expect(raw).toContain('test "$RUN_ATTEMPT" = 1');
    expect(raw).toContain('test "$SOURCE_REF" = refs/heads/main');
    expect(raw).not.toMatch(
      /deploy|migration|render|release-migration-transition/iu,
    );
  });

  it("pins every action and the required provenance action exactly", () => {
    const uses = job.steps.flatMap((step: { uses?: string }) =>
      step.uses ? [step.uses] : [],
    );
    expect(uses.length).toBeGreaterThan(0);
    expect(uses.every((value: string) => /@[a-f0-9]{40}$/u.test(value))).toBe(
      true,
    );
    expect(uses).toContain(
      "actions/attest-build-provenance@e8998f949152b193b063cb0ec769d69d929409be",
    );
  });

  it("installs the pinned lockfile before executing TypeScript-backed semantic parsers", () => {
    const enable = job.steps.find(
      (step: { name?: string }) => step.name === "Enable pinned pnpm",
    );
    const install = job.steps.find(
      (step: { name?: string }) =>
        step.name === "Install frozen attestor dependencies",
    );
    const assemble = job.steps.find(
      (step: { name?: string }) =>
        step.name === "Assemble authenticated canonical claim",
    );
    const proveNormalizer = job.steps.find(
      (step: { name?: string }) =>
        step.name === "Prove the canonical TypeScript normalizer is executable",
    );
    expect(install?.run).toBe(
      "pnpm install --filter review-router --frozen-lockfile --ignore-scripts --prod=false",
    );
    expect(install?.run).not.toContain("--no-optional");
    expect(proveNormalizer?.run).toBe(
      "node --import tsx --input-type=module --eval 'await import(\"./packages/features/release-rollout/src/domain/activation-catalog-policy-normalization.ts\")'",
    );
    expect(enable?.run).toBe("corepack enable pnpm");
    const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
    expect(packageJson.packageManager).toBe("pnpm@10.33.0");
    for (const dependencyKind of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
    ])
      expect(
        packageJson[dependencyKind]?.["@esbuild/linux-x64"],
      ).toBeUndefined();
    const lockfile = parse(readFileSync("pnpm-lock.yaml", "utf8"));
    expect(lockfile.importers["."].devDependencies).toMatchObject({
      tsx: { version: "4.23.1" },
      typescript: { version: "6.0.3" },
      yaml: { version: "2.9.0" },
    });
    expect(
      lockfile.snapshots["esbuild@0.28.1"].optionalDependencies,
    ).toHaveProperty("@esbuild/linux-x64", "0.28.1");
    expect(raw.indexOf("Enable pinned pnpm")).toBeLessThan(
      raw.indexOf("Install frozen attestor dependencies"),
    );
    expect(assemble?.run).toBe(
      "node --import tsx scripts/attest-live-catalog-digest.mjs assemble",
    );
    expect(raw.indexOf("Install frozen attestor dependencies")).toBeLessThan(
      raw.indexOf("Prove the canonical TypeScript normalizer is executable"),
    );
    expect(
      raw.indexOf("Prove the canonical TypeScript normalizer is executable"),
    ).toBeLessThan(raw.indexOf("Assemble authenticated canonical claim"));
  });

  it("semantically parses the checked-in source workflow and literal projection exports", () => {
    const sourceWorkflow = readFileSync(
      ".github/workflows/capture-live-catalog.yml",
    );
    const projection = readFileSync(
      "packages/features/release-rollout/src/adapters/live-v70-v72-catalog-digest.mjs",
    );
    expect(() => assertSourceWorkflowPg17Image(sourceWorkflow)).not.toThrow();
    expect(extractProjectionBytes(projection).length).toBeGreaterThan(1_000);
    expect(extractConfiguredCatalogDigest(projection)).toMatch(
      /^sha256:[a-f0-9]{64}$/u,
    );
  });
});
