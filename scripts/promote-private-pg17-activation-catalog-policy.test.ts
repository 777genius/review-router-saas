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
  const captureCandidate = (
    policies: Record<string, unknown> = {
      preactivation: {},
      activated: {},
    },
  ) => {
    const database = {
      disposableIdentity: "rr-disposable-candidate-test",
      configuredIdentity: "rr-target.internal:5432/review_router",
      systemIdentifier: "7612345678901234567",
      recoveryWitnessSha256: "d".repeat(64),
    };
    const projection = {
      sha256: `sha256:${createHash("sha256")
        .update(fencedLiveV70V73CatalogDigestSql)
        .digest("hex")}`,
      observedDigest: `sha256:${"c".repeat(64)}`,
    };
    const capture = {
      commitSha: "a".repeat(40),
      postManifestIdentity:
        "sha256:381abaecf082c48e20ac2b620d50fd72b12cc974d6cde894529961b269a644d4",
      database,
      projection,
      custody: {
        captureBaseCommit: "9".repeat(40),
        auditedHead: "a".repeat(40),
        evidenceSha256: "",
      },
    };
    capture.custody.evidenceSha256 = `sha256:${createHash("sha256")
      .update(
        canonicalJson({
          auditedHead: capture.custody.auditedHead,
          captureBaseCommit: capture.custody.captureBaseCommit,
          commitSha: capture.commitSha,
          database,
          policies,
          postManifestIdentity: capture.postManifestIdentity,
          projection,
        }),
      )
      .digest("hex")}`;
    return {
      kind: "reviewrouter-activation-catalog-policy-artifact-candidate",
      version: 2,
      policies,
      capture,
    };
  };

  it("accepts the exact directly consumable capture candidate schema", () => {
    expect(() =>
      assertActivationCatalogPolicyCaptureBinding(
        captureCandidate().capture,
        captureCandidate().policies,
      ),
    ).not.toThrow();
  });

  it("accepts a real-shaped post-000079 capture only as a new review candidate", () => {
    const policies = post000079CapturedPolicies();
    const candidate = captureCandidate(policies);
    expect(() =>
      assertActivationCatalogPolicyCandidateSchema(candidate),
    ).not.toThrow();
    expect(() =>
      canonicalActivationCatalogArtifactSource(
        Buffer.from(canonicalJson(candidate), "utf8"),
      ),
    ).toThrow(
      "activation_catalog_policy_promotion_new_candidate_review_required",
    );
    expect(canonicalJson(policies)).not.toBe(
      canonicalJson(canonicalActivationCatalogPolicyArtifact.policies),
    );
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
    [
      "capture base",
      (value: ReturnType<typeof captureCandidate>) =>
        (value.capture.custody.captureBaseCommit = "0".repeat(40)),
    ],
    [
      "audited head",
      (value: ReturnType<typeof captureCandidate>) =>
        (value.capture.custody.auditedHead = "0".repeat(40)),
    ],
    [
      "immutable evidence",
      (value: ReturnType<typeof captureCandidate>) =>
        (value.capture.custody.evidenceSha256 = `sha256:${"0".repeat(64)}`),
    ],
  ])("rejects capture %s tampering", (_name, tamper) => {
    const value = captureCandidate();
    tamper(value);
    expect(() =>
      assertActivationCatalogPolicyCaptureBinding(
        value.capture,
        value.policies,
      ),
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

function post000079CapturedPolicies() {
  const policies = structuredClone(
    canonicalActivationCatalogPolicyArtifact.policies,
  );
  const resource =
    "routine:public.codex_oauth_reattest_active_namespace_v4_to_v5(pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.int8,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.int4,pg_catalog.int4,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text)";
  for (const policy of [policies.preactivation, policies.activated]) {
    policy.grants.push({
      principal: "reviewrouter_web",
      capability: "routine:execute",
      resource,
      source: "privilege",
      grantable: false,
      grantor: "reviewrouter_release_schema_owner",
    });
    policy.grants.sort((left, right) => {
      const leftKey = [
        left.principal,
        left.capability,
        left.resource,
        left.source,
        left.grantable ? "1" : "0",
        left.grantor,
      ].join("\0");
      const rightKey = [
        right.principal,
        right.capability,
        right.resource,
        right.source,
        right.grantable ? "1" : "0",
        right.grantor,
      ].join("\0");
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
    const web = policy.effectivePermissions.find(
      (entry) => entry.principal === "reviewrouter_web",
    );
    web?.permissions.push({ capability: "routine:execute", resource });
    web?.permissions.sort((left, right) => {
      const leftKey = `${left.capability}\0${left.resource}`;
      const rightKey = `${right.capability}\0${right.resource}`;
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
  }
  return policies;
}
