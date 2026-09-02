import {
  execFileSync,
  spawnSync,
  type SpawnSyncReturns,
} from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import canonicalActivationCatalogPolicyArtifact from "../packages/features/release-rollout/src/domain/activation-catalog-policy-artifact.generated.js";
import {
  canonicalJson,
  sha256Canonical,
} from "../packages/features/release-rollout/src/domain/canonical-json";
import { canonicalReleaseMigrationPostManifestIdentity } from "../packages/features/release-rollout/src/domain/release-migration-artifact-identity.js";
import {
  activationCatalogRawPromotionOptIn,
  activationCatalogRawReviewArtifactRepositoryPath,
  activationCatalogRawReviewerRuntimeRepositoryPath,
  type ActivationCatalogRawPromotionTrustRootReady,
} from "../packages/features/release-rollout/src/domain/activation-catalog-policy-raw-promotion-trust-root";
import { activationCatalogCaptureSurface } from "./lib/activation-catalog-git-custody.mjs";

const sourceRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const tsxCli = join(sourceRoot, "node_modules/tsx/dist/cli.mjs");
const fixtureRoots: string[] = [];
const trustRootPath =
  "packages/features/release-rollout/src/domain/activation-catalog-policy-raw-promotion-trust-root.json";
const generatedPath =
  "packages/features/release-rollout/src/domain/activation-catalog-policy-artifact.generated.js";

function generatedPolicies(
  value: unknown,
): Readonly<{ preactivation: unknown; activated: unknown }> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("activation_catalog_generated_artifact_invalid");
  const policies = (value as Record<string, unknown>).policies;
  if (
    policies === null ||
    typeof policies !== "object" ||
    Array.isArray(policies) ||
    Object.keys(policies).sort().join(",") !== "activated,preactivation"
  )
    throw new Error("activation_catalog_generated_artifact_invalid");
  return policies as Readonly<{
    preactivation: unknown;
    activated: unknown;
  }>;
}

const canonicalActivationCatalogPolicies = generatedPolicies(
  canonicalActivationCatalogPolicyArtifact,
);

const sha256 = (value: Buffer | string): string =>
  createHash("sha256").update(value).digest("hex");

function rawReviewArtifactFixture(
  ready: ActivationCatalogRawPromotionTrustRootReady,
): string {
  const { evidence, independentReview } = ready;
  const captures = evidence.captures
    .map(
      (capture, index) =>
        `| ${index === 0 ? "selected" : "corroborating"} | \`${capture.label}\` | \`${capture.bytes}\` | \`${capture.sha256}\` |`,
    )
    .join("\n");
  return `# Raw activation catalog independent review

## Decision

- Verdict: **GO**
- BLOCKER: **0**
- HIGH: **0**
- Decision ID: \`${evidence.reviewDecisionId}\`
- Reviewed at: \`${independentReview.reviewedAt}\`

## Capture identities

- Base commit: \`${evidence.capture.baseCommit}\`
- Audited head: \`${evidence.capture.auditedHead}\`
- Audited tree: \`${evidence.capture.auditedTree}\`
- Workflow run: \`${evidence.capture.workflowRunId}\`
- Run attempt: \`${evidence.capture.runAttempt}\`
- Job: \`${evidence.capture.jobId}\`
- Artifact ID: \`${evidence.capture.artifactId}\`
- Artifact name: \`${evidence.capture.artifactName}\`

## Raw captures

| Selection | Label | Bytes | Raw SHA-256 |
| --- | --- | ---: | --- |
${captures}

Capture-set digest: \`${evidence.captureSetSha256}\`
Source PostgreSQL image: \`${evidence.postgresImages.sourcePg16}\`
Target PostgreSQL image: \`${evidence.postgresImages.targetPg17}\`
`;
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
  }).trim();
}

async function copyProductionCaptureSurface(root: string): Promise<void> {
  const inclusions = activationCatalogCaptureSurface.filter(
    (selector) => !selector.startsWith(":(exclude)"),
  );
  for (const repositoryPath of inclusions) {
    const destination = join(root, repositoryPath);
    await mkdir(dirname(destination), { recursive: true });
    await cp(join(sourceRoot, repositoryPath), destination, {
      recursive: true,
    });
  }
}

function runTsx(root: string, args: string[]): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [tsxCli, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
  });
}

function singletonProbe(root: string) {
  const moduleUrl = pathToFileURL(
    join(
      root,
      "packages/features/release-rollout/src/domain/activation-catalog-policy-raw-promotion-trust-root.ts",
    ),
  ).href;
  return runTsx(root, [
    "--eval",
    `import(${JSON.stringify(moduleUrl)}).then((m)=>process.stdout.write(JSON.stringify(m.activationCatalogRawPromotionTrustRoot)))`,
  ]);
}

function rawCapture({
  auditedHead,
  baseCommit,
  configuredIdentity,
  disposableIdentity,
  liveCatalogDigest,
  projectionSha256,
  recoveryWitnessSha256,
  systemIdentifier,
}: {
  auditedHead: string;
  baseCommit: string;
  configuredIdentity: string;
  disposableIdentity: string;
  liveCatalogDigest: string;
  projectionSha256: string;
  recoveryWitnessSha256: string;
  systemIdentifier: string;
}) {
  const database = {
    disposableIdentity,
    configuredIdentity,
    systemIdentifier,
    recoveryWitnessSha256,
  };
  const projection = {
    sha256: projectionSha256,
    observedDigest: liveCatalogDigest,
  };
  const evidenceMaterial = {
    auditedHead,
    captureBaseCommit: baseCommit,
    commitSha: auditedHead,
    database,
    policies: canonicalActivationCatalogPolicies,
    postManifestIdentity: canonicalReleaseMigrationPostManifestIdentity,
    projection,
  };
  return {
    kind: "reviewrouter-activation-catalog-policy-artifact-candidate",
    version: 2,
    policies: canonicalActivationCatalogPolicies,
    capture: {
      commitSha: auditedHead,
      postManifestIdentity: canonicalReleaseMigrationPostManifestIdentity,
      database,
      projection,
      custody: {
        captureBaseCommit: baseCommit,
        auditedHead,
        evidenceSha256: `sha256:${sha256Canonical(evidenceMaterial)}`,
      },
    },
  };
}

afterEach(async () => {
  for (const root of fixtureRoots.splice(0))
    await rm(root, { recursive: true, force: true });
});

describe("raw activation catalog READY production integration", () => {
  it("runs the real raw CLI write and verify graph from a reviewed descendant", async () => {
    const root = await mkdtemp(join(tmpdir(), "rr-activation-catalog-ready-"));
    fixtureRoots.push(root);
    git(root, "init", "-q");
    git(root, "config", "user.name", "ReviewRouter Integration");
    git(root, "config", "user.email", "reviewrouter@example.invalid");
    await writeFile(join(root, ".gitignore"), "node_modules\n");
    git(root, "add", ".gitignore");
    git(root, "commit", "-qm", "capture base");
    const baseCommit = git(root, "rev-parse", "HEAD");

    await copyProductionCaptureSurface(root);
    await writeFile(
      join(root, trustRootPath),
      `${JSON.stringify(
        {
          status: "pending",
          reason:
            "fresh-authenticated-raw-capture-and-independent-review-required",
        },
        null,
        2,
      )}\n`,
    );
    git(root, "add", ".");
    git(root, "commit", "-qm", "audited production capture surface");
    const auditedHead = git(root, "rev-parse", "HEAD");
    const auditedTree = git(root, "rev-parse", `${auditedHead}^{tree}`);

    const pendingProbe = singletonProbe(root);
    expect(pendingProbe.status, pendingProbe.stderr).toBe(0);
    expect(JSON.parse(pendingProbe.stdout)).toEqual({
      status: "pending",
      reason: "fresh-authenticated-raw-capture-and-independent-review-required",
    });

    await writeFile(
      join(root, trustRootPath),
      `${JSON.stringify(
        { status: "pending", reason: "wrong-reason" },
        null,
        2,
      )}\n`,
    );
    const malformedProbe = singletonProbe(root);
    expect(malformedProbe.status, malformedProbe.stderr).not.toBe(0);
    expect(malformedProbe.stderr).toContain(
      "activation_catalog_policy_raw_trust_root_invalid",
    );

    const generatedFixture = await readFile(join(sourceRoot, generatedPath));
    const canonicalArtifact = canonicalJson({
      kind: "reviewrouter-activation-catalog-policy-artifact",
      version: 1,
      policies: canonicalActivationCatalogPolicies,
    });
    const liveCatalogDigest = `sha256:${sha256(
      "synthetic-local-ready-live-catalog",
    )}`;
    const projectionSha256 = `sha256:${sha256(
      "synthetic-local-ready-projection",
    )}`;
    const recoveryWitnessSha256 = sha256(
      "synthetic-local-ready-recovery-witness",
    );
    const captures = [
      rawCapture({
        auditedHead,
        baseCommit,
        configuredIdentity: "fixture-configured-a",
        disposableIdentity: "fixture-disposable-a",
        liveCatalogDigest,
        projectionSha256,
        recoveryWitnessSha256,
        systemIdentifier: "1000000000000000001",
      }),
      rawCapture({
        auditedHead,
        baseCommit,
        configuredIdentity: "fixture-configured-b",
        disposableIdentity: "fixture-disposable-b",
        liveCatalogDigest,
        projectionSha256,
        recoveryWitnessSha256,
        systemIdentifier: "1000000000000000002",
      }),
    ];
    const capturePaths = [
      join(root, "fixtures/activation-catalog-policy-candidate-1.json"),
      join(root, "fixtures/activation-catalog-policy-candidate-2.json"),
    ];
    await mkdir(dirname(capturePaths[0]), { recursive: true });
    const captureBytes = captures.map((capture) =>
      Buffer.from(`${JSON.stringify(capture, null, 2)}\n`, "utf8"),
    );
    await Promise.all(
      capturePaths.map((path, index) => writeFile(path, captureBytes[index]!)),
    );

    const evidence = {
      kind: "reviewrouter-activation-catalog-raw-capture-evidence" as const,
      version: 1 as const,
      selectedCaptureId: "activation-catalog-policy-candidate-1.json",
      captureSetSha256: "",
      captures: [
        {
          label: "activation-catalog-policy-candidate-1.json",
          bytes: captureBytes[0]!.byteLength,
          sha256: sha256(captureBytes[0]!),
        },
        {
          label: "activation-catalog-policy-candidate-2.json",
          bytes: captureBytes[1]!.byteLength,
          sha256: sha256(captureBytes[1]!),
        },
      ] as const,
      capture: {
        baseCommit,
        auditedHead,
        auditedTree,
        workflowRunId: "1001",
        runAttempt: 1,
        jobId: "1002",
        artifactId: "1003",
        artifactName: "synthetic-local-activation-catalog-capture",
      },
      postgresImages: {
        sourcePg16: `postgres:16@sha256:${sha256("fixture-pg16")}`,
        targetPg17: `postgres:17@sha256:${sha256("fixture-pg17")}`,
      },
      reviewResult: "GO" as const,
      reviewDecisionId: "SYNTHETIC-LOCAL-READY-GO",
      projectionSha256,
      liveCatalogDigest,
      postManifestIdentity: canonicalReleaseMigrationPostManifestIdentity,
      recoveryWitnessSha256,
      canonicalDigests: {
        preactivation: `sha256:${sha256Canonical(
          canonicalActivationCatalogPolicies.preactivation,
        )}`,
        activated: `sha256:${sha256Canonical(
          canonicalActivationCatalogPolicies.activated,
        )}`,
        artifact: `sha256:${sha256(canonicalArtifact)}`,
      },
      generatedArtifactSource: {
        bytes: generatedFixture.byteLength,
        sha256: sha256(generatedFixture),
      },
    };
    const captureSetMaterial = Object.fromEntries(
      Object.entries(evidence).filter(
        ([key]) => !["kind", "version", "captureSetSha256"].includes(key),
      ),
    );
    evidence.captureSetSha256 = `sha256:${sha256Canonical(captureSetMaterial)}`;

    let readyRoot: ActivationCatalogRawPromotionTrustRootReady = {
      status: "ready",
      optIn: activationCatalogRawPromotionOptIn,
      evidence,
      independentReview: {
        contractVersion: 1,
        reviewArtifact: {
          repositoryPath: activationCatalogRawReviewArtifactRepositoryPath,
          bytes: 1,
          sha256: sha256("review-placeholder"),
        },
        reviewerRuntime: {
          repositoryPath: activationCatalogRawReviewerRuntimeRepositoryPath,
          bytes: 1,
          sha256: sha256("runtime-placeholder"),
        },
        reviewerRunId: "synthetic-local-independent-review",
        reviewerTaskId: "synthetic-local-independent-review",
        reviewedAt: "2026-08-31T10:00:00Z",
        completedAt: "2026-08-31T10:01:00Z",
      },
    };
    const reviewArtifact = Buffer.from(
      rawReviewArtifactFixture(readyRoot),
      "utf8",
    );
    const reviewerRuntime = Buffer.from(
      `${JSON.stringify(
        {
          status: "done",
          changedFiles: [],
          evidence: [
            "safe_execution_status:completed",
            `output_summary:${reviewArtifact.toString("utf8")}`,
            "attempt_count:1",
          ],
          blockers: [],
          nextAction: "review_completed",
          schemaVersion: 1,
          provider: "codex",
          runId: readyRoot.independentReview.reviewerRunId,
          taskId: readyRoot.independentReview.reviewerTaskId,
          details: { baseCommit },
          updatedAt: readyRoot.independentReview.completedAt,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    readyRoot = {
      ...readyRoot,
      independentReview: {
        ...readyRoot.independentReview,
        reviewArtifact: {
          repositoryPath: activationCatalogRawReviewArtifactRepositoryPath,
          bytes: reviewArtifact.byteLength,
          sha256: sha256(reviewArtifact),
        },
        reviewerRuntime: {
          repositoryPath: activationCatalogRawReviewerRuntimeRepositoryPath,
          bytes: reviewerRuntime.byteLength,
          sha256: sha256(reviewerRuntime),
        },
      },
    };

    await Promise.all([
      writeFile(
        join(root, trustRootPath),
        `${JSON.stringify(readyRoot, null, 2)}\n`,
      ),
      mkdir(
        dirname(join(root, activationCatalogRawReviewArtifactRepositoryPath)),
        { recursive: true },
      ).then(() =>
        writeFile(
          join(root, activationCatalogRawReviewArtifactRepositoryPath),
          reviewArtifact,
        ),
      ),
      mkdir(
        dirname(join(root, activationCatalogRawReviewerRuntimeRepositoryPath)),
        { recursive: true },
      ).then(() =>
        writeFile(
          join(root, activationCatalogRawReviewerRuntimeRepositoryPath),
          reviewerRuntime,
        ),
      ),
      writeFile(join(root, generatedPath), "stale generated fixture\n"),
    ]);
    git(root, "add", ".");
    git(root, "commit", "-qm", "bind synthetic local review evidence");
    await symlink(join(sourceRoot, "node_modules"), join(root, "node_modules"));

    const cliArgs = [
      "scripts/promote-private-pg17-activation-catalog-policy.mjs",
      "--capture-1",
      capturePaths[0]!,
      "--capture-2",
      capturePaths[1]!,
      "--raw-opt-in",
      activationCatalogRawPromotionOptIn,
    ];
    const promoted = runTsx(root, [...cliArgs, "--write"]);
    expect(promoted.status, promoted.stderr).toBe(0);
    const promotedResult = JSON.parse(promoted.stdout);
    expect(promotedResult).toMatchObject({
      artifactSourceSha256: sha256(generatedFixture),
      candidateSha256: evidence.captures[0].sha256,
      liveCatalogDigest,
      mode: "promoted",
      provenance: "raw-v1",
    });
    expect(
      (await readFile(join(root, generatedPath))).equals(generatedFixture),
    ).toBe(true);

    const verified = runTsx(root, cliArgs);
    expect(verified.status, verified.stderr).toBe(0);
    expect(JSON.parse(verified.stdout)).toMatchObject({
      artifactSourceSha256: sha256(generatedFixture),
      candidateSha256: evidence.captures[0].sha256,
      liveCatalogDigest,
      mode: "verified",
      provenance: "raw-v1",
    });

    const runtimeContractUrl = pathToFileURL(
      join(
        root,
        "packages/features/release-rollout/src/domain/activation-catalog-policy-contract.ts",
      ),
    ).href;
    const runtimeProbe = runTsx(root, [
      "--eval",
      `import(${JSON.stringify(runtimeContractUrl)}).then((m)=>process.stdout.write(JSON.stringify({readiness:m.canonicalActivationCatalogPolicyTrustRootReadiness,digests:m.reviewedActivationCatalogPolicyDigests,authorized:m.authorizeCanonicalActivationCatalogPolicies(m.reviewedActivationCatalogPolicyDigests)===m.canonicalActivationCatalogPolicies})))`,
    ]);
    expect(runtimeProbe.status, runtimeProbe.stderr).toBe(0);
    expect(JSON.parse(runtimeProbe.stdout)).toEqual({
      readiness: { status: "ready", reason: "reviewed-raw" },
      digests: {
        preactivationCatalogPolicySha256:
          readyRoot.evidence.canonicalDigests.preactivation,
        activatedCatalogPolicySha256:
          readyRoot.evidence.canonicalDigests.activated,
      },
      authorized: true,
    });

    const reboundEvidence = {
      ...readyRoot.evidence,
      canonicalDigests: {
        preactivation: `sha256:${"1".repeat(64)}`,
        activated: `sha256:${"2".repeat(64)}`,
        artifact: `sha256:${"3".repeat(64)}`,
      },
    };
    reboundEvidence.captureSetSha256 = `sha256:${sha256Canonical(
      Object.fromEntries(
        Object.entries(reboundEvidence).filter(
          ([key]) => !["kind", "version", "captureSetSha256"].includes(key),
        ),
      ),
    )}`;
    await writeFile(
      join(root, trustRootPath),
      `${JSON.stringify(
        { ...readyRoot, evidence: reboundEvidence },
        null,
        2,
      )}\n`,
    );
    const reboundProbe = runTsx(root, [
      "--eval",
      `import(${JSON.stringify(runtimeContractUrl)})`,
    ]);
    expect(reboundProbe.status, reboundProbe.stderr).not.toBe(0);
    expect(reboundProbe.stderr).toContain(
      "activation_catalog_policy_reviewed_digest_drift",
    );

    const transitionUrl = pathToFileURL(
      join(
        root,
        "packages/features/release-rollout/src/domain/release-migration-transition.ts",
      ),
    ).href;
    const transitionProbe = runTsx(root, [
      "--eval",
      `import(${JSON.stringify(transitionUrl)}).then((m)=>process.stdout.write(JSON.stringify(m.createReleaseMigrationTransition({commitSha:${JSON.stringify(auditedHead)},releaseImageDigest:${JSON.stringify(`sha256:${sha256("fixture-release-image")}`)}}))))`,
    ]);
    expect(transitionProbe.status, transitionProbe.stderr).toBe(0);
    expect(JSON.parse(transitionProbe.stdout).postCatalogDigest).toBe(
      readyRoot.evidence.liveCatalogDigest,
    );

    const legacy = runTsx(root, [
      "scripts/promote-private-pg17-activation-catalog-policy.mjs",
      "--candidate",
      capturePaths[0]!,
    ]);
    expect(legacy.status, legacy.stderr).not.toBe(0);
    expect(legacy.stderr).toContain(
      "activation_catalog_policy_legacy_promotion_superseded",
    );
  }, 120_000);
});
