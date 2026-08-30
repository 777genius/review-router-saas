import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveCommentTokenCustodyDatabaseAuthorityUrl } from "./comment-token-custody-database-authority";

describe("comment-token custody database authority URL", () => {
  const runtimeDatabaseUrl =
    "postgresql://reviewrouter_api:runtime@db.internal/review_router";

  it("installs output budget metadata without scanning until 000082", () => {
    const metadataMigration = readFileSync(
      "packages/platform/db/prisma/migrations/000079_hosted_codex_output_limits/migration.sql",
      "utf8",
    );
    const validationMigration = readFileSync(
      "packages/platform/db/prisma/migrations/000082_validate_hosted_codex_output_limits/migration.sql",
      "utf8",
    );
    expect(metadataMigration).toMatch(
      /ADD CONSTRAINT "HostedCodexInvocationGrant_output_budget_check"[\s\S]*?\) NOT VALID;/u,
    );
    expect(metadataMigration).not.toContain("VALIDATE CONSTRAINT");
    expect(validationMigration).toContain(
      'VALIDATE CONSTRAINT "HostedCodexInvocationGrant_output_budget_check"',
    );
  });

  it("keeps startup recovery bounded behind every durable safety barrier", () => {
    const migration = readFileSync(
      "packages/platform/db/prisma/migrations/000086_comment_token_custody_r18_remediation/migration.sql",
      "utf8",
    );
    const recovery = migration.slice(
      migration.indexOf("IF p_operation='recover_stale'"),
      migration.indexOf("IF p_operation='claim_revocations'"),
    );
    expect(recovery).toContain("mint.\"state\"='prepared'");
    expect(recovery).toContain('mint."leaseExpiresAt"<=database_now');
    expect(recovery).toContain("mint.\"state\"='dispatching'");
    expect(
      recovery.match(/mint\."leaseExpiresAt"<=database_now/gu),
    ).toHaveLength(2);
    expect(recovery).toContain('mint."dispatchAuthorizedUntil"<=database_now');
    expect(recovery).toContain('mint."unsafeUntil"<=database_now');
    expect(recovery).toContain("mint.\"state\"='outcome_unknown'");
    expect(recovery).toContain("mint.\"state\" IN ('issued','revoke_pending')");
    expect(recovery).toContain(
      'greatest(mint."tokenExpiresAt"+interval \'1 minute\',mint."unsafeUntil")<=database_now',
    );
    expect(recovery).toContain("WITH candidates AS MATERIALIZED");
    expect(recovery).toContain(
      'greatest(\n            mint."leaseExpiresAt",mint."dispatchAuthorizedUntil",mint."unsafeUntil"',
    );
    expect(recovery).toContain("FOR UPDATE OF mint SKIP LOCKED");
    expect(
      recovery.match(/LIMIT \(p_arguments->>'limit'\)::integer/gu),
    ).toHaveLength(1);
    expect(recovery).toContain("CASE candidates.original_state");
    expect(recovery).toContain(
      'END::public."HostedCodexCommentTokenMintState"',
    );
    expect(recovery).toContain(
      "jsonb_typeof(p_arguments->'limit') IS DISTINCT FROM 'number'",
    );
    expect(recovery).toContain("p_arguments->>'limit' !~ '^[0-9]+$'");
    expect(recovery).toContain("startup_recovery_prepared_lease_expired");
    expect(recovery).toContain("startup_recovery_dispatch_ambiguity_elapsed");
    expect(recovery).toContain("startup_recovery_ambiguity_lifetime_elapsed");
    expect(recovery).toContain(
      "startup_recovery_revocation_safe_horizon_elapsed",
    );
    expect(recovery).toContain("startup_recovery_issued_safe_horizon_elapsed");
    expect(recovery).toContain(
      "\"secretCiphertext\"=CASE WHEN candidates.original_state IN ('issued','revoke_pending') THEN NULL",
    );
    expect(recovery).toContain(
      "\"deliveryClaimIdHash\"=CASE WHEN candidates.original_state IN ('issued','revoke_pending') THEN NULL",
    );
    expect(recovery).not.toMatch(/POST|http|provider\s*\(/iu);
  });

  it("serializes staged custody and stamps first retry eligibility in database time", () => {
    const migration = readFileSync(
      "packages/platform/db/prisma/migrations/000086_comment_token_custody_r18_remediation/migration.sql",
      "utf8",
    );
    const stageBranch = migration.slice(
      migration.indexOf("IF p_operation='stage_revocation'"),
      migration.indexOf(
        "RETURN QUERY SELECT * FROM public.hosted_codex_mutate_comment_token_mint_v85",
      ),
    );
    expect(stageBranch).toContain('FROM public."HostedCodexRuntimeGate" gate');
    expect(stageBranch).toContain("WHERE gate.\"id\"='global' FOR SHARE");
    const authorityBranch = migration.slice(
      migration.indexOf(
        "CREATE OR REPLACE FUNCTION hosted_codex_comment_token_authority_revoke_enqueue()",
      ),
      migration.indexOf(
        "-- Complete the custody prepare guard with facts that must never be accepted",
      ),
    );
    expect(authorityBranch.indexOf("FOR SHARE")).toBeGreaterThan(-1);
    expect(authorityBranch.indexOf("FOR SHARE")).toBeLessThan(
      authorityBranch.indexOf('UPDATE public."HostedCodexCommentTokenMint"'),
    );
    expect(migration).toContain(
      "NEW.\"state\"='revoke_pending' AND OLD.\"state\"<>'revoke_pending'",
    );
    expect(migration).toContain('NEW."nextRevocationAt" := clock_timestamp()');
    expect(migration).toContain(
      'ORDER BY mint."nextRevocationAt", mint."revocationFailureCount", mint."id"',
    );
  });

  it("validates every custody prepare snapshot against locked live authority", () => {
    const migration = readFileSync(
      "packages/platform/db/prisma/migrations/000083_hosted_codex_comment_token_mint_protocol/migration.sql",
      "utf8",
    );
    expect(migration).toContain(
      "repository.\"visibility\" IN ('private', 'internal')",
    );
    expect(migration).toContain(
      'invocation_grant."authzEpoch" = pool."authzEpoch"',
    );
    expect(migration).toContain(
      'invocation_grant."bindingRevision" = binding."revision"',
    );
    expect(migration).toContain(
      'installation."repositorySelection" = NEW."installationSelection"',
    );
    expect(migration).toContain(
      'installation."workspaceId" = NEW."installationWorkspaceId"',
    );
    expect(migration).toContain(
      "FOR SHARE OF installation, repository, pool, binding, invocation_grant",
    );
  });

  it("accepts only the isolated custody principal on the runtime database", () => {
    const value =
      "postgresql://reviewrouter_comment_token_custody:secret@db.internal/review_router";
    expect(
      resolveCommentTokenCustodyDatabaseAuthorityUrl({
        runtimeDatabaseUrl,
        env: { REVIEW_ROUTER_COMMENT_TOKEN_CUSTODY_DATABASE_URL: value },
      }),
    ).toBe(value);
  });

  it.each([
    "postgresql://reviewrouter_api:secret@db.internal/review_router",
    "postgresql://reviewrouter_comment_token_custody:secret@other.internal/review_router",
    "postgresql://reviewrouter_comment_token_custody@db.internal/review_router",
  ])("rejects a non-isolated authority URL %s", (value) => {
    expect(() =>
      resolveCommentTokenCustodyDatabaseAuthorityUrl({
        runtimeDatabaseUrl,
        env: { REVIEW_ROUTER_COMMENT_TOKEN_CUSTODY_DATABASE_URL: value },
      }),
    ).toThrow("comment_token_custody_database_authority_url_invalid");
  });
});
