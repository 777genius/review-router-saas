import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assertReleaseMigrationTransition,
  assertReleaseMigrationTransitionIntegrity,
  assertReleaseMigrationObservation,
  canonicalReleaseMigrationArtifact,
  canonicalReleaseMigrationEntries,
  canonicalReleaseMigrationPostManifestIdentity,
  canonicalReleaseMigrationResumeManifestIdentities,
  createReleaseMigrationTransition,
  deriveOrderedPendingEntriesSha256,
  historicalReleaseMigrationPostCatalogDigest,
} from "./release-migration-transition";
import { activationCatalogRawPromotionTrustRoot } from "./activation-catalog-policy-raw-promotion-trust-root";
import {
  fencedLiveV70V73CatalogDigestSql,
  liveV70V89CatalogProjectionRelations,
  liveV70V89CatalogProjectionRoutines,
} from "../adapters/live-v70-v72-catalog-digest.mjs";

import { canonicalPrismaMigrationNames } from "../../../../../scripts/lib/canonical-prisma-migration-catalog.mjs";
import {
  assertRenderSchemaHandoffCatalog,
  readRenderSchemaHandoffCatalog,
  readReviewedRenderManagedContract,
  renderManagedMigrationPhases,
} from "../../../../../scripts/lib/render-schema-handoff-policy.mjs";

const migrationRoot = "packages/platform/db/prisma/migrations";
const sha256 = (value: string | Buffer) =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;
const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const item = value as Record<string, unknown>;
  return `{${Object.keys(item)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(item[key])}`)
    .join(",")}}`;
};

describe("canonical release migration transition", () => {
  it("pins SQL96 and the exact canonical96 identities without changing the pre-manifest", () => {
    expect(canonicalReleaseMigrationEntries).toHaveLength(20);
    expect(canonicalReleaseMigrationEntries.at(-1)).toEqual({
      migrationName: "000096_hosted_pool_public_repository_eligibility",
      migrationSqlSha256:
        "d1b49b764f406004227f3af9e23e3a4b36268b73d76f8e7b19828d508d8c8826",
    });
    const names = canonicalReleaseMigrationEntries.map(
      (entry) => entry.migrationName,
    );
    expect(names).toEqual([...new Set(names)].sort());
    expect(canonicalReleaseMigrationArtifact).toMatchObject({
      preManifestIdentity:
        "sha256:c0ab0520ee922e695b2954f0a0af81ffd0ad6fb57f41ec3ddc124fe7c8a781eb",
      migrationArtifactDigest:
        "sha256:d73617e2645fe2796f784c024a826a57343f20e7ea66187ec3dc0fd6c5a4d7ca",
      migrationBundleSha256:
        "sha256:2438821c79ae824a083147a750867a0eb876c0632b0e6afe4cce99e0bba24e22",
      postManifestIdentity:
        "sha256:5faad7059a2f57055086dd1571e87706c261a486e8952334401f1d91cc41c97b",
    });
  });

  it("is generated from the exact checked-in migration SQL bytes", () => {
    const entries = canonicalReleaseMigrationEntries.map((entry) => {
      const bytes = readFileSync(
        `${migrationRoot}/${entry.migrationName}/migration.sql`,
      );
      expect(sha256(bytes)).toBe(`sha256:${entry.migrationSqlSha256}`);
      return entry;
    });
    expect(sha256(canonicalJson(entries))).toBe(
      canonicalReleaseMigrationArtifact.migrationArtifactDigest,
    );
    const framed = canonicalReleaseMigrationEntries.map((entry) => {
      const bytes = readFileSync(
        `${migrationRoot}/${entry.migrationName}/migration.sql`,
      );
      return Buffer.concat([
        Buffer.from(`${entry.migrationName}\0${bytes.length}\0`),
        bytes,
      ]);
    });
    expect(sha256(Buffer.concat(framed))).toBe(
      canonicalReleaseMigrationArtifact.migrationBundleSha256,
    );
  });

  it("keeps canonical96 checkout admission separate from managed92 authority", () => {
    type Row = { migrationName: string; checksum: string };
    const names: readonly string[] = canonicalPrismaMigrationNames;
    const full = names.map((migrationName) => ({
      migrationName,
      checksum: sha256(
        readFileSync(`${migrationRoot}/${migrationName}/migration.sql`),
      ).slice(7),
    }));
    const manifest = (rows: readonly Row[]) =>
      sha256(
        rows.map((row) => `${row.migrationName}:${row.checksum}`).join(","),
      );
    const managed: readonly Row[] = readRenderSchemaHandoffCatalog();
    expect(full).toHaveLength(96);
    expect(manifest(full)).toBe(canonicalReleaseMigrationPostManifestIdentity);
    expect(full.slice(0, 92)).toEqual(managed);
    expect(full.slice(-4)).toEqual(
      canonicalReleaseMigrationEntries
        .slice(-4)
        .map(({ migrationName, migrationSqlSha256: checksum }) => ({
          migrationName,
          checksum,
        })),
    );
    expect(managed).toHaveLength(92);
    expect(() => assertRenderSchemaHandoffCatalog(managed)).not.toThrow();
    expect(() => assertRenderSchemaHandoffCatalog(full)).toThrow(
      "migration_catalog",
    );
    for (const phase of [
      "managed-retained-upgrade",
      "managed-schema-handoff",
    ] as const) {
      const contract = renderManagedMigrationPhases[phase];
      expect(manifest(managed.slice(0, contract.baselineCount))).toBe(
        contract.baselineManifest,
      );
      expect(manifest(managed.slice(0, contract.targetCount))).toBe(
        contract.targetManifest,
      );
      expect(() => readReviewedRenderManagedContract(phase)).toThrow(
        "managed_independent_review_missing",
      );
    }
    expect(canonicalReleaseMigrationArtifact.preManifestIdentity).not.toBe(
      manifest(managed.slice(0, 76)),
    );
    expect(canonicalReleaseMigrationEntries).toHaveLength(20);
    expect(canonicalReleaseMigrationResumeManifestIdentities).toEqual([
      canonicalReleaseMigrationArtifact.preManifestIdentity,
      manifest(full),
    ]);
    expect(canonicalReleaseMigrationResumeManifestIdentities).not.toContain(
      manifest(managed),
    );
  });

  it("accepts only the trusted pre-manifest and completed post-manifest replay", () => {
    const pending = new Set<string>(
      canonicalReleaseMigrationEntries.map((entry) => entry.migrationName),
    );
    const installed = readdirSync(migrationRoot)
      .filter((name) => /^\d{6}_[a-z0-9_]+$/u.test(name))
      .filter((name) => !pending.has(name))
      .map(
        (name) =>
          [
            name,
            createHash("sha256")
              .update(readFileSync(`${migrationRoot}/${name}/migration.sql`))
              .digest("hex"),
          ] as const,
      );
    const root = () =>
      sha256(
        [...installed]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([name, checksum]) => `${name}:${checksum}`)
          .join(","),
      );
    const roots = [root()];
    for (const entry of canonicalReleaseMigrationEntries) {
      installed.push([entry.migrationName, entry.migrationSqlSha256]);
      roots.push(root());
    }
    expect(canonicalReleaseMigrationResumeManifestIdentities).toEqual([
      roots[0],
      roots.at(-1),
    ]);
    for (const partialRoot of roots.slice(1, -1))
      expect(canonicalReleaseMigrationResumeManifestIdentities).not.toContain(
        partialRoot,
      );
  });

  it("rejects any worker alteration of a server-trusted transition", () => {
    const trusted = createReleaseMigrationTransition({
      commitSha: "d".repeat(40),
      releaseImageDigest: `sha256:${"e".repeat(64)}`,
    });
    expect(() =>
      assertReleaseMigrationTransition(trusted, trusted),
    ).not.toThrow();
    expect(() =>
      assertReleaseMigrationTransition(
        { ...trusted, postManifestIdentity: `sha256:${"f".repeat(64)}` },
        trusted,
      ),
    ).toThrow("release_migration_transition_untrusted");
  });

  it.each([
    "reordered",
    "checksum drift",
    "SQL96 omitted",
    "duplicate",
    "unknown SQL",
    "newer SQL",
  ])("rejects %s even when transport digests are recomputed", (alteration) => {
    const trusted = createReleaseMigrationTransition({
      commitSha: "d".repeat(40),
      releaseImageDigest: `sha256:${"e".repeat(64)}`,
    });
    const entries = [...trusted.orderedMigrationEntries];
    const sql96 = entries.pop()!;
    switch (alteration) {
      case "reordered":
        entries.unshift(sql96);
        break;
      case "checksum drift":
        entries.push({ ...sql96, migrationSqlSha256: "f".repeat(64) });
        break;
      case "SQL96 omitted":
        break;
      case "duplicate":
        entries.push(sql96, sql96);
        break;
      case "unknown SQL":
        entries.push({ ...sql96, migrationName: "000096_unknown_sql" });
        break;
      case "newer SQL":
        entries.push(sql96, { ...sql96, migrationName: "000097_unknown_sql" });
        break;
    }
    const unsigned = {
      ...trusted,
      orderedMigrationEntries: entries,
      orderedPendingEntriesSha256: deriveOrderedPendingEntriesSha256(entries),
      migrationArtifactDigest: sha256(canonicalJson(entries)),
    };
    Reflect.deleteProperty(unsigned, "transitionSha256");
    const altered = {
      ...unsigned,
      transitionSha256: sha256(canonicalJson(unsigned)),
    };
    expect(() =>
      assertReleaseMigrationTransitionIntegrity(altered),
    ).not.toThrow();
    expect(() => assertReleaseMigrationTransition(altered, trusted)).toThrow(
      "release_migration_transition_untrusted",
    );
  });

  it("derives the ordered-pending digest and rejects an independently supplied value", () => {
    const trusted = createReleaseMigrationTransition({
      commitSha: "d".repeat(40),
      releaseImageDigest: `sha256:${"e".repeat(64)}`,
    });
    expect(trusted.orderedPendingEntriesSha256).toBe(
      "sha256:12d2486941e14109803908a21c3da47d3a241eaea88e6e3bf5e7944d1471f73a",
    );
    expect(trusted.orderedPendingEntriesSha256).toBe(
      deriveOrderedPendingEntriesSha256(trusted.orderedMigrationEntries),
    );
    expect(trusted.orderedPendingEntriesSha256).not.toBe(
      trusted.migrationArtifactDigest,
    );
    expect(
      deriveOrderedPendingEntriesSha256(
        [...trusted.orderedMigrationEntries].reverse(),
      ),
    ).not.toBe(trusted.orderedPendingEntriesSha256);
    expect(() =>
      assertReleaseMigrationTransition(
        {
          ...trusted,
          orderedPendingEntriesSha256: `sha256:${"f".repeat(64)}`,
        },
        trusted,
      ),
    ).toThrow("release_migration_transition_untrusted");
  });

  it("derives catalog trust from the production root with only the historical pending fallback", () => {
    expect(canonicalReleaseMigrationArtifact.postCatalogDigest).toBe(
      activationCatalogRawPromotionTrustRoot.status === "ready"
        ? activationCatalogRawPromotionTrustRoot.evidence.liveCatalogDigest
        : historicalReleaseMigrationPostCatalogDigest,
    );
    if (activationCatalogRawPromotionTrustRoot.status === "pending")
      expect(canonicalReleaseMigrationArtifact.postCatalogDigest).toBe(
        "sha256:6ecfc9b47b47a6351f72c6f9793df3f408b2b33a275158f5499b09c10a6c048d",
      );
  });

  it("binds the live history projection to the canonical post-manifest identity", () => {
    expect(canonicalReleaseMigrationArtifact.postManifestIdentity).toBe(
      canonicalReleaseMigrationPostManifestIdentity,
    );
    expect(fencedLiveV70V73CatalogDigestSql).toContain(
      `= '${canonicalReleaseMigrationArtifact.postManifestIdentity}'`,
    );
    expect(fencedLiveV70V73CatalogDigestSql).not.toContain(
      "sha256:28941cb847006d45d798db0a363f3ba8a63454b4255e95632b69e4767769eb8e",
    );
  });

  it("projects the complete V89 authority, custody, ACL, and replay catalog", () => {
    expect(liveV70V89CatalogProjectionRelations).toEqual([
      "CodexOAuthWritebackIntent",
      "CodexOAuthSecretNamespace",
      "CodexOAuthProviderInstance",
      "RepositoryConnection",
      "CodexOAuthSetupDispatchAttempt",
      "CodexOAuthSetupPayloadClaim",
      "CodexOAuthDatabaseAuthorityReceipt",
      "CodexOAuthWorkflowCompatibility",
      "RuntimeGenerationWitnessProof",
      "RuntimeCanaryChallenge",
      "RuntimeCanaryChallengeProof",
      "HostedCodexCommentTokenMint",
      "HostedCodexCommentTokenRevocationProof",
      "HostedCodexRuntimeClosure",
      "HostedCodexCommentRefreshUse",
      "HostedCodexRuntimeGate",
      "HostedCodexRepositoryBinding",
      "HostedCodexPool",
      "GitHubInstallation",
      "HostedCodexInvocationGrant",
      "HostedCodexCommentRefreshCapability",
    ]);
    expect(liveV70V89CatalogProjectionRoutines).toEqual([
      "reviewrouter_record_runtime_generation_witness_proof",
      "reviewrouter_read_runtime_generation_witness_proofs",
      "reviewrouter_runtime_generation_write_read_canary",
      "reviewrouter_request_runtime_canary_challenge",
      "reviewrouter_answer_runtime_canary_challenge",
      "reviewrouter_read_runtime_canary_challenge_proofs",
      "codex_oauth_v4_v5_reattestation_transition",
      "codex_oauth_reattest_active_namespace_v4_to_v5",
      "codex_oauth_secret_namespace_tombstone_guard",
      "codex_oauth_consume_database_authority",
      "codex_oauth_database_authority_receipt_guard",
      "codex_oauth_workflow_compatibility_guard",
      "hosted_codex_comment_refresh_use_mint_guard",
      "hosted_codex_comment_token_mint_guard",
      "hosted_codex_comment_token_prepare_authority_complete",
      "hosted_codex_lock_comment_token_runtime_gate",
      "hosted_codex_comment_token_authority_snapshot",
      "hosted_codex_lock_comment_token_mint",
      "hosted_codex_mutate_comment_token_mint",
      "hosted_codex_mutate_comment_token_mint_v83",
      "hosted_codex_mutate_comment_token_mint_v85",
      "hosted_codex_claim_comment_token_delivery",
      "hosted_codex_finalize_comment_token_revocation",
      "hosted_codex_runtime_closure_guard",
      "hosted_codex_runtime_gate_guard",
      "hosted_codex_runtime_gate_activation_barrier",
      "hosted_codex_comment_token_authority_revoke_enqueue",
    ]);
    expect(fencedLiveV70V73CatalogDigestSql).toContain("'acl',coalesce");
    expect(fencedLiveV70V73CatalogDigestSql).toContain("'triggers',coalesce");
    expect(canonicalReleaseMigrationArtifact.postCatalogDigest).toBe(
      activationCatalogRawPromotionTrustRoot.status === "ready"
        ? activationCatalogRawPromotionTrustRoot.evidence.liveCatalogDigest
        : historicalReleaseMigrationPostCatalogDigest,
    );
  });

  it("binds the target observation to the source inventory and fixed cutoff", () => {
    const transition = createReleaseMigrationTransition({
      commitSha: "d".repeat(40),
      releaseImageDigest: `sha256:${"e".repeat(64)}`,
    });
    const inventorySha256 =
      "sha256:ee9ab3e1f9d9f0e88e96addb3a20b70a04a166f0d979fd5ce3fc59e1dcdbf55f";
    const sourceLegacyAmbiguityUnsigned = {
      schemaVersion: 1 as const,
      rolloutId: "rollout-binding",
      sourceSystemIdentifier: "1",
      sourceDatabaseName: "reviewrouter",
      sourceRecoveryWitnessSha256: "b".repeat(64),
      authorityPrincipal: "source_admin",
      fenceId: "source-fence:rollout-binding",
      fenceEstablishedAt: "2026-08-15T00:00:00.000Z",
      fencedInventorySha256: `sha256:${"f".repeat(64)}`,
      inventorySha256,
      activeLeaseIds: [],
      fetchedSetupIds: [],
      pendingIntentIds: [],
      intentStatuses: [],
      observations: [
        { observedAt: "2026-08-15T00:00:01.000Z", inventorySha256 },
        { observedAt: "2026-08-15T00:00:02.000Z", inventorySha256 },
      ] as const,
      eligibilityCutoff: "2026-08-15T00:00:02.000Z",
      stable: true as const,
    };
    const permit = {
      schemaVersion: 1 as const,
      rolloutId: "rollout-binding",
      runId: "1",
      runAttempt: 1,
      targetSystemIdentifier: "2",
      targetRecoveryWitnessSha256: "a".repeat(64),
      transitionSha256: transition.transitionSha256,
      expectedPreviousReceiptSha256: `sha256:${"0".repeat(64)}`,
      sourceLegacyAmbiguity: {
        ...sourceLegacyAmbiguityUnsigned,
        receiptSha256: sha256(canonicalJson(sourceLegacyAmbiguityUnsigned)),
      },
      eligibilityCutoff: "2026-08-15T00:00:02.000Z",
      epoch: 1,
      nonce: "b".repeat(32),
    };
    const observation = {
      transitionSha256: transition.transitionSha256,
      migrationArtifactDigest: transition.migrationArtifactDigest,
      migrationBundleSha256: transition.migrationBundleSha256,
      preManifestIdentity: transition.preManifestIdentity,
      postManifestIdentity: transition.postManifestIdentity,
      postCatalogDigest: transition.postCatalogDigest,
      permitEpoch: 1,
      permitNonce: permit.nonce,
      targetSystemIdentifier: permit.targetSystemIdentifier,
      targetRecoveryWitnessSha256: permit.targetRecoveryWitnessSha256,
      sourceLegacyAmbiguitySha256: inventorySha256,
      eligibilityCutoff: permit.eligibilityCutoff,
    };
    expect(() =>
      assertReleaseMigrationObservation(observation, transition, permit),
    ).not.toThrow();
    expect(() =>
      assertReleaseMigrationObservation(
        { ...observation, eligibilityCutoff: "2026-08-15T00:00:03.000Z" },
        transition,
        permit,
      ),
    ).toThrow("release_migration_observation_binding_invalid");
    expect(() =>
      assertReleaseMigrationObservation(
        {
          ...observation,
          sourceLegacyAmbiguitySha256: `sha256:${"f".repeat(64)}`,
        },
        transition,
        permit,
      ),
    ).toThrow("release_migration_observation_binding_invalid");
  });
});
