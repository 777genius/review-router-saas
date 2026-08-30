import { createHash } from "node:crypto";
import {
  copyFile,
  mkdtemp,
  readFile,
  rm,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  activationCatalogArtifactPath,
  activationCatalogPromotionOptIn,
  activationCatalogPromotionProvenancePath,
  assertActivationCatalogPolicyReviewedSourceBindings,
  assertArtifactCandidate,
  assertActivationCatalogPolicyIndependentReviewEvidence,
  assertReviewedActivationCatalogPromotionProvenance,
  promotePrivatePg17ActivationCatalogPolicy,
  reviewedActivationCatalogCandidate,
  reviewedActivationCatalogCandidatePath,
} from "./promote-private-pg17-activation-catalog-policy.mjs";
import canonicalActivationCatalogPolicyArtifact from "../packages/features/release-rollout/src/domain/activation-catalog-policy-artifact.generated.js";
import { assertActivationCatalogLiveDigestTransitionBinding } from "../packages/features/release-rollout/src/domain/activation-catalog-policy-promotion-expectation";
import { canonicalReleaseMigrationArtifact } from "../packages/features/release-rollout/src/domain/release-migration-transition";

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

  it("fails closed when the candidate and migration transition digests diverge", () => {
    expect(() =>
      assertActivationCatalogLiveDigestTransitionBinding(
        reviewedActivationCatalogCandidate.liveCatalogDigest,
        canonicalReleaseMigrationArtifact.postCatalogDigest,
      ),
    ).not.toThrow();
    expect(() =>
      assertActivationCatalogLiveDigestTransitionBinding(
        reviewedActivationCatalogCandidate.liveCatalogDigest,
        `sha256:${"f".repeat(64)}`,
      ),
    ).toThrow("activation_catalog_policy_live_digest_transition_drift");
  });

  it("binds review authorization to the exact projection and normalization sources", async () => {
    await expect(
      assertActivationCatalogPolicyReviewedSourceBindings(),
    ).resolves.toBeUndefined();
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

  it("verifies the complete opt-in orchestration without writing", async () => {
    const artifactBefore = await readFile(activationCatalogArtifactPath);
    const result = await promotePrivatePg17ActivationCatalogPolicy({
      env: {
        REVIEW_ROUTER_ACTIVATION_CATALOG_PROMOTION:
          activationCatalogPromotionOptIn,
      },
      argv: ["--candidate", reviewedActivationCatalogCandidatePath],
    });
    const artifactAfter = await readFile(activationCatalogArtifactPath);

    expect(result).toEqual({
      mode: "verified",
      candidatePath: reviewedActivationCatalogCandidatePath,
      candidateSha256:
        "b138eb3ece6553d505debff1dc978a9b6fd8ea854cf70c037c05e364b3d0aa28",
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
      artifactPath: activationCatalogArtifactPath,
      artifactSourceSha256:
        "cc9be40be941b6291013cdf921afa6db84ad9e615b988fe8ff7a24a387566fc3",
      artifactCanonicalSha256:
        "sha256:5d7a98bf13e65ab8071691086efb792699b994961caadf435ee9fd4845c2f1cf",
    });
    expect(artifactAfter).toEqual(artifactBefore);
    expect(createHash("sha256").update(artifactAfter).digest("hex")).toBe(
      "cc9be40be941b6291013cdf921afa6db84ad9e615b988fe8ff7a24a387566fc3",
    );
  }, 60_000);

  it.each(["missing", "truncated", "modified"] as const)(
    "fails closed for %s repository evidence without writing",
    async (failure) => {
      const temporaryDirectory = await mkdtemp(
        join(tmpdir(), "reviewrouter-pr245-candidate-"),
      );
      const candidatePath = join(temporaryDirectory, "candidate.json");
      const artifactBefore = await readFile(activationCatalogArtifactPath);
      try {
        if (failure !== "missing") {
          await copyFile(reviewedActivationCatalogCandidatePath, candidatePath);
          if (failure === "truncated") await truncate(candidatePath, 2_651_681);
          else {
            const modified = await readFile(candidatePath);
            modified[Math.floor(modified.byteLength / 2)] ^= 1;
            await writeFile(candidatePath, modified);
          }
        }

        const attempt = promotePrivatePg17ActivationCatalogPolicy({
          env: {
            REVIEW_ROUTER_ACTIVATION_CATALOG_PROMOTION:
              activationCatalogPromotionOptIn,
          },
          argv: ["--candidate", candidatePath],
        });
        if (failure === "missing")
          await expect(attempt).rejects.toMatchObject({ code: "ENOENT" });
        else
          await expect(attempt).rejects.toThrow(
            `activation_catalog_policy_promotion_candidate_${
              failure === "truncated" ? "size" : "hash"
            }_drift`,
          );
        expect(await readFile(activationCatalogArtifactPath)).toEqual(
          artifactBefore,
        );
      } finally {
        await rm(temporaryDirectory, { recursive: true, force: true });
      }
    },
    180_000,
  );
});
