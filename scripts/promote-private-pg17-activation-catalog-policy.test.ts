import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  activationCatalogArtifactPath,
  activationCatalogRawPromotionTrustRoot,
  activationCatalogPromotionOptIn,
  activationCatalogPromotionProvenancePath,
  assertActivationCatalogPolicyReviewedSourceBindings,
  assertArtifactCandidate,
  assertActivationCatalogPolicyIndependentReviewEvidence,
  assertReviewedActivationCatalogPromotionProvenance,
  canonicalActivationCatalogArtifactSourceFromRawCapture,
  promotePrivatePg17ActivationCatalogPolicy,
  reviewedActivationCatalogCandidate,
} from "./promote-private-pg17-activation-catalog-policy.mjs";
import canonicalActivationCatalogPolicyArtifact from "../packages/features/release-rollout/src/domain/activation-catalog-policy-artifact.generated.js";
import { assertActivationCatalogLiveDigestTransitionBinding } from "../packages/features/release-rollout/src/domain/activation-catalog-policy-promotion-expectation";
import { canonicalReleaseMigrationArtifact } from "../packages/features/release-rollout/src/domain/release-migration-transition";
import { sha256Canonical } from "../packages/features/release-rollout/src/domain/canonical-json";
import { assertActivationCatalogRawPromotionTrustRootReady } from "../packages/features/release-rollout/src/domain/activation-catalog-policy-raw-promotion-trust-root";

// Pure serialization fixture; this provides no capture or promotion authority.
async function artifactBindingFixture() {
  const source = await readFile(activationCatalogArtifactPath);
  return {
    canonicalDigests: {
      preactivation: `sha256:${sha256Canonical(canonicalActivationCatalogPolicyArtifact.policies.preactivation)}`,
      activated: `sha256:${sha256Canonical(canonicalActivationCatalogPolicyArtifact.policies.activated)}`,
      artifact: `sha256:${sha256Canonical(canonicalActivationCatalogPolicyArtifact)}`,
    },
    generatedArtifactSource: {
      bytes: source.byteLength,
      sha256: createHash("sha256").update(source).digest("hex"),
    },
  };
}

describe("activation catalog policy promotion", () => {
  it("pins the exact reviewed v29 candidate and operator opt-in", () => {
    expect(activationCatalogPromotionOptIn).toBe(
      "promote-reviewed-activation-catalog-v29-schema-v5-pr245",
    );
    expect(reviewedActivationCatalogCandidate).toEqual({
      sha256:
        "b138eb3ece6553d505debff1dc978a9b6fd8ea854cf70c037c05e364b3d0aa28",
      bytes: 2_651_682,
      liveCatalogDigest:
        "sha256:6ecfc9b47b47a6351f72c6f9793df3f408b2b33a275158f5499b09c10a6c048d",
      liveCatalogProjectionSourceSha256:
        "39e855060bfc186c6fb92fe1cd5c72410f8f72802200da49d6c1fe45eb6ed5f4",
      normalizationSourceSha256:
        "7b23d64a1f2160398cdeb9194b0a3f3583e5566a1b20a0b2009caaf7ddbe0da1",
      preactivationCatalogPolicySha256:
        "sha256:87266972e7979bb15464f470f1cb94c1cf8fee3f8ec62d36c8c866328e52925b",
      activatedCatalogPolicySha256:
        "sha256:cc35c6b43fe8b117a492705eeaf2ab9a9ac0e05f98546fa32ac9d340df89867b",
      artifactCanonicalSha256:
        "sha256:5d7a98bf13e65ab8071691086efb792699b994961caadf435ee9fd4845c2f1cf",
    });
  });

  it("supersedes the legacy entrypoint before candidate reads or writes", async () => {
    const artifactBefore = await readFile(activationCatalogArtifactPath);
    await expect(
      promotePrivatePg17ActivationCatalogPolicy({
        env: {
          REVIEW_ROUTER_ACTIVATION_CATALOG_PROMOTION:
            activationCatalogPromotionOptIn,
        },
        argv: ["--candidate", "/does/not/exist", "--write"],
      }),
    ).rejects.toThrow("activation_catalog_policy_legacy_promotion_superseded");
    expect(
      (await readFile(activationCatalogArtifactPath)).equals(artifactBefore),
    ).toBe(true);
  });

  it("loads the exact code-owned raw promotion mode", () => {
    if (activationCatalogRawPromotionTrustRoot.status === "pending")
      expect(activationCatalogRawPromotionTrustRoot).toEqual({
        status: "pending",
        reason:
          "fresh-authenticated-raw-capture-and-independent-review-required",
      });
    else
      expect(activationCatalogRawPromotionTrustRoot).toMatchObject({
        status: "ready",
        evidence: { reviewResult: "GO" },
      });
  });

  it("binds all policy digests and source bytes during artifact serialization", async () => {
    const generated = canonicalActivationCatalogArtifactSourceFromRawCapture(
      { policies: canonicalActivationCatalogPolicyArtifact.policies },
      await artifactBindingFixture(),
    );

    expect(
      generated.equals(await readFile(activationCatalogArtifactPath)),
    ).toBe(true);
  });

  it("fails closed for independently drifted raw artifact bindings", async () => {
    const evidence = await artifactBindingFixture();
    const mismatch = `sha256:${"0".repeat(64)}`;
    const driftedBindings = [
      [
        "canonicalDigests",
        "preactivation",
        mismatch,
        "activation_catalog_policy_promotion_phase_digest_drift",
      ],
      [
        "canonicalDigests",
        "activated",
        mismatch,
        "activation_catalog_policy_promotion_phase_digest_drift",
      ],
      [
        "canonicalDigests",
        "artifact",
        mismatch,
        "activation_catalog_policy_promotion_artifact_drift",
      ],
      [
        "generatedArtifactSource",
        "bytes",
        evidence.generatedArtifactSource.bytes + 1,
        "activation_catalog_policy_generated_source_drift",
      ],
      [
        "generatedArtifactSource",
        "sha256",
        "0".repeat(64),
        "activation_catalog_policy_generated_source_drift",
      ],
    ] as const;

    for (const [section, key, value, error] of driftedBindings) {
      const driftedEvidence = structuredClone(evidence);
      Object.assign(driftedEvidence[section], { [key]: value });
      expect(
        () =>
          canonicalActivationCatalogArtifactSourceFromRawCapture(
            { policies: canonicalActivationCatalogPolicyArtifact.policies },
            driftedEvidence,
          ),
        `${section}.${key}`,
      ).toThrow(error);
    }
  });

  it("requires reviewed raw authority before trusting the live digest", () => {
    if (activationCatalogRawPromotionTrustRoot.status === "pending") {
      expect(() =>
        assertActivationCatalogRawPromotionTrustRootReady(
          activationCatalogRawPromotionTrustRoot,
        ),
      ).toThrow("activation_catalog_policy_raw_trust_root_pending");
      return;
    }
    const liveCatalogDigest =
      activationCatalogRawPromotionTrustRoot.evidence.liveCatalogDigest;

    expect(() =>
      assertActivationCatalogLiveDigestTransitionBinding(
        liveCatalogDigest,
        canonicalReleaseMigrationArtifact.postCatalogDigest,
      ),
    ).not.toThrow();
    expect(() =>
      assertActivationCatalogLiveDigestTransitionBinding(
        `sha256:${"0".repeat(64)}`,
        canonicalReleaseMigrationArtifact.postCatalogDigest,
      ),
    ).toThrow("activation_catalog_policy_live_digest_transition_drift");
  });

  it("rejects caller-supplied raw authority at the CLI gate without writing", async () => {
    const artifactBefore = await readFile(activationCatalogArtifactPath);
    await expect(
      promotePrivatePg17ActivationCatalogPolicy({
        env: {
          REVIEW_ROUTER_ACTIVATION_CATALOG_PROMOTION:
            "promote-authenticated-CALLER-FORGED-GO",
        },
        argv: [
          "--capture-1",
          "/does/not/exist-1",
          "--capture-2",
          "/does/not/exist-2",
          "--authenticated-evidence",
          "/caller/forged.json",
          "--write",
        ],
      }),
    ).rejects.toThrow("activation_catalog_policy_promotion_arguments_invalid");
    expect(
      (await readFile(activationCatalogArtifactPath)).equals(artifactBefore),
    ).toBe(true);
  });

  it("uses the loaded code-owned raw root before reading captures", async () => {
    const artifactBefore = await readFile(activationCatalogArtifactPath);
    const attempt = promotePrivatePg17ActivationCatalogPolicy({
      env: {},
      argv: [
        "--capture-1",
        "/does/not/exist-1",
        "--capture-2",
        "/does/not/exist-2",
        ...(activationCatalogRawPromotionTrustRoot.status === "ready"
          ? ["--raw-opt-in", "wrong-opt-in"]
          : []),
        "--write",
      ],
    });
    if (activationCatalogRawPromotionTrustRoot.status === "pending")
      await expect(attempt).rejects.toThrow(
        "activation_catalog_policy_raw_trust_root_pending",
      );
    else
      await expect(attempt).rejects.toThrow(
        "activation_catalog_policy_raw_opt_in_required",
      );
    expect(
      (await readFile(activationCatalogArtifactPath)).equals(artifactBefore),
    ).toBe(true);
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

  it.each([
    ["missing", undefined],
    ["wrong", `sha256:${"b".repeat(64)}`],
  ])(
    "rejects a %s reviewed live catalog digest",
    (_name, liveCatalogDigest) => {
      const candidate = {
        kind: "reviewrouter-activation-catalog-policy-artifact-candidate",
        version: 2,
        ...(liveCatalogDigest === undefined ? {} : { liveCatalogDigest }),
        policies: canonicalActivationCatalogPolicyArtifact.policies,
      };

      expect(() =>
        assertArtifactCandidate(candidate, {
          ...reviewedActivationCatalogCandidate,
          liveCatalogDigest: `sha256:${"a".repeat(64)}`,
        }),
      ).toThrow("activation_catalog_policy_promotion_candidate_invalid");
    },
  );

  it("accepts the exact reviewed live catalog digest", () => {
    const liveCatalogDigest = `sha256:${"a".repeat(64)}`;
    expect(() =>
      assertArtifactCandidate(
        {
          kind: "reviewrouter-activation-catalog-policy-artifact-candidate",
          version: 2,
          liveCatalogDigest,
          policies: canonicalActivationCatalogPolicyArtifact.policies,
        },
        { ...reviewedActivationCatalogCandidate, liveCatalogDigest },
      ),
    ).not.toThrow();
  });

  it("fails closed when reviewed projection source bindings drift", async () => {
    await expect(
      assertActivationCatalogPolicyReviewedSourceBindings(),
    ).rejects.toThrow("activation_catalog_policy_reviewed_source_drift");
  });

  it("refuses promotion without exact independent GO evidence", () => {
    expect(() =>
      assertReviewedActivationCatalogPromotionProvenance({
        status: "ready",
        independentReview: { result: "NO-GO" },
      }),
    ).toThrow("activation_catalog_policy_promotion_provenance_invalid");
  });

  it("accepts the exact ready provenance and both materialized reviews", async () => {
    const provenance = JSON.parse(
      await readFile(activationCatalogPromotionProvenancePath, "utf8"),
    );
    expect(() =>
      assertReviewedActivationCatalogPromotionProvenance(provenance),
    ).not.toThrow();
    await expect(
      assertActivationCatalogPolicyIndependentReviewEvidence(provenance),
    ).resolves.toBeUndefined();
  });
});
