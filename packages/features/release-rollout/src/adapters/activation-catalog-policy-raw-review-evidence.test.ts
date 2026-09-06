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
import { assertActivationCatalogPolicyReviewEvidence } from "./activation-catalog-policy-review-evidence";

const digest = (value: Buffer): string =>
  createHash("sha256").update(value).digest("hex");

const rawReviewArtifact = (captureSetSha256: string): Buffer =>
  Buffer.from(
    `# Raw activation catalog independent review

## Decision

- Verdict: **GO**
- BLOCKER: **0**
- HIGH: **0**
- Decision ID: \`RR-PR236-RAW-CATALOG-GO-BE9958E3-140043EC-20260831\`
- Reviewed at: \`2026-08-31T22:13:00.000Z\`

## Capture identities

- Base commit: \`1963a5d3d7697c120c67eb864bb003c1a69f2a4d\`
- Audited head: \`be9958e3912d8d07fc965f0364fe8565d85d9894\`
- Audited tree: \`5e6612922c2368d7f0d3a948794aa90e9a3f44ba\`
- Workflow run: \`33444675220\`
- Run attempt: \`1\`
- Job: \`99660942529\`
- Artifact ID: \`9777622013\`
- Artifact name: \`activation-catalog-policy-be9958e3912d8d07fc965f0364fe8565d85d9894-1\`

## Raw captures

| Selection | Label | Bytes | Raw SHA-256 |
| --- | --- | ---: | --- |
| selected | \`activation-catalog-policy-candidate-1.json\` | \`2677685\` | \`140043ec47171493ff2e713eb0ec0a2afe18ae1133bb61b5178069533cbad6e9\` |
| corroborating | \`activation-catalog-policy-candidate-2.json\` | \`2677685\` | \`57c519a3f5ee2413ff61e1236ba49450160859e20f0ed0612fd1c3b67e283bf0\` |

Capture-set digest: \`${captureSetSha256}\`
Source PostgreSQL image: \`postgres:16.13-bookworm@sha256:472efd9a66f2b2f1a5aeb18b28de74332e6ef88c2b93a1a5d812fb6db67a5f60\`
Target PostgreSQL image: \`postgres:17.5-bookworm@sha256:fbcea1bd13b6a882cd6caa6b58db3ae5c102efe50ec625b3e2a5cbc50db5bfe4\`
`,
    "utf8",
  );

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
  baseCommit: "1963a5d3d7697c120c67eb864bb003c1a69f2a4d",
  auditedHead: "be9958e3912d8d07fc965f0364fe8565d85d9894",
  auditedTree: "5e6612922c2368d7f0d3a948794aa90e9a3f44ba",
  workflowRunId: "33444675220",
  runAttempt: 1,
  jobId: "99660942529",
  artifactId: "9777622013",
  artifactName:
    "activation-catalog-policy-be9958e3912d8d07fc965f0364fe8565d85d9894-1",
};

function rawEvidence() {
  const captureSetMaterial = {
    selectedCaptureId: "activation-catalog-policy-candidate-1.json",
    captures: [
      {
        label: "activation-catalog-policy-candidate-1.json",
        bytes: 2677685,
        sha256:
          "140043ec47171493ff2e713eb0ec0a2afe18ae1133bb61b5178069533cbad6e9",
      },
      {
        label: "activation-catalog-policy-candidate-2.json",
        bytes: 2677685,
        sha256:
          "57c519a3f5ee2413ff61e1236ba49450160859e20f0ed0612fd1c3b67e283bf0",
      },
    ] as const,
    capture: { ...capture },
    postgresImages: {
      sourcePg16:
        "postgres:16.13-bookworm@sha256:472efd9a66f2b2f1a5aeb18b28de74332e6ef88c2b93a1a5d812fb6db67a5f60",
      targetPg17:
        "postgres:17.5-bookworm@sha256:fbcea1bd13b6a882cd6caa6b58db3ae5c102efe50ec625b3e2a5cbc50db5bfe4",
    },
    reviewResult: "GO" as const,
    reviewDecisionId: "RR-PR236-RAW-CATALOG-GO-BE9958E3-140043EC-20260831",
    projectionSha256:
      "sha256:42aaf14dff0968cfea3b1e80dca7c05de19e7888500c56e55f8fc3856684ebc6",
    liveCatalogDigest:
      "sha256:7ed3473cc71431dd2257a13d3c8fb048c4bb1adf3048064ff3117988251da644",
    postManifestIdentity: canonicalReleaseMigrationPostManifestIdentity,
    recoveryWitnessSha256:
      "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    canonicalDigests: {
      preactivation:
        "sha256:28c02276a3256329e9234bf7d7ecf7b2902651c51c6b0b35ba6a8d40582e2b0a",
      activated:
        "sha256:52aa57bd91c33b0e51a8ba0ff87b2ff4fbe22435f863804428bcb0ae2f3064ca",
      artifact:
        "sha256:3af42ff77b0d4168b3bb271f57d29387655064627ca74169557dbb79d9953959",
    },
    generatedArtifactSource: {
      bytes: 2677061,
      sha256:
        "0579802d4276c087fd1d9281f09b0159d70b9920907f0fc355604cdc4d0fb21f",
    },
  };
  return {
    kind: "reviewrouter-activation-catalog-raw-capture-evidence" as const,
    version: 1 as const,
    captureSetSha256: `sha256:${sha256Canonical(captureSetMaterial)}`,
    ...captureSetMaterial,
  };
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
      reviewerRunId: "rr-pr236-capture-review-r225-fallback",
      reviewerTaskId: "rr-pr236-capture-review-r225-fallback",
      reviewedAt: "2026-08-31T22:13:00.000Z",
      completedAt: "2026-08-31T22:19:06.959Z",
    },
  };
}

function fixture(frozen = true, contractVersion: 1 | 2 = 1) {
  let root = unboundRoot();
  root = {
    ...root,
    independentReview: { ...root.independentReview, contractVersion },
  };
  const reviewArtifact = rawReviewArtifact(root.evidence.captureSetSha256);
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
    details: {
      baseCommit:
        contractVersion === 2
          ? root.evidence.capture.auditedHead
          : root.evidence.capture.baseCommit,
    },
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
  it("accepts fixed independently authored review and receipt fixture bytes", () => {
    const { root, buffers } = fixture();
    expect(activationCatalogRawTrustRootReadiness(root).status).toBe("ready");
    expect(() =>
      assertActivationCatalogPolicyReviewEvidence(buffers, root),
    ).not.toThrow();
  });

  it("accepts v2 runtime at the audited head with the distinct capture base intact", () => {
    const { root, buffers } = fixture(true, 2);
    expect(root.evidence.capture.baseCommit).not.toBe(
      root.evidence.capture.auditedHead,
    );
    expect(activationCatalogRawTrustRootReadiness(root).status).toBe("ready");
    expect(() =>
      loadActivationCatalogRawPromotionTrustRoot(root),
    ).not.toThrow();
    expect(() =>
      assertActivationCatalogPolicyReviewEvidence(buffers, root),
    ).not.toThrow();
  });

  it.each([
    [1, capture.auditedHead],
    [1, "d".repeat(40)],
    [2, capture.baseCommit],
    [2, "d".repeat(40)],
  ] as const)(
    "rejects v%s runtime bound to wrong base %s",
    (version, baseCommit) => {
      const { root, buffers } = fixture(true, version);
      const runtime = JSON.parse(buffers.reviewerRuntime.toString("utf8"));
      runtime.details.baseCommit = baseCommit;
      const reviewerRuntime = Buffer.from(
        `${JSON.stringify(runtime, null, 2)}\n`,
      );
      expect(() =>
        assertActivationCatalogPolicyReviewEvidence(
          { ...buffers, reviewerRuntime },
          bindReviewerRuntime(root, reviewerRuntime),
        ),
      ).toThrow(
        "activation_catalog_policy_raw_reviewer_runtime_evidence_invalid",
      );
    },
  );

  it.each([0, 3, "2", null, undefined])(
    "rejects unknown review contract version %s at both boundaries",
    (contractVersion) => {
      const { root, buffers } = fixture();
      const invalid = {
        ...root,
        independentReview: { ...root.independentReview, contractVersion },
      };
      expect(activationCatalogRawTrustRootReadiness(invalid).status).toBe(
        "pending",
      );
      expect(() => loadActivationCatalogRawPromotionTrustRoot(invalid)).toThrow(
        "activation_catalog_policy_raw_trust_root_invalid",
      );
      expect(() =>
        assertActivationCatalogPolicyReviewEvidence(
          buffers,
          invalid as ActivationCatalogRawPromotionTrustRootReady,
        ),
      ).toThrow("activation_catalog_policy_raw_review_contract_invalid");
    },
  );

  it.each([1, 2] as const)(
    "rejects v%s hash-bound runtime/report materialization mismatch",
    (version) => {
      const { root, buffers } = fixture(true, version);
      const runtime = JSON.parse(buffers.reviewerRuntime.toString("utf8"));
      runtime.evidence[1] += "\n";
      const reviewerRuntime = Buffer.from(
        `${JSON.stringify(runtime, null, 2)}\n`,
      );
      expect(() =>
        assertActivationCatalogPolicyReviewEvidence(
          { ...buffers, reviewerRuntime },
          bindReviewerRuntime(root, reviewerRuntime),
        ),
      ).toThrow(
        "activation_catalog_policy_raw_review_materialization_mismatch",
      );
    },
  );

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
        root.independentReview.contractVersion = 3;
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

  it("rejects independently rebound review and receipt bytes with a non-GO verdict", () => {
    const { root, buffers } = fixture();
    const reviewArtifact = Buffer.from(
      buffers.reviewArtifact
        .toString("utf8")
        .replace("- Verdict: **GO**", "- Verdict: **NO-GO**"),
      "utf8",
    );
    const runtime = JSON.parse(buffers.reviewerRuntime.toString("utf8"));
    runtime.evidence[1] = `output_summary:${reviewArtifact.toString("utf8")}`;
    const reviewerRuntime = Buffer.from(
      `${JSON.stringify(runtime, null, 2)}\n`,
      "utf8",
    );
    const reboundRoot = {
      ...bindReviewerRuntime(root, reviewerRuntime),
      independentReview: {
        ...bindReviewerRuntime(root, reviewerRuntime).independentReview,
        reviewArtifact: {
          ...root.independentReview.reviewArtifact,
          bytes: reviewArtifact.byteLength,
          sha256: digest(reviewArtifact),
        },
      },
    };
    expect(() =>
      assertActivationCatalogPolicyReviewEvidence(
        { reviewArtifact, reviewerRuntime },
        reboundRoot,
      ),
    ).toThrow("activation_catalog_policy_raw_review_report_invalid");
  });
});
