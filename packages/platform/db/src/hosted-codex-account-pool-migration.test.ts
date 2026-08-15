import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("000073 hosted Codex account pool", () => {
  const sql = readFileSync(
    resolve(
      import.meta.dirname,
      "../prisma/migrations/000073_hosted_codex_account_pool/migration.sql",
    ),
    "utf8",
  );
  const schema = readFileSync(
    resolve(import.meta.dirname, "../prisma/schema.prisma"),
    "utf8",
  );

  it("adds the pool, credential, binding, grant, replay, fence, and receipt ledgers", () => {
    for (const table of [
      "HostedCodexPool",
      "HostedCodexAccount",
      "HostedCodexCredentialVersion",
      "HostedCodexRepositoryBinding",
      "HostedCodexInvocationGrant",
      "HostedCodexRelayRequest",
      "HostedCodexCommentRefreshCapability",
      "HostedCodexCommentRefreshUse",
      "HostedCodexMutationFence",
      "HostedCodexGenerationReceipt",
    ]) {
      expect(sql).toContain(`CREATE TABLE "${table}"`);
      expect(schema).toContain(`model ${table} {`);
    }

    expect(sql).toContain("SET LOCAL lock_timeout = '15s';");
    expect(sql).toContain("SET LOCAL statement_timeout = '5min';");
    expect(sql).toContain("Deliberately no backfill");
    expect(sql).not.toMatch(
      /(?:INSERT INTO|UPDATE)\s+"(?:CodexOAuth|ProviderSetupState)/u,
    );
  });

  it("enforces tenant equality and evidence-safe deletion at the database boundary", () => {
    expect(sql).toContain(
      'FOREIGN KEY ("poolId", "workspaceId")\n  REFERENCES "HostedCodexPool"("id", "workspaceId")',
    );
    expect(sql).toContain(
      'FOREIGN KEY ("repositoryConnectionId", "workspaceId")\n  REFERENCES "RepositoryConnection"("id", "workspaceId")',
    );
    expect(sql).toContain(
      'FOREIGN KEY ("accountId", "workspaceId", "poolId")\n  REFERENCES "HostedCodexAccount"("id", "workspaceId", "poolId")',
    );
    expect(sql).toContain(
      'FOREIGN KEY ("credentialVersionId", "accountId", "workspaceId", "poolId", "generation")',
    );
    expect(sql).not.toMatch(/HostedCodex[^;]+ON DELETE CASCADE/su);
    expect(sql).toContain("hosted_codex_delete_forbidden");
    expect(sql).toContain("hosted_codex_immutable_evidence");
    expect(sql).toContain("hosted_codex_pool_tombstone_terminal");
    expect(sql).toContain("hosted_codex_binding_drain_terminal");
    expect(sql).toContain("hosted_codex_account_drain_terminal");
    expect(sql).toContain(
      'CREATE TRIGGER "HostedCodexCredentialVersion_immutable_guard"',
    );
    expect(sql).toContain(
      'CREATE TRIGGER "HostedCodexGenerationReceipt_immutable_guard"',
    );
  });

  it("stores only encrypted versioned credential envelopes", () => {
    expect(schema).toContain("databaseIncarnation String");
    expect(schema).toContain("encryptedCiphertext String");
    expect(schema).toContain("envelopeMetadata    Json");
    expect(schema).toContain("generationHash      String");
    expect(schema).toContain("ciphertextHash      String");
    expect(schema).toContain("@@unique([accountId, generation])");
    expect(schema).toContain(
      "@@unique([accountId, databaseIncarnation, generation],",
    );
    expect(sql).toContain("HostedCodexCredentialVersion_envelope_check");
    expect(sql).toContain(`"generationHash" ~ '^[a-f0-9]{64}$'`);
    expect(sql).toContain(`"ciphertextHash" ~ '^[a-f0-9]{64}$'`);
    expect(sql).toContain(
      `NOT ("envelopeMetadata" ?| ARRAY['plaintext', 'accessToken', 'refreshToken', 'secret'])`,
    );

    const credentialModel = schema.match(
      /model HostedCodexCredentialVersion \{[\s\S]+?\n\}/u,
    )?.[0];
    expect(credentialModel).toBeDefined();
    expect(credentialModel).not.toMatch(
      /^\s*(?:accessToken|refreshToken|plaintext|secret)\s/mu,
    );
  });

  it("keeps selection, defaults, lifecycle, and CAS invariants explicit", () => {
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "HostedCodexPool_one_default_per_workspace_key"',
    );
    expect(sql).toContain('WHERE "isDefault" = true');
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "HostedCodexRepositoryBinding_repositoryConnectionId_key"',
    );
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "HostedCodexAccount_workspaceId_accountFingerprint_key"',
    );
    expect(sql).toContain("HostedCodexAccount_healthy_priority_idx");
    expect(sql).toContain("hosted_codex_account_health_cas_required");
    expect(sql).toContain("HostedCodexInvocationGrant_expiry_reconcile_idx");
    expect(sql).toContain("HostedCodexInvocationGrant_cas_idx");
    expect(sql).toContain("HostedCodexMutationFence_expiry_idx");
    expect(sql).toContain("restore_quarantined");
    expect(sql).toContain("needs_reconnect");
    expect(sql).toContain("quota_exhausted");

    const accountModel = schema.match(
      /model HostedCodexAccount \{[\s\S]+?\n\}/u,
    )?.[0];
    expect(accountModel).not.toMatch(/executionSlots|concurrency/iu);
  });

  it("requires exact workflow evidence before binding activation", () => {
    expect(sql).toContain(
      "HostedCodexRepositoryBinding_active_attestation_check",
    );
    expect(sql).toContain('"attestedBindingRevision" = "revision"');
    expect(sql).toContain(
      "\"workflowSourceTrust\" = 'trusted_default_branch_revision'",
    );
    expect(sql).toContain("hosted_codex_binding_activation_revision_changed");
    expect(sql).toContain(
      "hosted_codex_binding_repository_attestation_mismatch",
    );
    expect(sql).toContain("hosted_codex_binding_state_cas_required");
    expect(sql).toContain(
      'FOREIGN KEY ("repositoryBindingId", "workspaceId", "poolId", "repositoryConnectionId", "bindingRevision")',
    );
  });

  it("uses a hash-only bounded capability with one pre-response failover", () => {
    expect(schema).toContain("capabilityTokenHash");
    expect(schema).not.toMatch(/^\s*capabilityToken\s/mu);
    expect(sql).toContain("HostedCodexInvocationGrant_capability_hash_check");
    expect(sql).toContain('"bindingRevision" BIGINT NOT NULL');
    expect(sql).toContain('"authzEpoch" BIGINT NOT NULL');
    expect(sql).toContain('"policyFingerprint" TEXT NOT NULL');
    expect(sql).toContain('"runtimeConfigVersion" INTEGER NOT NULL');
    expect(sql).toContain('"maxConcurrentRequests" INTEGER NOT NULL');
    expect(sql).toContain('"maxRequestBytes" INTEGER NOT NULL');
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "HostedCodexInvocationGrant_invocationId_key"',
    );
    expect(sql).toContain('"primaryAccountId" TEXT NOT NULL');
    expect(sql).toContain('"backupAccountId" TEXT');
    expect(sql).toContain(
      'FOREIGN KEY ("primaryAccountId", "workspaceId", "poolId")',
    );
    expect(sql).toContain(
      'FOREIGN KEY ("backupAccountId", "workspaceId", "poolId")',
    );
    expect(sql).toContain("hosted_codex_grant_failover_forbidden");
    expect(sql).toContain('OLD."firstSuccessfulResponseAt" IS NOT NULL');
    expect(sql).toContain('NEW."failoverCount" <> 1');
    expect(sql).not.toContain(
      'FOREIGN KEY ("reviewRequestId") REFERENCES "ReviewInvocationLeaseV2"',
    );
    expect(sql).toContain('ON "HostedCodexInvocationGrant"("reviewRequestId")');
  });

  it("separates replay idempotency from body identity and fences on response start", () => {
    expect(sql).toContain('"idempotencyKeyHash" TEXT NOT NULL');
    expect(sql).toContain('"requestHash" TEXT,');
    expect(sql).toContain("\"status\" = 'processing'");
    expect(sql).toMatch(
      /"status" = 'received'[\s\S]*?"requestHash" IS NULL[\s\S]*?"status" = 'processing'/u,
    );
    expect(sql).not.toMatch(
      /"status" = 'processing'[\s\S]*?"requestHash" IS NULL[\s\S]*?"status" = 'response_started'/u,
    );
    expect(sql).toMatch(
      /"status" = 'response_started'[\s\S]*?"requestHash" IS NOT NULL[\s\S]*?"status" = 'succeeded'/u,
    );
    expect(sql).toContain("hosted_codex_relay_request_hash_immutable");
    expect(sql).toContain("hosted_codex_relay_admission_guard");
    expect(sql).toContain('"requestCount" = target_grant."requestCount" + 1');
    expect(sql).toContain('"inFlight" = target_grant."inFlight" + 1');
    expect(sql).toContain("hosted_codex_relay_completion_accounting");
    expect(sql).toContain(
      'ON "HostedCodexRelayRequest"("grantId", "idempotencyKeyHash")',
    );
    expect(sql).toContain(
      'ON "HostedCodexRelayRequest"("grantId", "requestHash")',
    );
    expect(sql).not.toContain(
      'CREATE UNIQUE INDEX "HostedCodexRelayRequest_grantId_requestHash_key"',
    );
    expect(sql).toContain('"successfulResponseStartedAt" TIMESTAMP(3)');
    expect(sql).toContain("hosted_codex_relay_success_fence");
    expect(sql).toContain('SET "firstSuccessfulResponseAt" = success_at');
  });

  it("persists and atomically consumes a distinct hash-only comment refresh capability", () => {
    expect(sql).toContain('CREATE TABLE "HostedCodexCommentRefreshCapability"');
    expect(sql).toContain('"capabilityTokenHash" TEXT NOT NULL');
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "HostedCodexCommentRefreshCapability_capabilityTokenHash_key"',
    );
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "HostedCodexCommentRefreshCapability_grantId_key"',
    );
    expect(sql).toContain(
      'FOREIGN KEY (\n    "grantId", "invocationId", "repositoryBindingId",',
    );
    expect(sql).toContain("hosted_codex_comment_refresh_consume");
    expect(sql).toContain('"useCount" = capability."useCount" + 1');
    expect(sql).toContain('capability."expiresAt" > NEW."usedAt"');
    expect(sql).toContain('capability."revokedAt" IS NULL');
    expect(sql).toContain("hosted_codex_comment_refresh_ledger_mismatch");
    expect(sql).toContain(
      'CREATE TRIGGER "HostedCodexCommentRefreshUse_immutable_guard"',
    );
    expect(schema).not.toMatch(/^\s*(?:commentRefreshToken|plaintext)\s/mu);
  });
});
