import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sha256Canonical } from "../domain/canonical-json";
import {
  activationCatalogRawPromotionOptIn,
  activationCatalogRawReviewArtifactRepositoryPath,
  activationCatalogRawReviewerRuntimeRepositoryPath,
  activationCatalogRawTrustRootReadiness,
  assertActivationCatalogRawPromotionTrustRootReady,
  loadActivationCatalogRawPromotionTrustRoot,
  type ActivationCatalogRawPromotionTrustRootReady,
} from "../domain/activation-catalog-policy-raw-promotion-trust-root";
import { canonicalReleaseMigrationPostManifestIdentity } from "../domain/release-migration-transition";
import {
  activationCatalogRawReviewArtifact,
  assertActivationCatalogPolicyReviewEvidence,
} from "./activation-catalog-policy-review-evidence";

const digest = (value: Buffer): string =>
  createHash("sha256").update(value).digest("hex");

function deepFreeze<T>(
  value: T,
  seen: WeakSet<object> = new WeakSet<object>(),
): T {
  if (value === null || typeof value !== "object" || seen.has(value))
    return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value))
    deepFreeze(Reflect.get(value, key), seen);
  Object.freeze(value);
  return value;
}

const capture = {
  baseCommit: "a".repeat(40),
  auditedHead: "b".repeat(40),
  auditedTree: "c".repeat(40),
  workflowRunId: "123",
  runAttempt: 1,
  jobId: "456",
  artifactId: "789",
  artifactName: "activation-catalog-policy-raw",
};

function rawEvidence() {
  const value = {
    kind: "reviewrouter-activation-catalog-raw-capture-evidence" as const,
    version: 1 as const,
    selectedCaptureId: "activation-catalog-policy-candidate-1.json",
    captureSetSha256: "",
    captures: [
      {
        label: "activation-catalog-policy-candidate-1.json",
        bytes: 101,
        sha256: "1".repeat(64),
      },
      {
        label: "activation-catalog-policy-candidate-2.json",
        bytes: 102,
        sha256: "2".repeat(64),
      },
    ] as const,
    capture: { ...capture },
    postgresImages: {
      sourcePg16: `postgres:16@sha256:${"3".repeat(64)}`,
      targetPg17: `postgres:17@sha256:${"4".repeat(64)}`,
    },
    reviewResult: "GO" as const,
    reviewDecisionId: "RR-RAW-GO",
    projectionSha256: `sha256:${"5".repeat(64)}`,
    liveCatalogDigest: `sha256:${"6".repeat(64)}`,
    postManifestIdentity: canonicalReleaseMigrationPostManifestIdentity,
    recoveryWitnessSha256: "8".repeat(64),
    canonicalDigests: {
      preactivation: `sha256:${"9".repeat(64)}`,
      activated: `sha256:${"a".repeat(64)}`,
      artifact: `sha256:${"b".repeat(64)}`,
    },
    generatedArtifactSource: {
      bytes: 103,
      sha256: "c".repeat(64),
    },
  };
  const material = Object.fromEntries(
    Object.entries(value).filter(
      ([key]) => !["kind", "version", "captureSetSha256"].includes(key),
    ),
  );
  value.captureSetSha256 = `sha256:${sha256Canonical(material)}`;
  return value;
}

function unboundRoot(): ActivationCatalogRawPromotionTrustRootReady {
  return {
    status: "ready",
    optIn: activationCatalogRawPromotionOptIn,
    evidence: rawEvidence(),
    independentReview: {
      contractVersion: 1,
      reviewArtifact: {
        repositoryPath: activationCatalogRawReviewArtifactRepositoryPath,
        bytes: 1,
        sha256: "d".repeat(64),
      },
      reviewerRuntime: {
        repositoryPath: activationCatalogRawReviewerRuntimeRepositoryPath,
        bytes: 1,
        sha256: "e".repeat(64),
      },
      reviewerRunId: "rr-raw-independent-review",
      reviewerTaskId: "rr-raw-independent-review",
      reviewedAt: "2026-08-31T10:00:00Z",
      completedAt: "2026-08-31T10:01:00Z",
    },
  };
}

function fixture(frozen = true) {
  let root = unboundRoot();
  const reviewArtifact = Buffer.from(
    activationCatalogRawReviewArtifact(root),
    "utf8",
  );
  const runtime = {
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
    runId: root.independentReview.reviewerRunId,
    taskId: root.independentReview.reviewerTaskId,
    details: { baseCommit: root.evidence.capture.baseCommit },
    updatedAt: root.independentReview.completedAt,
  };
  const reviewerRuntime = Buffer.from(
    `${JSON.stringify(runtime, null, 2)}\n`,
    "utf8",
  );
  root = {
    ...root,
    independentReview: {
      ...root.independentReview,
      reviewArtifact: {
        ...root.independentReview.reviewArtifact,
        bytes: reviewArtifact.byteLength,
        sha256: digest(reviewArtifact),
      },
      reviewerRuntime: {
        ...root.independentReview.reviewerRuntime,
        bytes: reviewerRuntime.byteLength,
        sha256: digest(reviewerRuntime),
      },
    },
  };
  return {
    root: frozen ? deepFreeze(root) : root,
    buffers: { reviewArtifact, reviewerRuntime },
  };
}

function bindReviewerRuntime(
  root: ActivationCatalogRawPromotionTrustRootReady,
  reviewerRuntime: Buffer,
): ActivationCatalogRawPromotionTrustRootReady {
  return {
    ...root,
    independentReview: {
      ...root.independentReview,
      reviewerRuntime: {
        ...root.independentReview.reviewerRuntime,
        bytes: reviewerRuntime.byteLength,
        sha256: digest(reviewerRuntime),
      },
    },
  };
}

describe("activation catalog raw review trust root", () => {
  it("accepts a code-owned ready root and its exact materialized GO review", () => {
    const { root, buffers } = fixture();
    expect(activationCatalogRawTrustRootReadiness(root).status).toBe("ready");
    expect(() =>
      assertActivationCatalogPolicyReviewEvidence(buffers, root),
    ).not.toThrow();
  });

  it("accepts only deeply immutable ready roots", () => {
    const { root } = fixture();
    expect(() =>
      assertActivationCatalogRawPromotionTrustRootReady(root),
    ).not.toThrow();
    expect(() => {
      (root.evidence.captures as unknown as unknown[]).push({});
    }).toThrow(TypeError);
    expect(() => {
      (
        root.independentReview.reviewArtifact as {
          sha256: string;
        }
      ).sha256 = "f".repeat(64);
    }).toThrow(TypeError);
  });

  it("rejects a structurally ready but caller-mutable root", () => {
    const { root } = fixture(false);
    expect(activationCatalogRawTrustRootReadiness(root).status).toBe("ready");
    expect(() =>
      assertActivationCatalogRawPromotionTrustRootReady(root),
    ).toThrow("activation_catalog_policy_raw_trust_root_invalid");
  });

  it("loads only the exact pending sentinel and deeply freezes it", () => {
    const pending = loadActivationCatalogRawPromotionTrustRoot({
      status: "pending",
      reason: "fresh-authenticated-raw-capture-and-independent-review-required",
    });
    expect(pending).toEqual({
      status: "pending",
      reason: "fresh-authenticated-raw-capture-and-independent-review-required",
    });
    expect(Object.isFrozen(pending)).toBe(true);
    expect(() =>
      assertActivationCatalogRawPromotionTrustRootReady(pending),
    ).toThrow("activation_catalog_policy_raw_trust_root_pending");
  });

  it.each([
    { status: "pending" },
    { status: "pending", reason: "wrong-reason" },
    {
      status: "pending",
      reason: "fresh-authenticated-raw-capture-and-independent-review-required",
      evidence: {},
    },
  ])("rejects malformed pending-like roots at load time", (value) => {
    expect(() => loadActivationCatalogRawPromotionTrustRoot(value)).toThrow(
      "activation_catalog_policy_raw_trust_root_invalid",
    );
  });

  it.each([
    [
      "raw hash",
      (root: any) => {
        root.evidence.captures[0].sha256 = "f".repeat(64);
      },
    ],
    [
      "run",
      (root: any) => {
        root.evidence.capture.workflowRunId = "124";
      },
    ],
    [
      "decision",
      (root: any) => {
        root.evidence.reviewDecisionId = "RR-RAW-STALE";
      },
    ],
    [
      "NO-GO",
      (root: any) => {
        root.evidence.reviewResult = "NO-GO";
      },
    ],
    [
      "opt-in",
      (root: any) => {
        root.optIn = "wrong-opt-in";
      },
    ],
    [
      "review version",
      (root: any) => {
        root.independentReview.contractVersion = 2;
      },
    ],
    [
      "review path",
      (root: any) => {
        root.independentReview.reviewArtifact.repositoryPath = "../review.md";
      },
    ],
    [
      "post-manifest identity",
      (root: any) => {
        root.evidence.postManifestIdentity = `sha256:${"7".repeat(64)}`;
      },
    ],
  ])(
    "rejects %s tampering on the pure ready-validator path",
    (_name, mutate) => {
      const { root } = fixture(false);
      mutate(root);
      expect(activationCatalogRawTrustRootReadiness(root).status).toBe(
        "pending",
      );
    },
  );

  it("rejects review tampering without rebinding its exact-byte pin", () => {
    const { root, buffers } = fixture();
    const reviewArtifact = Buffer.from(buffers.reviewArtifact);
    reviewArtifact[reviewArtifact.byteLength - 2]! ^= 1;
    expect(() =>
      assertActivationCatalogPolicyReviewEvidence(
        { ...buffers, reviewArtifact },
        root,
      ),
    ).toThrow(
      "activation_catalog_policy_raw_independent_review_artifact_invalid",
    );
  });

  it("does not parse runtime JSON before its expected raw hash is bound", () => {
    const { root, buffers } = fixture();
    const reviewerRuntime = Buffer.from("{not-json}\n", "utf8");
    expect(() =>
      assertActivationCatalogPolicyReviewEvidence(
        { ...buffers, reviewerRuntime },
        root,
      ),
    ).toThrow(
      "activation_catalog_policy_raw_reviewer_runtime_evidence_invalid",
    );
  });

  it("rejects hash-bound runtime identities, time, and base from stale reviews", () => {
    const { root, buffers } = fixture();
    for (const stale of ["run", "task", "time", "base"] as const) {
      const runtime = JSON.parse(buffers.reviewerRuntime.toString("utf8")) as {
        runId: string;
        taskId: string;
        updatedAt: string;
        details: { baseCommit: string };
      };
      if (stale === "run") runtime.runId = "rr-stale-review-run";
      if (stale === "task") runtime.taskId = "rr-stale-review-task";
      if (stale === "time") runtime.updatedAt = "2026-08-31T10:02:00Z";
      if (stale === "base") runtime.details.baseCommit = "d".repeat(40);
      const reviewerRuntime = Buffer.from(
        `${JSON.stringify(runtime, null, 2)}\n`,
        "utf8",
      );
      expect(() =>
        assertActivationCatalogPolicyReviewEvidence(
          { ...buffers, reviewerRuntime },
          bindReviewerRuntime(root, reviewerRuntime),
        ),
      ).toThrow(
        "activation_catalog_policy_raw_reviewer_runtime_evidence_invalid",
      );
    }
  });

  it("rejects noncanonical runtime JSON after rebinding its exact bytes", () => {
    const { root, buffers } = fixture();
    const runtime: unknown = JSON.parse(
      buffers.reviewerRuntime.toString("utf8"),
    );
    const reviewerRuntime = Buffer.from(JSON.stringify(runtime), "utf8");
    expect(() =>
      assertActivationCatalogPolicyReviewEvidence(
        { ...buffers, reviewerRuntime },
        bindReviewerRuntime(root, reviewerRuntime),
      ),
    ).toThrow(
      "activation_catalog_policy_raw_reviewer_runtime_evidence_invalid",
    );
  });

  it("rejects canonical, hash-bound runtime JSON that does not materialize GO", () => {
    const { root, buffers } = fixture();
    const runtime = JSON.parse(buffers.reviewerRuntime.toString("utf8"));
    runtime.evidence[1] = runtime.evidence[1].replace(
      "- Verdict: **GO**",
      "- Verdict: **NO-GO**",
    );
    const reviewerRuntime = Buffer.from(
      `${JSON.stringify(runtime, null, 2)}\n`,
      "utf8",
    );
    expect(() =>
      assertActivationCatalogPolicyReviewEvidence(
        { ...buffers, reviewerRuntime },
        bindReviewerRuntime(root, reviewerRuntime),
      ),
    ).toThrow("activation_catalog_policy_raw_review_materialization_mismatch");
  });
});
