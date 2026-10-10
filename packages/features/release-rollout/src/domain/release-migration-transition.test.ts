import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
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
  readRenderManagedCheckoutInventory,
  readReviewedRenderManagedContract,
  renderManagedMigrationPhases,
} from "../../../../../scripts/lib/render-schema-handoff-policy.mjs";

import { readRenderHistorical96CheckoutInventory } from "../../../../../scripts/lib/render-historical96-checkout.mjs";

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

  it("keeps full125 source admission separate from historical96 and managed92 authority", () => {
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
    expect(full).toHaveLength(125);
    expect(manifest(full)).toBe(
      "sha256:fcd4d6ea3f95504edfd4485185ccfd4b139349509083cf67d188786dd57d97ae",
    );
    const historicalFull = full.filter(
      (row) => row.migrationName !== "000125_hosted_codex_device_reconnect",
    );
    expect(historicalFull).toHaveLength(124);
    expect(manifest(historicalFull)).toBe(
      "sha256:f9d5fc4e689c9373e0b1a56e8e41aa71af2d247bb55227ca4394b13a5d52b398",
    );
    expect(full).toEqual(readRenderManagedCheckoutInventory());
    expect(full.slice(-18).map((row) => row.migrationName)).toEqual([
      "000109_sdk_growth_verifier_assignment_lock",
      "000110_historical_unknown_scope_barrier",
      "000110_provider_api_key_workspace_management",
      "000111_sdk_growth_source_binding",
      "000112_sdk_growth_operator_credential",
      "000113_sdk_growth_approval_ledger",
      "000114_sdk_growth_v3_tool_artifact",
      "000115_sdk_growth_v3_approved_manifest",
      "000116_hosted_codex_relay_admission_utc",
      "000117_provider_accounts",
      "000118_workspace_binding_fences",
      "000119_review_configuration_gateway_binding",
      "000120_review_run_runtime_snapshot",
      "000121_review_run_gateway_execution_binding",
      "000122_review_configuration_operation_receipt",
      "000123_personal_workspace_identity",
      "000124_personal_account_operations",
      "000125_hosted_codex_device_reconnect",
    ]);
    const withoutProviderKey = historicalFull.filter(
      (row) =>
        row.migrationName !== "000110_provider_api_key_workspace_management",
    );
    expect(withoutProviderKey).toHaveLength(123);
    expect(manifest(withoutProviderKey)).toBe(
      "sha256:f26da08b44ad6830f4486f93ed33979acda7b5669a8550601c34dbf9c0322443",
    );
    expect(manifest(full.slice(0, 116))).toBe(
      "sha256:495a040aeb13c5fc43ea611546be10c9e5edcf519c67bc1f5e40d797f6c50538",
    );
    expect(manifest(withoutProviderKey.slice(0, 122))).toBe(
      "sha256:5629630be035cbf1677692e840bc07c7292729bfb5bfc0c242f38179f3230df4",
    );
    expect(manifest(withoutProviderKey.slice(0, 121))).toBe(
      "sha256:858537d185e32ef6258ddf674b5a201e6cc0c4e44fa948a18af23d6dd55905ec",
    );
    expect(manifest(withoutProviderKey.slice(0, 120))).toBe(
      "sha256:5f01c4416620cf984ffa5fee8dbb26bcf171ae3a89ec4e4b8615e4c7c8461c64",
    );
    expect(manifest(withoutProviderKey.slice(0, 119))).toBe(
      "sha256:f998e11bee1748adecf31dc07ec61d59b55ead60b2734a71f90065d3f9f4aa6b",
    );
    expect(manifest(withoutProviderKey.slice(0, 118))).toBe(
      "sha256:2ee71e958dc9b4a564fd113a4983917ad6e3f7ea22cd19fa29bdb7dc72320e1c",
    );
    expect(manifest(withoutProviderKey.slice(0, 117))).toBe(
      "sha256:6bd2cd3c077f6cf56735c7192dd6e0f84a21bbec5a2657271cb5afaf1d2f20cf",
    );
    expect(manifest(withoutProviderKey.slice(0, 116))).toBe(
      "sha256:c5c0618f105799d06d21424433cec4a59fc052e63f594c2aace0657ebb52d1dd",
    );
    expect(manifest(withoutProviderKey.slice(0, 115))).toBe(
      "sha256:30f68ffc62e0b46815bc007339d83aa7894b61b23f301c012b8990713cc0ad14",
    );
    const historical = readRenderHistorical96CheckoutInventory();
    expect(historical).toHaveLength(96);
    expect(historical).toEqual(full.slice(0, 96));
    expect(manifest(historical)).toBe(
      canonicalReleaseMigrationPostManifestIdentity,
    );
    expect(historical.slice(0, 92)).toEqual(managed);
    expect(historical.slice(-4)).toEqual(
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
    expect(() => assertRenderSchemaHandoffCatalog(historical)).toThrow(
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
      manifest(historical),
    ]);
    expect(canonicalReleaseMigrationResumeManifestIdentities).not.toContain(
      manifest(full),
    );
    expect(canonicalReleaseMigrationResumeManifestIdentities).not.toContain(
      manifest(managed),
    );
  });

  it("accepts only the trusted pre-manifest and completed post-manifest replay", () => {
    const pending = new Set<string>(
      canonicalReleaseMigrationEntries.map((entry) => entry.migrationName),
    );
    // Replay belongs to the immutable historical release, after full source admission.
    const installed = readRenderHistorical96CheckoutInventory()
      .filter(({ migrationName }) => !pending.has(migrationName))
      .map(({ migrationName, checksum }) => [migrationName, checksum] as const);
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
