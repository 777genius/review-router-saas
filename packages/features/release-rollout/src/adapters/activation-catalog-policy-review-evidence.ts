import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import { type ActivationCatalogPolicyPromotionExpectation } from "../domain/activation-catalog-policy-provenance-contract";
import { type ActivationCatalogRawPromotionTrustRootReady } from "../domain/activation-catalog-policy-raw-promotion-trust-root";

export type ActivationCatalogPolicyReviewEvidenceBuffers = Readonly<{
  reviewArtifact: Buffer;
  reviewerRuntime: Buffer;
  supplementalRuntime: Buffer;
}>;

export type ActivationCatalogRawReviewEvidenceBuffers = Readonly<{
  reviewArtifact: Buffer;
  reviewerRuntime: Buffer;
}>;

const exactRecord = (
  value: unknown,
  fields: readonly string[],
): value is Record<string, unknown> =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).length === fields.length &&
  fields.every((field) => Object.hasOwn(value, field));

const sha256 = (value: Buffer | string): string =>
  createHash("sha256").update(value).digest("hex");

const strictUtf8 = (value: Buffer, errorCode: string): string => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    throw new Error(errorCode);
  }
};

const exactRawFile = (
  value: Buffer,
  bytes: number,
  digest: string,
  errorCode: string,
): string => {
  if (
    !Buffer.isBuffer(value) ||
    value.byteLength !== bytes ||
    sha256(value) !== digest
  )
    throw new Error(errorCode);
  return strictUtf8(value, errorCode);
};

const parseJson = (text: string, errorCode: string): unknown => {
  try {
    const value: unknown = JSON.parse(text);
    if (`${JSON.stringify(value, null, 2)}\n` !== text)
      throw new Error(errorCode);
    return value;
  } catch {
    throw new Error(errorCode);
  }
};

const exactSection = (markdown: string, heading: string): string => {
  const marker = `## ${heading}`;
  const matches = [...markdown.matchAll(/^## .+$/gmu)].filter(
    (match) => match[0] === marker,
  );
  if (matches.length !== 1)
    throw new Error("activation_catalog_policy_review_markdown_invalid");
  const start = (matches[0]?.index ?? -1) + marker.length;
  const tail = markdown.slice(start);
  const nextHeading = tail.search(/^## .+$/mu);
  return nextHeading === -1 ? tail : tail.slice(0, nextHeading);
};

const exactKeyedLines = (
  section: string,
  pattern: RegExp,
  expected: Readonly<Record<string, string>>,
): void => {
  const entries = [...section.matchAll(pattern)].map((match) => [
    match[1],
    match[2],
  ]);
  if (
    entries.length !== Object.keys(expected).length ||
    entries.some(
      ([key, value]) =>
        typeof key !== "string" ||
        expected[key] === undefined ||
        expected[key] !== value,
    ) ||
    new Set(entries.map(([key]) => key)).size !== entries.length
  )
    throw new Error("activation_catalog_policy_review_markdown_invalid");
};

const tableRows = (section: string): readonly (readonly string[])[] =>
  section
    .split("\n")
    .filter((line) => /^\|.+\|$/u.test(line))
    .map((line) =>
      line
        .slice(1, -1)
        .split("|")
        .map((cell) => cell.trim()),
    )
    .filter((cells) => !cells.every((cell) => /^:?-+:?$/u.test(cell)));

const exactTable = (
  section: string,
  header: readonly string[],
  rows: readonly (readonly string[])[],
): void => {
  const actual = tableRows(section);
  if (JSON.stringify(actual) !== JSON.stringify([header, ...rows]))
    throw new Error("activation_catalog_policy_review_markdown_invalid");
};

const assertAuthoritativeMarkdown = (
  markdown: string,
  expected: ActivationCatalogPolicyPromotionExpectation,
): void => {
  if (!markdown.startsWith("# Schema-v5 exact provenance review artifact\n"))
    throw new Error("activation_catalog_policy_review_markdown_invalid");

  exactKeyedLines(
    exactSection(markdown, "Decision"),
    /^- ([A-Za-z][A-Za-z ]+): (.+)$/gmu,
    {
      Verdict: "**GO**",
      BLOCKER: "**0**",
      HIGH: "**0**",
      MEDIUM: "**0**",
      "Reviewer run ID": `\`${expected.reviewerRunId}\``,
      "Decision ID": `\`${expected.reviewDecisionId}\``,
      "Reviewed at": `\`${expected.reviewedAt}\``,
    },
  );

  exactTable(
    exactSection(markdown, "Exact identities"),
    ["Identity", "Exact value"],
    [
      ["Merge/current-main baseline", `\`${expected.comparisonBaseline}\``],
      [
        "`captureBaseCommit` for this capture",
        `\`${expected.captureBaseCommit}\``,
      ],
      ["`independentReview.baseCommit`", `\`${expected.captureBaseCommit}\``],
      ["`auditedHead`", `\`${expected.auditedHead}\``],
      ["Audited tree", `\`${expected.auditedTree}\``],
      ["Workflow run", `\`${expected.captureRunId}\``],
      ["Run attempt", `\`${expected.captureRunAttempt}\``],
      ["Job", `\`${expected.captureJobId}\``],
      ["Artifact ID", `\`${expected.captureArtifactId}\``],
      ["Artifact name", `\`${expected.captureArtifactName}\``],
    ],
  );

  exactTable(
    exactSection(markdown, "Candidate bytes"),
    ["Candidate", "Bytes", "Raw SHA-256"],
    expected.candidateEvidencePaths.map((path, index) => [
      `[candidate ${index + 1}](${path}:1)`,
      `\`${expected.candidateBytes.toLocaleString("en-US")}\``,
      `\`${expected.candidateSha256}\``,
    ]),
  );

  const pinned = exactSection(
    markdown,
    "Pinned images, source hashes, and canonical digests",
  );
  exactKeyedLines(pinned, /^- ([^:\n]+): `([^`]+)`$/gmu, {
    "PostgreSQL 16 source": expected.sourcePg16Image,
    "PostgreSQL 17 target": expected.targetPg17Image,
    "Live catalog projection source SHA-256":
      expected.liveCatalogProjectionSourceSha256,
    "Normalization source SHA-256": expected.normalizationSourceSha256,
  });
  exactTable(
    pinned,
    ["Canonical value", "Digest"],
    [
      [
        "Live catalog / release transition",
        `\`${expected.liveCatalogDigest}\``,
      ],
      [
        "Preactivation policy",
        `\`${expected.preactivationCatalogPolicySha256}\``,
      ],
      ["Activated policy", `\`${expected.activatedCatalogPolicySha256}\``],
      ["Promotable artifact", `\`${expected.artifactCanonicalSha256}\``],
    ],
  );
};

const exactOnce = (text: string, line: string): void => {
  const count = text
    .split("\n")
    .filter((candidate) => candidate === line).length;
  if (count !== 1)
    throw new Error("activation_catalog_policy_supplemental_review_invalid");
};

const assertSupplementalMarkdown = (
  markdown: string,
  expected: ActivationCatalogPolicyPromotionExpectation,
): void => {
  if (!markdown.startsWith("# Exact-byte security review\n"))
    throw new Error("activation_catalog_policy_supplemental_review_invalid");
  const firstSection = markdown.search(/^## .+$/mu);
  const preamble = markdown.slice(0, firstSection);
  const identities = exactSection(markdown, "Identities");
  const digests = exactSection(markdown, "Independently verified digests");
  const generated = exactSection(
    markdown,
    "Candidate versus promoted artifact",
  );
  for (const line of [
    "**Verdict: GO — review scope only.**  ",
    "**BLOCKER: 0 · HIGH: 0**",
    `Decision ID: \`${expected.reviewDecisionId}\``,
  ])
    exactOnce(preamble, line);
  for (const line of [
    `- HEAD: \`${expected.auditedHead}\``,
    `- Tree: \`${expected.auditedTree}\``,
    `- Baseline/merge-base: \`${expected.comparisonBaseline}\``,
    `Both [Candidate A](<${expected.candidateEvidencePaths[0]}>) and [Candidate B](<${expected.candidateEvidencePaths[1]}>):`,
    `- are exactly \`${expected.candidateBytes.toLocaleString("en-US")}\` bytes;`,
    `- hash to \`${expected.candidateSha256}\`;`,
    `The supplied capture locator is run \`${expected.captureRunId}\`, attempt \`${expected.captureRunAttempt}\`, job \`${expected.captureJobId}\`, artifact \`${expected.captureArtifactId}\`. No GitHub call was made. The checked-in workflow independently confirms the expected artifact-name construction, two disposable captures, byte comparison, and exact image pins at [ci.yml](</mnt/volume_ams3_1784742570542/worktrees/rr-pr245-r252-schema-v5-security-review/.github/workflows/ci.yml:136>).`,
  ])
    exactOnce(identities, line);
  for (const line of [
    `- live projection source: \`${expected.liveCatalogProjectionSourceSha256}\``,
    `- normalization source: \`${expected.normalizationSourceSha256}\``,
    `- \`${expected.sourcePg16Image}\``,
    `- \`${expected.targetPg17Image}\``,
  ])
    exactOnce(digests, line);
  exactOnce(
    generated,
    `The complete candidate policy pair is deeply equal to the currently generated [activation-catalog-policy-artifact.generated.js](</mnt/volume_ams3_1784742570542/worktrees/rr-pr245-r252-schema-v5-security-review/packages/features/release-rollout/src/domain/activation-catalog-policy-artifact.generated.js:3>). Reconstructing the generated module from candidate bytes produced exact source equality and source SHA-256 \`${expected.generatedArtifactSourceSha256}\`.`,
  );

  exactTable(
    digests,
    ["Material", "SHA-256"],
    [
      ["Raw candidate", `\`${expected.candidateSha256}\``],
      [
        "Preactivation canonical policy",
        `\`${expected.preactivationCatalogPolicySha256}\``,
      ],
      [
        "Activated canonical policy",
        `\`${expected.activatedCatalogPolicySha256}\``,
      ],
      [
        "Canonical promoted artifact",
        `\`${expected.artifactCanonicalSha256}\``,
      ],
      [
        "Live catalog / transition binding",
        `\`${expected.liveCatalogDigest}\``,
      ],
    ],
  );
};

const assertRuntime = (
  value: unknown,
  expected: ActivationCatalogPolicyPromotionExpectation,
  supplemental: boolean,
): string => {
  if (
    !exactRecord(value, [
      "status",
      "changedFiles",
      "evidence",
      "blockers",
      "nextAction",
      "schemaVersion",
      "provider",
      "runId",
      "taskId",
      "details",
      "updatedAt",
    ]) ||
    value.status !== "done" ||
    value.provider !== "codex" ||
    value.schemaVersion !== 1 ||
    value.nextAction !== "review_completed" ||
    value.runId !==
      (supplemental
        ? expected.supplementalReviewerRunId
        : expected.reviewerRunId) ||
    value.taskId !==
      (supplemental
        ? expected.supplementalReviewerTaskId
        : expected.reviewerTaskId) ||
    value.updatedAt !==
      (supplemental
        ? expected.supplementalCompletedAt
        : expected.reviewerCompletedAt) ||
    !exactRecord(value.details, ["baseCommit"]) ||
    value.details.baseCommit !== expected.captureBaseCommit ||
    !Array.isArray(value.blockers) ||
    value.blockers.length !== 0 ||
    !Array.isArray(value.changedFiles) ||
    value.changedFiles.length !== 0 ||
    !Array.isArray(value.evidence) ||
    value.evidence.length !== 3 ||
    value.evidence[0] !== "safe_execution_status:completed" ||
    typeof value.evidence[1] !== "string" ||
    !value.evidence[1].startsWith("output_summary:") ||
    value.evidence[2] !== `attempt_count:${supplemental ? 1 : 2}`
  )
    throw new Error(
      supplemental
        ? "activation_catalog_policy_supplemental_runtime_evidence_invalid"
        : "activation_catalog_policy_reviewer_runtime_evidence_invalid",
    );
  return value.evidence[1].slice("output_summary:".length);
};

const assertLegacyActivationCatalogPolicyReviewEvidence = (
  buffers: ActivationCatalogPolicyReviewEvidenceBuffers,
  expected: ActivationCatalogPolicyPromotionExpectation,
): void => {
  if (expected.evidenceContractVersion !== 2)
    throw new Error("activation_catalog_policy_evidence_contract_invalid");

  const markdown = exactRawFile(
    buffers.reviewArtifact,
    expected.reviewArtifactBytes,
    expected.reviewArtifactSha256,
    "activation_catalog_policy_independent_review_artifact_invalid",
  );
  const reviewerText = exactRawFile(
    buffers.reviewerRuntime,
    expected.reviewerEvidenceBytes,
    expected.reviewerEvidenceSha256,
    "activation_catalog_policy_reviewer_runtime_evidence_invalid",
  );
  const supplementalText = exactRawFile(
    buffers.supplementalRuntime,
    expected.supplementalEvidenceBytes,
    expected.supplementalEvidenceSha256,
    "activation_catalog_policy_supplemental_runtime_evidence_invalid",
  );
  const authoritativeSummary = assertRuntime(
    parseJson(
      reviewerText,
      "activation_catalog_policy_reviewer_runtime_evidence_invalid",
    ),
    expected,
    false,
  );
  const supplementalSummary = assertRuntime(
    parseJson(
      supplementalText,
      "activation_catalog_policy_supplemental_runtime_evidence_invalid",
    ),
    expected,
    true,
  );
  if (!Buffer.from(authoritativeSummary, "utf8").equals(buffers.reviewArtifact))
    throw new Error(
      "activation_catalog_policy_review_materialization_mismatch",
    );
  assertAuthoritativeMarkdown(markdown, expected);
  assertSupplementalMarkdown(supplementalSummary, expected);
};

export function activationCatalogRawReviewArtifact(
  expected: ActivationCatalogRawPromotionTrustRootReady,
): string {
  const evidence = expected.evidence;
  const review = expected.independentReview;
  return [
    "# Raw activation catalog independent review",
    "",
    "## Decision",
    "",
    "- Verdict: **GO**",
    "- BLOCKER: **0**",
    "- HIGH: **0**",
    `- Decision ID: \`${evidence.reviewDecisionId}\``,
    `- Reviewed at: \`${review.reviewedAt}\``,
    "",
    "## Capture identities",
    "",
    `- Base commit: \`${evidence.capture.baseCommit}\``,
    `- Audited head: \`${evidence.capture.auditedHead}\``,
    `- Audited tree: \`${evidence.capture.auditedTree}\``,
    `- Workflow run: \`${evidence.capture.workflowRunId}\``,
    `- Run attempt: \`${evidence.capture.runAttempt}\``,
    `- Job: \`${evidence.capture.jobId}\``,
    `- Artifact ID: \`${evidence.capture.artifactId}\``,
    `- Artifact name: \`${evidence.capture.artifactName}\``,
    "",
    "## Raw captures",
    "",
    "| Selection | Label | Bytes | Raw SHA-256 |",
    "| --- | --- | ---: | --- |",
    ...evidence.captures.map((capture, index) =>
      [
        index === 0 ? "selected" : "corroborating",
        `\`${capture.label}\``,
        `\`${capture.bytes}\``,
        `\`${capture.sha256}\``,
      ]
        .join(" | ")
        .replace(/^/u, "| ")
        .replace(/$/u, " |"),
    ),
    "",
    `Capture-set digest: \`${evidence.captureSetSha256}\``,
    `Source PostgreSQL image: \`${evidence.postgresImages.sourcePg16}\``,
    `Target PostgreSQL image: \`${evidence.postgresImages.targetPg17}\``,
    "",
  ].join("\n");
}

const assertRawRuntime = (
  value: unknown,
  expected: ActivationCatalogRawPromotionTrustRootReady,
): string => {
  const review = expected.independentReview;
  if (
    !exactRecord(value, [
      "status",
      "changedFiles",
      "evidence",
      "blockers",
      "nextAction",
      "schemaVersion",
      "provider",
      "runId",
      "taskId",
      "details",
      "updatedAt",
    ]) ||
    value.status !== "done" ||
    value.provider !== "codex" ||
    value.schemaVersion !== 1 ||
    value.nextAction !== "review_completed" ||
    value.runId !== review.reviewerRunId ||
    value.taskId !== review.reviewerTaskId ||
    value.updatedAt !== review.completedAt ||
    !exactRecord(value.details, ["baseCommit"]) ||
    value.details.baseCommit !== expected.evidence.capture.baseCommit ||
    !Array.isArray(value.blockers) ||
    value.blockers.length !== 0 ||
    !Array.isArray(value.changedFiles) ||
    value.changedFiles.length !== 0 ||
    !Array.isArray(value.evidence) ||
    value.evidence.length !== 3 ||
    value.evidence[0] !== "safe_execution_status:completed" ||
    typeof value.evidence[1] !== "string" ||
    !value.evidence[1].startsWith("output_summary:") ||
    value.evidence[2] !== "attempt_count:1"
  )
    throw new Error(
      "activation_catalog_policy_raw_reviewer_runtime_evidence_invalid",
    );
  return value.evidence[1].slice("output_summary:".length);
};

const assertRawActivationCatalogPolicyReviewEvidence = (
  buffers: ActivationCatalogRawReviewEvidenceBuffers,
  expected: ActivationCatalogRawPromotionTrustRootReady,
): void => {
  if (expected.independentReview.contractVersion !== 1)
    throw new Error("activation_catalog_policy_raw_review_contract_invalid");
  const markdown = exactRawFile(
    buffers.reviewArtifact,
    expected.independentReview.reviewArtifact.bytes,
    expected.independentReview.reviewArtifact.sha256,
    "activation_catalog_policy_raw_independent_review_artifact_invalid",
  );
  const runtimeText = exactRawFile(
    buffers.reviewerRuntime,
    expected.independentReview.reviewerRuntime.bytes,
    expected.independentReview.reviewerRuntime.sha256,
    "activation_catalog_policy_raw_reviewer_runtime_evidence_invalid",
  );
  const materialized = assertRawRuntime(
    parseJson(
      runtimeText,
      "activation_catalog_policy_raw_reviewer_runtime_evidence_invalid",
    ),
    expected,
  );
  if (!Buffer.from(materialized, "utf8").equals(buffers.reviewArtifact))
    throw new Error(
      "activation_catalog_policy_raw_review_materialization_mismatch",
    );
  if (
    markdown !== activationCatalogRawReviewArtifact(expected) ||
    expected.evidence.reviewResult !== "GO"
  )
    throw new Error("activation_catalog_policy_raw_review_report_invalid");
};

export function assertActivationCatalogPolicyReviewEvidence(
  buffers:
    | ActivationCatalogPolicyReviewEvidenceBuffers
    | ActivationCatalogRawReviewEvidenceBuffers,
  expected:
    | ActivationCatalogPolicyPromotionExpectation
    | ActivationCatalogRawPromotionTrustRootReady,
): void {
  if ("status" in expected) {
    assertRawActivationCatalogPolicyReviewEvidence(
      buffers as ActivationCatalogRawReviewEvidenceBuffers,
      expected,
    );
    return;
  }
  assertLegacyActivationCatalogPolicyReviewEvidence(
    buffers as ActivationCatalogPolicyReviewEvidenceBuffers,
    expected,
  );
}
