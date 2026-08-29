import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import canonicalActivationCatalogPolicyArtifact from "../packages/features/release-rollout/src/domain/activation-catalog-policy-artifact.generated.js";
import { canonicalJson } from "../packages/features/release-rollout/src/domain/canonical-json.ts";
import { fencedLiveV70V73CatalogDigestSql } from "../packages/features/release-rollout/src/adapters/live-v70-v72-catalog-digest.mjs";
import {
  activationCatalogPromotionOptIn,
  activationCatalogPromotionProvenancePath,
  assertActivationCatalogPolicyCaptureBinding,
  assertActivationCatalogPolicyCandidateSchema,
  canonicalActivationCatalogArtifactSource,
  assertActivationCatalogPolicyIndependentReviewEvidence,
  assertReviewedActivationCatalogPromotionProvenance,
  promotePrivatePg17ActivationCatalogPolicy,
  reviewedActivationCatalogCandidate,
} from "./promote-private-pg17-activation-catalog-policy.mjs";

describe("activation catalog policy promotion", () => {
  const captureCandidate = () => ({
    kind: "reviewrouter-activation-catalog-policy-artifact-candidate",
    version: 2,
    policies: { preactivation: {}, activated: {} },
    capture: {
      commitSha: "a".repeat(40),
      postManifestIdentity:
        "sha256:381abaecf082c48e20ac2b620d50fd72b12cc974d6cde894529961b269a644d4",
      database: {
        disposableIdentity: "rr-disposable-candidate-test",
        configuredIdentity: "rr-target.internal:5432/review_router",
        systemIdentifier: "7612345678901234567",
        recoveryWitnessSha256: "d".repeat(64),
      },
      projection: {
        sha256: `sha256:${createHash("sha256")
          .update(fencedLiveV70V73CatalogDigestSql)
          .digest("hex")}`,
        observedDigest: `sha256:${"c".repeat(64)}`,
      },
    },
  });

  it("accepts the exact directly consumable capture candidate schema", () => {
    expect(() =>
      assertActivationCatalogPolicyCaptureBinding(captureCandidate().capture),
    ).not.toThrow();
  });

  it("directly consumes the capture artifact after deterministic v1 payload recovery", () => {
    const candidate = captureCandidate();
    candidate.policies = canonicalActivationCatalogPolicyArtifact.policies;
    expect(() =>
      assertActivationCatalogPolicyCandidateSchema(candidate),
    ).not.toThrow();
    expect(() =>
      canonicalActivationCatalogArtifactSource(
        Buffer.from(canonicalJson(candidate), "utf8"),
      ),
    ).not.toThrow();
  });

  it.each([
    [
      "commit",
      (value: ReturnType<typeof captureCandidate>) =>
        (value.capture.commitSha = "0"),
    ],
    [
      "post manifest",
      (value: ReturnType<typeof captureCandidate>) =>
        (value.capture.postManifestIdentity = `sha256:${"0".repeat(64)}`),
    ],
    [
      "disposable identity",
      (value: ReturnType<typeof captureCandidate>) =>
        (value.capture.database.disposableIdentity = "production"),
    ],
    [
      "configured database identity",
      (value: ReturnType<typeof captureCandidate>) =>
        (value.capture.database.configuredIdentity = "not-a-database"),
    ],
    [
      "system identifier",
      (value: ReturnType<typeof captureCandidate>) =>
        (value.capture.database.systemIdentifier = "not-a-system-id"),
    ],
    [
      "recovery witness",
      (value: ReturnType<typeof captureCandidate>) =>
        (value.capture.database.recoveryWitnessSha256 = "0"),
    ],
    [
      "projection",
      (value: ReturnType<typeof captureCandidate>) =>
        (value.capture.projection.sha256 = "0"),
    ],
    [
      "observed digest",
      (value: ReturnType<typeof captureCandidate>) =>
        (value.capture.projection.observedDigest =
          "sha256:039bb3284d3e664958e40a3a319157ee04030240082c0e1e832dcf8d64b014f0"),
    ],
  ])("rejects capture %s tampering", (_name, tamper) => {
    const value = captureCandidate();
    tamper(value);
    expect(() =>
      assertActivationCatalogPolicyCaptureBinding(value.capture),
    ).toThrow("activation_catalog_policy_promotion_capture_binding_invalid");
  });

  it("pins the exact reviewed v25 candidate and operator opt-in", () => {
    expect(activationCatalogPromotionOptIn).toBe(
      "promote-reviewed-activation-catalog-v25",
    );
    expect(reviewedActivationCatalogCandidate).toEqual({
      sha256:
        "3f20cac0f84591e99f2f4f4a555faac4e2900fc5e6271238d20c71b67a6538bb",
      canonicalSha256:
        "3f8db8d7ba78126d72df34def855dea4139d17d61d7318d7144c9c0242dff89e",
      bytes: 2_489_008,
      preactivationCatalogPolicySha256:
        "sha256:36e6e4875c530beba1cb6bfc580a358d031895334e6af6a6bad193148e1beebe",
      activatedCatalogPolicySha256:
        "sha256:d0ccc9a760f69c467d3c9df56502704abb1f03116a2be156eb206100b35f5866",
      artifactCanonicalSha256:
        "sha256:539eead0f59e75f283d217be840280c61a3813d928e24a48ed9b34687ef5111d",
    });
  });

  it("requires the exact operator promotion opt-in before reading input", async () => {
    await expect(
      promotePrivatePg17ActivationCatalogPolicy({
        env: {},
        argv: ["--candidate", "/does/not/exist"],
      }),
    ).rejects.toThrow("activation_catalog_policy_promotion_opt_in_required");
  });

  it("requires an explicit candidate path under the exact opt-in", async () => {
    await expect(
      promotePrivatePg17ActivationCatalogPolicy({
        env: {
          REVIEW_ROUTER_ACTIVATION_CATALOG_PROMOTION:
            activationCatalogPromotionOptIn,
        },
        argv: [],
      }),
    ).rejects.toThrow("activation_catalog_policy_promotion_candidate_required");
  });

  it("refuses unreviewed candidate bytes", async () => {
    await expect(
      promotePrivatePg17ActivationCatalogPolicy({
        env: {
          REVIEW_ROUTER_ACTIVATION_CATALOG_PROMOTION:
            activationCatalogPromotionOptIn,
        },
        argv: ["--candidate", import.meta.filename],
      }),
    ).rejects.toThrow(
      /activation_catalog_policy_promotion_candidate_(?:size|hash)_drift/u,
    );
  });

  it("refuses promotion without exact independent GO evidence", () => {
    expect(() =>
      assertReviewedActivationCatalogPromotionProvenance({
        status: "ready",
        independentReview: { result: "NO-GO" },
      }),
    ).toThrow("activation_catalog_policy_promotion_provenance_invalid");
  });

  it("verifies the immutable independent review and runtime evidence", async () => {
    const provenance = JSON.parse(
      await readFile(activationCatalogPromotionProvenancePath, "utf8"),
    );
    await expect(
      assertActivationCatalogPolicyIndependentReviewEvidence(provenance),
    ).resolves.toBeUndefined();
  });
});
