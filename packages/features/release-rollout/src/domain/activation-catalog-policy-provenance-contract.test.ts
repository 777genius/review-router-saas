import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sha256Canonical } from "./canonical-json";
import { reviewedActivationCatalogPromotionExpectation as expected } from "./activation-catalog-policy-promotion-expectation";
import {
  activationCatalogPolicyTrustRootReadinessFromProvenance,
  assertActivationCatalogRawCaptureEvidence,
  assertActivationCatalogPolicyPromotionProvenance,
} from "./activation-catalog-policy-provenance-contract";

const ready = (): Record<string, any> =>
  JSON.parse(
    readFileSync(
      new URL("activation-catalog-policy-provenance.json", import.meta.url),
      "utf8",
    ),
  );

const blocked = {
  kind: "reviewrouter-activation-catalog-policy-promotion-provenance",
  version: 5,
  status: "blocked",
  readinessReason:
    "independent-review-required-after-catalog-projection-change",
  invalidatedReview: {
    reviewDecisionId: "RR-V29-CODEX-GO-7459B6D4-B138EB3E-20260830",
    auditedHead: "7459b6d4fd8aab5c377547246292faf3376d98cb",
    invalidatedByCommit: "54520f050c61e88356ea0376964ac25a38700bc8",
  },
  pendingReviewSourceBindings: {
    liveCatalogProjectionSourceSha256:
      expected.liveCatalogProjectionSourceSha256,
    normalizationSourceSha256: expected.normalizationSourceSha256,
  },
};

const allPaths = (
  value: unknown,
  prefix: readonly string[] = [],
): string[][] => {
  if (Array.isArray(value))
    return value.flatMap((nested, index) => [
      [...prefix, String(index)],
      ...allPaths(nested, [...prefix, String(index)]),
    ]);
  if (value === null || typeof value !== "object") return [Array.from(prefix)];
  return Object.entries(value).flatMap(([key, nested]) => [
    [...prefix, key],
    ...allPaths(nested, [...prefix, key]),
  ]);
};

const getParent = (value: Record<string, any>, path: readonly string[]) => {
  let parent: any = value;
  for (const key of path.slice(0, -1)) parent = parent[key];
  return { parent, key: path.at(-1)! };
};

const changed = (value: unknown): unknown => {
  if (typeof value === "string") return `${value}-modified`;
  if (typeof value === "number") return value + 1;
  if (Array.isArray(value)) return [...value, "modified"];
  if (value !== null && typeof value === "object") return null;
  return "modified";
};

const provenancePaths = allPaths(ready()).filter((path) => path.length > 0);

describe("activation catalog policy promotion provenance v5", () => {
  it("accepts the exact evidence-contract-v2 ready aggregate", () => {
    expect(
      activationCatalogPolicyTrustRootReadinessFromProvenance(
        ready(),
        expected,
      ),
    ).toEqual({ status: "ready", reason: expected.readinessReason });
    expect(() =>
      assertActivationCatalogPolicyPromotionProvenance(ready(), expected),
    ).not.toThrow();
  });

  it.each(provenancePaths)("fails closed when %s is missing", (...path) => {
    const value = ready();
    const { parent, key } = getParent(value, path);
    delete parent[key];
    expect(
      activationCatalogPolicyTrustRootReadinessFromProvenance(value, expected)
        .status,
    ).toBe("blocked");
  });

  it.each(provenancePaths)("fails closed when %s is modified", (...path) => {
    const value = ready();
    const { parent, key } = getParent(value, path);
    parent[key] = changed(parent[key]);
    expect(
      activationCatalogPolicyTrustRootReadinessFromProvenance(value, expected)
        .status,
    ).toBe("blocked");
  });

  it.each([
    [
      "invalid reviewedAt",
      "not-a-time",
      expected.reviewerCompletedAt,
      expected.supplementalCompletedAt,
      expected.promotedAt,
    ],
    [
      "invalid calendar date",
      "2026-02-31T14:26:32Z",
      expected.reviewerCompletedAt,
      expected.supplementalCompletedAt,
      expected.promotedAt,
    ],
    [
      "equal authoritative times",
      expected.reviewerCompletedAt,
      expected.reviewerCompletedAt,
      expected.supplementalCompletedAt,
      expected.promotedAt,
    ],
    [
      "reversed authoritative times",
      "2026-08-30T14:27:45.120Z",
      expected.reviewerCompletedAt,
      expected.supplementalCompletedAt,
      expected.promotedAt,
    ],
    [
      "equal review completions",
      expected.reviewedAt,
      expected.supplementalCompletedAt,
      expected.supplementalCompletedAt,
      expected.promotedAt,
    ],
    [
      "reversed review completions",
      expected.reviewedAt,
      "2026-08-30T14:37:21.636Z",
      expected.supplementalCompletedAt,
      expected.promotedAt,
    ],
    [
      "promotion at supplemental completion",
      expected.reviewedAt,
      expected.reviewerCompletedAt,
      expected.supplementalCompletedAt,
      expected.supplementalCompletedAt,
    ],
    [
      "promotion before supplemental completion",
      expected.reviewedAt,
      expected.reviewerCompletedAt,
      expected.supplementalCompletedAt,
      "2026-08-30T14:37:19.636Z",
    ],
  ])(
    "rejects %s",
    (_name, reviewedAt, completedAt, supplementalAt, promotedAt) => {
      const value = ready();
      value.independentReview.reviewedAt = reviewedAt;
      value.independentReview.completedAt = completedAt;
      value.supplementalReview.completedAt = supplementalAt;
      value.promotedAt = promotedAt;
      const timelineExpected = {
        ...expected,
        reviewedAt,
        reviewerCompletedAt: completedAt,
        supplementalCompletedAt: supplementalAt,
        promotedAt,
      };
      expect(
        activationCatalogPolicyTrustRootReadinessFromProvenance(
          value,
          timelineExpected,
        ).status,
      ).toBe("blocked");
    },
  );

  it("requires the exact two expected capture labels, not merely distinct labels", () => {
    const value = ready();
    value.candidate.captures[0]!.label = "capture-a";
    value.candidate.captures[1].label = "capture-b";
    expect(
      activationCatalogPolicyTrustRootReadinessFromProvenance(value, expected)
        .status,
    ).toBe("blocked");
  });

  it("preserves the existing well-formed blocked trust root as fail closed", () => {
    expect(
      activationCatalogPolicyTrustRootReadinessFromProvenance(
        blocked,
        expected,
      ),
    ).toEqual({
      status: "blocked",
      reason: "independent-review-required-after-catalog-projection-change",
    });
    expect(() =>
      assertActivationCatalogPolicyPromotionProvenance(blocked, expected),
    ).toThrow("activation_catalog_policy_promotion_provenance_invalid");
  });

  it("fails closed for malformed and unknown-field trust roots", () => {
    expect(
      activationCatalogPolicyTrustRootReadinessFromProvenance(
        { ...ready(), unknown: true },
        expected,
      ).status,
    ).toBe("blocked");
    expect(
      activationCatalogPolicyTrustRootReadinessFromProvenance(null, expected)
        .status,
    ).toBe("blocked");
  });

  it("accepts strict raw evidence v1 and never treats malformed raw as legacy", () => {
    const captures = [
      { label: "candidate-1.json", bytes: 100, sha256: "a".repeat(64) },
      { label: "candidate-2.json", bytes: 101, sha256: "b".repeat(64) },
    ];
    const raw = {
      kind: "reviewrouter-activation-catalog-raw-capture-evidence",
      version: 1,
      selectedCaptureId: captures[0]!.label,
      captureSetSha256: "",
      captures,
      capture: {
        baseCommit: "1".repeat(40),
        auditedHead: "2".repeat(40),
        auditedTree: "3".repeat(40),
        workflowRunId: "10",
        runAttempt: 1,
        jobId: "11",
        artifactId: "12",
        artifactName: "activation-catalog-capture",
      },
      postgresImages: {
        sourcePg16: `postgres:16@sha256:${"4".repeat(64)}`,
        targetPg17: `postgres:17@sha256:${"5".repeat(64)}`,
      },
      reviewResult: "GO",
      reviewDecisionId: "RR-RAW-GO",
      projectionSha256: `sha256:${"6".repeat(64)}`,
      liveCatalogDigest: `sha256:${"7".repeat(64)}`,
      postManifestIdentity: `sha256:${"8".repeat(64)}`,
      recoveryWitnessSha256: "9".repeat(64),
      canonicalDigests: {
        preactivation: `sha256:${"a".repeat(64)}`,
        activated: `sha256:${"b".repeat(64)}`,
        artifact: `sha256:${"c".repeat(64)}`,
      },
      generatedArtifactSource: { bytes: 1000, sha256: "d".repeat(64) },
    };
    const {
      kind: _kind,
      version: _version,
      captureSetSha256: _set,
      ...material
    } = raw;
    raw.captureSetSha256 = `sha256:${sha256Canonical(material)}`;
    expect(() => assertActivationCatalogRawCaptureEvidence(raw)).not.toThrow();
    expect(() =>
      assertActivationCatalogRawCaptureEvidence({ ...raw, version: 2 }),
    ).toThrow("activation_catalog_policy_raw_capture_evidence_invalid");
    expect(() =>
      assertActivationCatalogPolicyPromotionProvenance(raw, expected),
    ).toThrow("activation_catalog_policy_promotion_provenance_invalid");
  });
});
