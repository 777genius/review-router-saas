import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { reviewedActivationCatalogPromotionExpectation as exactExpectation } from "../domain/activation-catalog-policy-promotion-expectation";
import {
  assertActivationCatalogPolicyReviewEvidence,
  type ActivationCatalogPolicyReviewEvidenceBuffers,
} from "./activation-catalog-policy-review-evidence";

const root = new URL("../../../../../", import.meta.url);
const read = (path: string): Buffer => readFileSync(new URL(path, root));
const exactBuffers = (): ActivationCatalogPolicyReviewEvidenceBuffers => ({
  reviewArtifact: read(
    "docs/release-evidence/activation-catalog-policy-v29-schema-v5-independent-review.md",
  ),
  reviewerRuntime: read(
    "docs/release-evidence/activation-catalog-policy-v29-schema-v5-reviewer-runtime.json",
  ),
  supplementalRuntime: read(
    "docs/release-evidence/activation-catalog-policy-v29-schema-v5-security-reviewer-runtime.json",
  ),
});

const digest = (value: Buffer): string =>
  createHash("sha256").update(value).digest("hex");

const bindRawHashes = (
  buffers: ActivationCatalogPolicyReviewEvidenceBuffers,
) => ({
  ...exactExpectation,
  reviewArtifactBytes: buffers.reviewArtifact.byteLength,
  reviewArtifactSha256: digest(buffers.reviewArtifact),
  reviewerEvidenceBytes: buffers.reviewerRuntime.byteLength,
  reviewerEvidenceSha256: digest(buffers.reviewerRuntime),
  supplementalEvidenceBytes: buffers.supplementalRuntime.byteLength,
  supplementalEvidenceSha256: digest(buffers.supplementalRuntime),
});

const replaceAuthoritativeMarkdown = (
  transform: (markdown: string) => string,
): ActivationCatalogPolicyReviewEvidenceBuffers => {
  const buffers = exactBuffers();
  const runtime = JSON.parse(buffers.reviewerRuntime.toString("utf8"));
  const index = runtime.evidence.findIndex((entry: unknown) =>
    typeof entry === "string" ? entry.startsWith("output_summary:") : false,
  );
  const markdown = transform(
    runtime.evidence[index].slice("output_summary:".length),
  );
  runtime.evidence[index] = `output_summary:${markdown}`;
  return {
    ...buffers,
    reviewArtifact: Buffer.from(markdown, "utf8"),
    reviewerRuntime: Buffer.from(`${JSON.stringify(runtime, null, 2)}\n`),
  };
};

const replaceSupplementalMarkdown = (
  transform: (markdown: string) => string,
): ActivationCatalogPolicyReviewEvidenceBuffers => {
  const buffers = exactBuffers();
  const runtime = JSON.parse(buffers.supplementalRuntime.toString("utf8"));
  const index = runtime.evidence.findIndex((entry: unknown) =>
    typeof entry === "string" ? entry.startsWith("output_summary:") : false,
  );
  runtime.evidence[index] = `output_summary:${transform(
    runtime.evidence[index].slice("output_summary:".length),
  )}`;
  return {
    ...buffers,
    supplementalRuntime: Buffer.from(`${JSON.stringify(runtime, null, 2)}\n`),
  };
};

const mutateRuntime = (
  supplemental: boolean,
  mutate: (runtime: Record<string, any>) => void,
): ActivationCatalogPolicyReviewEvidenceBuffers => {
  const buffers = exactBuffers();
  const key = supplemental ? "supplementalRuntime" : "reviewerRuntime";
  const runtime = JSON.parse(buffers[key].toString("utf8"));
  mutate(runtime);
  return {
    ...buffers,
    [key]: Buffer.from(`${JSON.stringify(runtime, null, 2)}\n`),
  };
};

const assertSemanticRejection = (
  buffers: ActivationCatalogPolicyReviewEvidenceBuffers,
): void => {
  expect(() =>
    assertActivationCatalogPolicyReviewEvidence(
      buffers,
      bindRawHashes(buffers),
    ),
  ).toThrow();
};

describe("activation catalog schema-v5 review evidence contract v2", () => {
  it("accepts the exact authoritative and independently parsed supplemental evidence", () => {
    expect(() =>
      assertActivationCatalogPolicyReviewEvidence(
        exactBuffers(),
        exactExpectation,
      ),
    ).not.toThrow();
  });

  it("rejects every evidence contract version other than 2", () => {
    expect(() =>
      assertActivationCatalogPolicyReviewEvidence(exactBuffers(), {
        ...exactExpectation,
        evidenceContractVersion: 1 as 2,
      }),
    ).toThrow("activation_catalog_policy_evidence_contract_invalid");
  });

  it("rejects invalid UTF-8 even when raw size and digest expectations are rebound", () => {
    const buffers = exactBuffers();
    const invalid = Buffer.from(buffers.reviewArtifact);
    invalid[0] = 0xff;
    assertSemanticRejection({ ...buffers, reviewArtifact: invalid });
  });

  it.each([
    "reviewArtifact",
    "reviewerRuntime",
    "supplementalRuntime",
  ] as const)("rejects a one-byte mutation of %s", (key) => {
    const buffers = exactBuffers();
    const mutated = Buffer.from(buffers[key]);
    mutated[Math.floor(mutated.byteLength / 2)]! ^= 1;
    expect(() =>
      assertActivationCatalogPolicyReviewEvidence(
        { ...buffers, [key]: mutated },
        exactExpectation,
      ),
    ).toThrow();
  });

  it("rejects an appended Markdown newline", () => {
    const buffers = exactBuffers();
    expect(() =>
      assertActivationCatalogPolicyReviewEvidence(
        {
          ...buffers,
          reviewArtifact: Buffer.concat([
            buffers.reviewArtifact,
            Buffer.from("\n"),
          ]),
        },
        exactExpectation,
      ),
    ).toThrow();
  });

  it.each([
    ["baseline", exactExpectation.comparisonBaseline],
    ["capture base", exactExpectation.captureBaseCommit],
    ["review base", exactExpectation.captureBaseCommit],
    ["audited head", exactExpectation.auditedHead],
    ["audited tree", exactExpectation.auditedTree],
    ["workflow run", exactExpectation.captureRunId],
    ["run attempt", `\`${exactExpectation.captureRunAttempt}\``],
    ["job", exactExpectation.captureJobId],
    ["artifact ID", exactExpectation.captureArtifactId],
    ["artifact name", exactExpectation.captureArtifactName],
    ["reviewer run ID", exactExpectation.reviewerRunId],
    ["decision ID", exactExpectation.reviewDecisionId],
    ["reviewed timestamp", exactExpectation.reviewedAt],
    ["candidate path 1", exactExpectation.candidateEvidencePaths[0]],
    ["candidate path 2", exactExpectation.candidateEvidencePaths[1]],
    ["candidate bytes", "`2,651,682`"],
    ["candidate hash", exactExpectation.candidateSha256],
    ["source image", exactExpectation.sourcePg16Image],
    ["target image", exactExpectation.targetPg17Image],
    ["live digest", exactExpectation.liveCatalogDigest],
    ["preactivation digest", exactExpectation.preactivationCatalogPolicySha256],
    ["activated digest", exactExpectation.activatedCatalogPolicySha256],
    ["artifact digest", exactExpectation.artifactCanonicalSha256],
    ["projection source", exactExpectation.liveCatalogProjectionSourceSha256],
    ["normalization source", exactExpectation.normalizationSourceSha256],
  ])("rejects stale or mutated authoritative %s", (_name, identity) => {
    const buffers = replaceAuthoritativeMarkdown((markdown) =>
      markdown.replace(identity as string, `${identity as string}x`),
    );
    assertSemanticRejection(buffers);
  });

  it.each([
    ["run ID", (runtime: Record<string, any>) => (runtime.runId += "-stale")],
    ["task ID", (runtime: Record<string, any>) => (runtime.taskId += "-stale")],
    [
      "base commit",
      (runtime: Record<string, any>) =>
        (runtime.details.baseCommit = "0".repeat(40)),
    ],
    [
      "completion",
      (runtime: Record<string, any>) =>
        (runtime.updatedAt = "2026-08-30T14:27:45.120Z"),
    ],
    [
      "changed files",
      (runtime: Record<string, any>) => runtime.changedFiles.push("decoy"),
    ],
    [
      "blocker",
      (runtime: Record<string, any>) => runtime.blockers.push("blocked"),
    ],
    [
      "attempt",
      (runtime: Record<string, any>) =>
        (runtime.evidence[2] = "attempt_count:1"),
    ],
    [
      "duplicate output",
      (runtime: Record<string, any>) =>
        runtime.evidence.push(runtime.evidence[1]),
    ],
    [
      "extra output",
      (runtime: Record<string, any>) => runtime.evidence.push("other:decoy"),
    ],
  ])("rejects authoritative runtime %s drift", (_name, mutate) => {
    assertSemanticRejection(mutateRuntime(false, mutate));
  });

  it.each([
    ["blocker", "- BLOCKER: **0**", "- BLOCKER: **1**"],
    ["high", "- HIGH: **0**", "- HIGH: **1**"],
    ["medium", "- MEDIUM: **0**", "- MEDIUM: **1**"],
  ])("rejects a nonzero authoritative %s count", (_name, from, to) => {
    assertSemanticRejection(
      replaceAuthoritativeMarkdown((markdown) => markdown.replace(from, to)),
    );
  });

  it("rejects a duplicate Markdown identity row", () => {
    assertSemanticRejection(
      replaceAuthoritativeMarkdown((markdown) =>
        markdown.replace(
          `| Audited tree | \`${exactExpectation.auditedTree}\` |`,
          `| Audited tree | \`${exactExpectation.auditedTree}\` |\n| Audited tree | \`${exactExpectation.auditedTree}\` |`,
        ),
      ),
    );
  });

  it("rejects an extra security-relevant identity row", () => {
    assertSemanticRejection(
      replaceAuthoritativeMarkdown((markdown) =>
        markdown.replace(
          `| Artifact name | \`${exactExpectation.captureArtifactName}\` |`,
          `| Artifact name | \`${exactExpectation.captureArtifactName}\` |\n| Alternate artifact | \`decoy\` |`,
        ),
      ),
    );
  });

  it("does not accept a correct-looking identity decoy in another section", () => {
    assertSemanticRejection(
      replaceAuthoritativeMarkdown((markdown) =>
        markdown
          .replace(
            `| Audited tree | \`${exactExpectation.auditedTree}\` |`,
            `| Audited tree | \`${"0".repeat(40)}\` |`,
          )
          .replace(
            "## Verification boundary",
            `## Verification boundary\n\nAudited tree decoy: \`${exactExpectation.auditedTree}\``,
          ),
      ),
    );
  });

  it("rejects a missing supplemental review", () => {
    const buffers = { ...exactBuffers(), supplementalRuntime: Buffer.alloc(0) };
    expect(() =>
      assertActivationCatalogPolicyReviewEvidence(buffers, exactExpectation),
    ).toThrow();
  });

  it.each([
    ["run", (runtime: Record<string, any>) => (runtime.runId += "-stale")],
    ["task", (runtime: Record<string, any>) => (runtime.taskId += "-stale")],
    [
      "base",
      (runtime: Record<string, any>) =>
        (runtime.details.baseCommit = "0".repeat(40)),
    ],
    [
      "timestamp",
      (runtime: Record<string, any>) =>
        (runtime.updatedAt = "2026-08-30T14:37:21.636Z"),
    ],
    [
      "changed files",
      (runtime: Record<string, any>) => runtime.changedFiles.push("decoy"),
    ],
    [
      "blocker",
      (runtime: Record<string, any>) => runtime.blockers.push("blocked"),
    ],
    [
      "attempt",
      (runtime: Record<string, any>) =>
        (runtime.evidence[2] = "attempt_count:2"),
    ],
    [
      "extra record key",
      (runtime: Record<string, any>) => (runtime.extra = "decoy"),
    ],
    [
      "duplicate output",
      (runtime: Record<string, any>) =>
        runtime.evidence.push(runtime.evidence[1]),
    ],
  ])("rejects supplemental runtime %s drift", (_name, mutate) => {
    assertSemanticRejection(mutateRuntime(true, mutate));
  });

  it.each([
    [
      "verdict",
      "**Verdict: GO — review scope only.**  ",
      "**Verdict: NO-GO — review scope only.**  ",
    ],
    ["severity", "**BLOCKER: 0 · HIGH: 0**", "**BLOCKER: 0 · HIGH: 1**"],
    [
      "decision",
      exactExpectation.reviewDecisionId,
      `${exactExpectation.reviewDecisionId}-stale`,
    ],
    ["head", exactExpectation.auditedHead, "0".repeat(40)],
    ["tree", exactExpectation.auditedTree, "0".repeat(40)],
    ["baseline", exactExpectation.comparisonBaseline, "0".repeat(40)],
    ["capture run", exactExpectation.captureRunId, "33315824200"],
    [
      "candidate path",
      exactExpectation.candidateEvidencePaths[1],
      `${exactExpectation.candidateEvidencePaths[1]}-stale`,
    ],
    ["candidate bytes", "`2,651,682`", "`2,651,681`"],
    ["candidate", exactExpectation.candidateSha256, "0".repeat(64)],
    [
      "live digest",
      exactExpectation.liveCatalogDigest,
      `sha256:${"0".repeat(64)}`,
    ],
    [
      "preactivation digest",
      exactExpectation.preactivationCatalogPolicySha256,
      `sha256:${"0".repeat(64)}`,
    ],
    [
      "activated digest",
      exactExpectation.activatedCatalogPolicySha256,
      `sha256:${"0".repeat(64)}`,
    ],
    [
      "digest",
      exactExpectation.artifactCanonicalSha256,
      `sha256:${"0".repeat(64)}`,
    ],
    [
      "projection source",
      exactExpectation.liveCatalogProjectionSourceSha256,
      "0".repeat(64),
    ],
    ["source", exactExpectation.normalizationSourceSha256, "0".repeat(64)],
    [
      "source image",
      exactExpectation.sourcePg16Image,
      `${exactExpectation.sourcePg16Image}x`,
    ],
    [
      "target image",
      exactExpectation.targetPg17Image,
      `${exactExpectation.targetPg17Image}x`,
    ],
    [
      "generated source",
      exactExpectation.generatedArtifactSourceSha256,
      "0".repeat(64),
    ],
  ])("rejects supplemental %s drift", (_name, from, to) => {
    assertSemanticRejection(
      replaceSupplementalMarkdown((markdown) => markdown.replace(from, to)),
    );
  });

  it("rejects legacy v29 runtime replay", () => {
    const buffers = {
      ...exactBuffers(),
      reviewerRuntime: read(
        "docs/release-evidence/activation-catalog-policy-v29-reviewer-runtime.json",
      ),
    };
    assertSemanticRejection(buffers);
  });
});
