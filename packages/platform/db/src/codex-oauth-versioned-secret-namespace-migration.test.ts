import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

type CanonicalForeignKeyDefinition = {
  readonly definition: string;
  readonly name: string;
  readonly table: string;
};

type ForeignKeyAction =
  | "CASCADE"
  | "NO ACTION"
  | "RESTRICT"
  | "SET DEFAULT"
  | "SET NULL";

type ParsedForeignKeyDefinition = {
  readonly localColumns: readonly string[];
  readonly onDelete: ForeignKeyAction;
  readonly onUpdate: ForeignKeyAction;
  readonly referencedColumns: readonly string[];
  readonly referencedTable: string;
  readonly table: string;
};

const prismaActionByPostgresAction = {
  CASCADE: "Cascade",
  "NO ACTION": "NoAction",
  RESTRICT: "Restrict",
  "SET DEFAULT": "SetDefault",
  "SET NULL": "SetNull",
} as const satisfies Record<ForeignKeyAction, string>;

const {
  codexRotatingPrismaModeledRecoveryLedgerForeignKeys,
  codexRotatingRecoveryLedgerForeignKeys,
} = (await import(
  new URL(
    "../../../../scripts/codex-rotating-production-writer-schema.mjs",
    import.meta.url,
  ).href
)) as {
  readonly codexRotatingPrismaModeledRecoveryLedgerForeignKeys: readonly CanonicalForeignKeyDefinition[];
  readonly codexRotatingRecoveryLedgerForeignKeys: readonly CanonicalForeignKeyDefinition[];
};

describe("000064 never-reused versioned namespace ledger", () => {
  const sql = readFileSync(
    resolve(
      import.meta.dirname,
      "../prisma/migrations/000064_codex_oauth_versioned_secret_namespaces/migration.sql",
    ),
    "utf8",
  );
  const setupClaimMigrationSql = readFileSync(
    resolve(
      import.meta.dirname,
      "../prisma/migrations/000063_codex_oauth_setup_payload_claim/migration.sql",
    ),
    "utf8",
  );
  const workflowCompatibilitySql = readFileSync(
    resolve(
      import.meta.dirname,
      "../prisma/migrations/000089_codex_oauth_v4_v5_staged_compatibility/migration.sql",
    ),
    "utf8",
  );
  const migrationSqlByForeignKey = new Map([
    [
      "CodexOAuthWorkflowCompatibility_namespace_fkey",
      workflowCompatibilitySql,
    ],
  ]);
  const prismaSchema = readFileSync(
    resolve(import.meta.dirname, "../prisma/schema.prisma"),
    "utf8",
  );

  it("persists claims, attempts, active bindings, and permanent tombstones", () => {
    expect(sql).toContain('CREATE TABLE "CodexOAuthSetupPayloadClaim"');
    expect(sql).toContain('CREATE TABLE "CodexOAuthSetupDispatchAttempt"');
    expect(sql).toContain('CREATE TABLE "CodexOAuthSecretNamespace"');
    expect(sql).toContain('"permanentlyRetired" BOOLEAN NOT NULL');
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "CodexOAuthSecretNamespace_secretName_key"',
    );
    expect(sql).toContain('"activeSecretNamespaceId"');
    expect(sql).toContain('"workflowSourceCommitSha" IS NOT NULL');
    expect(sql).toContain('"workflowSourceBlobSha" IS NOT NULL');
    expect(sql).toContain('"workflowSemanticSha256" IS NOT NULL');
    expect(sql).toContain('"attestedRepositoryId" = "githubRepositoryId"');
    expect(sql).toContain(
      'CREATE TRIGGER "CodexOAuthSecretNamespace_tombstone_guard"',
    );
    expect(sql).toContain("codex_oauth_secret_namespace_delete_forbidden");
    expect(sql).toContain("codex_oauth_setup_claim_delete_forbidden");
    expect(sql).toContain("codex_oauth_setup_attempt_delete_forbidden");
    expect(sql.match(/REVOKE EXECUTE ON FUNCTION/g)).toHaveLength(19);
    expect(sql).toContain('CREATE TABLE "CodexOAuthDatabaseAuthorityKey"');
    expect(sql).toContain(
      'CREATE FUNCTION "codex_oauth_sign_database_authority"',
    );
    expect(sql).toContain("codex_oauth_database_authority_signature_invalid");
    expect(sql).toContain('CREATE TABLE "CodexOAuthDatabaseAuthorityReceipt"');
    expect(sql).toContain(
      'CREATE FUNCTION "codex_oauth_authorize_setup_confirmation"',
    );
    expect(sql).toContain(
      'CREATE FUNCTION "codex_oauth_authorize_runtime_confirmation"',
    );
    expect(sql).toContain(
      'CREATE FUNCTION "codex_oauth_authorize_runtime_completion"',
    );
    expect(sql.match(/^SECURITY DEFINER$/gmu)).toHaveLength(6);
    expect(sql).toMatch(
      /CREATE OR REPLACE FUNCTION "codex_oauth_provider_identity_guard"\(\)[\s\S]+SECURITY DEFINER[\s\S]+SET search_path = pg_catalog, public[\s\S]+FROM public\."RepositoryConnection" WHERE "id" = NEW\."repositoryId" FOR SHARE/u,
    );
    expect(sql).toContain(
      "'ALTER FUNCTION %s OWNER TO reviewrouter_release_migration'",
    );
    expect(sql).not.toMatch(
      /(?:REVOKE|GRANT)[^;]*RepositoryConnection[^;]*reviewrouter_release_migration/iu,
    );
    expect(sql).not.toMatch(
      /GRANT (?:INSERT|DELETE|TRUNCATE|REFERENCES|TRIGGER)[^;]*RepositoryConnection/iu,
    );
    expect(sql).toContain("'REVOKE EXECUTE ON FUNCTION %s FROM %I'");
    expect(sql).toContain("codex_oauth_database_authority_receipt_required");
    expect(sql).toContain(
      '\'setup_confirmation\', OLD."id", NEW."definiteResponseCode"',
    );
    expect(sql).toContain(
      '\'runtime_confirmation\', OLD."id", NEW."providerResponseCode"',
    );
    expect(sql).toContain("'runtime_completion', OLD.\"id\", 0");
    expect(sql).toContain(
      'REVOKE ALL ON TABLE "CodexOAuthDatabaseAuthorityReceipt" FROM PUBLIC',
    );
    expect(sql).toContain(
      'REVOKE ALL ON TABLE "CodexOAuthDatabaseAuthorityKey" FROM PUBLIC',
    );
    expect(sql).toContain("reviewrouter_codex_effect_authority");
    expect(sql).toContain(
      'CREATE TRIGGER "CodexOAuthWritebackIntent_runtime_evidence_guard"',
    );
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "CodexOAuthWritebackIntent_versioned_lease_key"',
    );
    expect(sql).toMatch(
      /CodexOAuthWritebackIntent_versioned_lease_key[\s\S]+ON "CodexOAuthWritebackIntent"\("leaseId"\)[\s\S]+WHERE "databaseIncarnation" IS NOT NULL/,
    );
    expect(sql).toContain("codex_oauth_runtime_writeback_delete_forbidden");
    expect(sql).toContain("AND NOT quarantine_repair_allowed");
    expect(sql).toContain('"databaseIncarnation"');
    expect(sql).toContain('"databaseRecoveryWitness"');
    expect(sql).toContain('"recoveryRequestRowId"');
    expect(sql).toContain('"recoveryResolvedAt"');
    expect(sql).toContain(
      "\"accountIdentityAlgorithm\" = 'provider_issuer_subject_account_v1'",
    );
    expect(sql).toContain("codex_oauth_setup_recovery_delete_forbidden");
    expect(sql).toContain("codex_oauth_setup_recovery_initial_state_invalid");
    expect(sql).toContain("codex_oauth_secret_namespace_initial_state_invalid");
    expect(sql).toContain("codex_oauth_setup_claim_initial_state_invalid");
    expect(sql).toContain("codex_oauth_setup_attempt_initial_state_invalid");
    expect(sql).toContain("codex_oauth_setup_manifest_initial_state_invalid");
    expect(sql).toContain(
      "codex_oauth_runtime_writeback_initial_state_invalid",
    );
    expect(sql).toContain(
      'BEFORE INSERT OR UPDATE OR DELETE ON "CodexOAuthSetupRecoveryRequest"',
    );
    expect(sql).toContain(
      'BEFORE INSERT OR UPDATE OR DELETE ON "CodexOAuthWritebackIntent"',
    );
    for (const table of [
      "CodexOAuthSecretNamespace",
      "CodexOAuthSetupPayloadClaim",
      "CodexOAuthSetupDispatchAttempt",
      "CodexOAuthSetupManifest",
    ]) {
      expect(sql).toContain(`BEFORE INSERT OR UPDATE OR DELETE ON "${table}"`);
    }
    expect(sql).toContain(
      `OLD."state" = 'active' AND NEW."state" = 'manifest_issued'`,
    );
    expect(sql).toContain(
      `OLD."state" = 'manifest_issued' AND NEW."state" = 'completed'`,
    );
    expect(sql).toContain(
      `manifest."providerInstanceRowId" = NEW."providerInstanceRowId"`,
    );
    expect(sql).toContain(`manifest."mutationEpoch" = NEW."mutationEpoch" + 1`);
    expect(sql).toContain(`OLD."providerResponseCode" IN (201,204)`);
    expect(sql).toContain(`lease."status" = 'completed'`);
    expect(sql).toContain(`namespace."status" = 'active'`);
    expect(sql).toContain(`manifest."status" = 'consumed'`);
    expect(sql).toContain(
      `OLD."status" IN ('issued','fetched') AND NEW."status" = 'recovered'`,
    );
    expect(sql).toContain(
      `provider."mutationOwnerId" = 'setup-recovery:' || recovery."recoveryRequestId"`,
    );
    expect(sql).toContain(
      `NEW."confirmationJson"->>'recoveryEpoch' = recovery."mutationEpoch"::text`,
    );
    expect(sql).toContain(
      `OLD."status" IN ('consumed','expired','superseded','recovered')`,
    );
    expect(sql).toContain(`claim."status" = 'active'`);
    expect(sql).toContain(`attempt."status" = 'confirmed'`);
    expect(sql).toContain('ADD COLUMN "executorOwner" TEXT');
    expect(sql).toContain('ADD COLUMN "executorLeaseExpiresAt" TIMESTAMPTZ(3)');
    expect(sql).toContain(
      'NEW."executorOwner" IS DISTINCT FROM OLD."executorOwner"',
    );
    expect(sql).toContain("unchanged_generation_positive_proof_v1");
    expect(sql).toContain(`OLD."providerResponseCode" IS NULL`);
    expect(sql).toContain(`NEW."providerConfirmedAt" IS NULL`);
    expect(sql).toContain(`AND no_op_completion_evidence_matches`);
    expect(sql).not.toMatch(
      /CodexOAuthSetupPayloadClaim[^;]+ON DELETE CASCADE/s,
    );
    expect(sql).toContain("'retired_superseded'");
    expect(sql).toContain("'versioned-namespace-cutover:' || \"id\"");
    expect(sql).toMatch(
      /UPDATE "ProviderSetupState"[\s\S]+"authMode" = 'codex_subscription_oauth_rotating'[\s\S]+"state" = 'configured'/,
    );
    expect(sql).toMatch(
      /CodexOAuthWritebackIntent_providerInstanceRowId_fkey[^;]+ON DELETE RESTRICT/s,
    );
    expect(sql).toMatch(
      /CodexOAuthWritebackIntent_leaseId_fkey[^;]+ON DELETE RESTRICT/s,
    );
    expect(sql).toMatch(
      /CodexOAuthWritebackIntent_recovery_request_fkey[^;]+ON DELETE RESTRICT/s,
    );
    expect(sql).toMatch(
      /CodexOAuthSetupRecoveryRequest_latestManifestId_fkey[\s\S]+ON DELETE RESTRICT/,
    );
    expect(sql).toMatch(
      /CodexOAuthSetupPayloadClaim_recovery_request_fkey[\s\S]+ON DELETE RESTRICT/,
    );
    expect(sql).toContain(
      'NEW."latestManifestId" IS DISTINCT FROM OLD."latestManifestId"',
    );
    expect(sql).toContain(
      'NEW."completedAt" IS DISTINCT FROM OLD."completedAt"',
    );
    for (const terminalField of [
      "status",
      "safeErrorCode",
      "providerResponseCode",
      "providerConfirmedAt",
      "namespaceRetiredAt",
      "completedAt",
    ]) {
      expect(sql).toContain(
        `NEW."${terminalField}" IS DISTINCT FROM OLD."${terminalField}"`,
      );
    }
    expect(sql).toContain(
      `OLD."status" IN ('completed','failed') AND NEW IS DISTINCT FROM OLD`,
    );
    expect(sql).toContain(
      `OLD."confirmedAt" IS NOT NULL AND NEW."confirmedAt" IS DISTINCT FROM OLD."confirmedAt"`,
    );
    expect(sql).toContain("'retired_predispatch'");
  });

  it("elevates only the trigger lock that crosses the config-table boundary", () => {
    expect(sql.match(/FOR SHARE;/gu)).toHaveLength(2);
    expect(sql).toContain(
      'FROM public."RepositoryConnection" WHERE "id" = NEW."repositoryId" FOR SHARE;',
    );
    expect(sql).toContain(
      'WHERE "id" = NEW."providerInstanceRowId" FOR SHARE;',
    );
    const childGuardDeclaration =
      /CREATE OR REPLACE FUNCTION "codex_oauth_child_identity_fence_guard"\(\)[\s\S]+?AS \$\$/u.exec(
        sql,
      )?.[0];
    expect(childGuardDeclaration).toBeDefined();
    expect(childGuardDeclaration).not.toContain("SECURITY DEFINER");
    expect(sql).toContain(
      'REVOKE EXECUTE ON FUNCTION "codex_oauth_repair_quarantined_provider"(TEXT, BIGINT) FROM PUBLIC;',
    );
  });

  it("models every 000063/000064 timestamp with PostgreSQL timestamptz(3)", () => {
    for (const model of [
      "CodexOAuthSetupPayloadClaim",
      "CodexOAuthSecretNamespace",
      "CodexOAuthSetupDispatchAttempt",
    ]) {
      const body = new RegExp(`model ${model} \\{([\\s\\S]*?)\\n\\}`, "u").exec(
        prismaSchema,
      )?.[1];
      expect(body).toBeDefined();
      for (const line of body!
        .split("\n")
        .filter((value) => value.includes("DateTime"))) {
        expect(line).toContain("@db.Timestamptz(3)");
      }
    }
    const manifest = /model CodexOAuthSetupManifest \{([\s\S]*?)\n\}/u.exec(
      prismaSchema,
    )?.[1];
    expect(manifest).toMatch(
      /payloadClaimedAt\s+DateTime\?\s+@db\.Timestamptz\(3\)/,
    );
    expect(manifest).toMatch(
      /recoveryExpiresAt\s+DateTime\?\s+@db\.Timestamptz\(3\)/,
    );
    const writeback = /model CodexOAuthWritebackIntent \{([\s\S]*?)\n\}/u.exec(
      prismaSchema,
    )?.[1];
    for (const field of [
      "dispatchAuthorizedAt",
      "providerConfirmedAt",
      "namespaceRetiredAt",
      "recoveryResolvedAt",
    ]) {
      expect(writeback).toMatch(
        new RegExp(`${field}\\s+DateTime\\?\\s+@db\\.Timestamptz\\(3\\)`),
      );
    }
  });

  it("keeps the canonical FK inventory synchronized with its defining migration", () => {
    for (const foreignKey of codexRotatingRecoveryLedgerForeignKeys) {
      expect(
        parseMigrationForeignKey(
          migrationSqlByForeignKey.get(foreignKey.name) ?? sql,
          foreignKey.name,
        ),
      ).toEqual(parseCanonicalForeignKey(foreignKey));
    }
  });

  it("keeps every modeled 000064 FK exact in Prisma", () => {
    for (const foreignKey of codexRotatingPrismaModeledRecoveryLedgerForeignKeys) {
      const expected = parseCanonicalForeignKey(foreignKey);
      const modelBody = new RegExp(
        `model ${escapeRegExp(expected.table)} \\{([\\s\\S]*?)\\n\\}`,
        "u",
      ).exec(prismaSchema)?.[1];
      const relationLines = modelBody
        ?.split("\n")
        .filter((line) => line.includes(`map: "${foreignKey.name}"`));
      const relationLine = relationLines?.[0];
      const referencedModel = /^\s+\w+\s+(\w+)\??\s+@relation\(/u.exec(
        relationLine ?? "",
      )?.[1];

      expect(modelBody, `missing Prisma model ${expected.table}`).toBeDefined();
      expect(
        relationLines,
        `expected one Prisma relation mapped to ${foreignKey.name}`,
      ).toHaveLength(1);
      expect(referencedModel).toBe(expected.referencedTable);
      expect(relationLine).toContain(
        `fields: [${expected.localColumns.join(", ")}]`,
      );
      expect(relationLine).toContain(
        `references: [${expected.referencedColumns.join(", ")}]`,
      );
      expect(relationLine).toContain(
        `onDelete: ${prismaActionByPostgresAction[expected.onDelete]}`,
      );
      expect(relationLine).toContain(
        `onUpdate: ${prismaActionByPostgresAction[expected.onUpdate]}`,
      );
    }
  });

  it("fences every V4 provider/evidence field in the newest migration", () => {
    expect(
      createHash("sha256").update(setupClaimMigrationSql).digest("hex"),
    ).toBe("33100d6f5f3f59cd9a4c22f041d19caba6a0e0be88de4a0ee4d543af50619481");
    expect(setupClaimMigrationSql.trimStart()).toMatch(/^BEGIN;/);
    expect(setupClaimMigrationSql.trimEnd()).toMatch(/COMMIT;$/);
    for (const field of [
      "activeSecretNamespaceId",
      "activeSecretNamespaceEpoch",
      "activeSecretNamespaceName",
      "activeAccountIdentityHash",
      "manifestId",
      "manifestDigest",
      "recoveryEpoch",
      "installerDigest",
      "dispatchExpiresAt",
      "workflowSourceBlobSha",
      "workflowSourceSha256",
      "workflowSemanticSha256",
      "attestedRepositoryId",
    ]) {
      expect(sql).toContain(`NEW."${field}" IS DISTINCT FROM OLD."${field}"`);
    }
    expect(sql).toContain(
      'CONSTRAINT "CodexOAuthProviderInstance_active_namespace_owner_fkey"',
    );
  });

  it("retires every live setup authority into immutable terminal evidence", () => {
    expect(sql).toContain("'retired_confirmed'");
    expect(sql).toContain("'retired_active'");
    expect(sql).toContain(
      `OLD."status" = 'confirmed' AND NEW."status" = 'retired_confirmed'`,
    );
    expect(sql).toContain(
      `OLD."status" = 'confirmed_candidate' AND NEW."status" IN ('active','retired_confirmed')`,
    );
    expect(sql).toContain(
      `OLD."status" IN ('retired_ambiguous','retired_confirmed') AND NEW IS DISTINCT FROM OLD`,
    );
  });

  it("binds account-switch authority to a distinct recovery mode and acknowledgement", () => {
    expect(sql).toContain("forced_reseed_account_switch");
    expect(sql).toContain(
      "all_prior_installers_and_writers_are_stopped_and_account_switch_is_intended",
    );
    expect(sql).toMatch(
      /"mode" = 'forced_reseed_account_switch'[\s\S]+"acknowledgement" = 'all_prior_installers_and_writers_are_stopped_and_account_switch_is_intended'/,
    );
  });

  it("allows only the evidence-preserving setup confirmation state transition", () => {
    expect(sql).toMatch(
      /OLD\."mutationOwner" = 'setup'[\s\S]+NEW\."mutationOwner" = 'setup'[\s\S]+NEW\."mutationOwnerId" = OLD\."mutationOwnerId"/,
    );
    expect(sql).toContain(`NEW."state" = 'workflow_update_required'`);
    expect(sql).toContain(
      `NEW."latestGenerationHash" IS NOT DISTINCT FROM OLD."latestGenerationHash"`,
    );
    expect(sql).toContain(
      `NEW."activeLeaseExpiresAt" IS NOT DISTINCT FROM OLD."activeLeaseExpiresAt"`,
    );
  });

  it("allows terminal unknown evidence to bind only to the active recovery epoch", () => {
    expect(sql).toContain("recovery_resolution_matches");
    expect(sql).toContain(
      `recovery."id" = to_jsonb(NEW)->>'recoveryRequestRowId'`,
    );
    expect(sql).toContain(`recovery."mutationEpoch" = p."mutationEpoch"`);
    expect(sql).toContain(`recovery."state" = 'active'`);
  });

  it("permits only evidence-backed quarantine identity repair", () => {
    expect(sql).toContain("quarantine_repair_allowed");
    expect(sql).toContain(`q."childKind" = 'writeback_intent'`);
    expect(sql).toContain(
      `q."evidenceJson"->'child'->>'leaseId' = OLD."leaseId"`,
    );
    expect(sql).toContain(`p."mutationOwner" = 'recovery'`);
    expect(sql).toContain(`replacement."providerInstanceRowId" = p."id"`);
  });
});

function parseCanonicalForeignKey(
  foreignKey: CanonicalForeignKeyDefinition,
): ParsedForeignKeyDefinition {
  const parsed =
    /^FOREIGN KEY \(([^)]+)\) REFERENCES "([^"]+)"\(([^)]+)\)(.*)$/u.exec(
      foreignKey.definition,
    );
  if (!parsed) {
    throw new Error(`invalid canonical definition for ${foreignKey.name}`);
  }
  const localColumns = parsed[1];
  const referencedTable = parsed[2];
  const referencedColumns = parsed[3];
  const actions = parsed[4];
  if (
    !localColumns ||
    !referencedTable ||
    !referencedColumns ||
    actions === undefined
  ) {
    throw new Error(`incomplete canonical definition for ${foreignKey.name}`);
  }
  return {
    table: foreignKey.table,
    localColumns: parseIdentifiers(localColumns),
    referencedTable,
    referencedColumns: parseIdentifiers(referencedColumns),
    onUpdate: parseAction(actions, "UPDATE"),
    onDelete: parseAction(actions, "DELETE"),
  };
}

function parseMigrationForeignKey(
  sql: string,
  name: string,
): ParsedForeignKeyDefinition {
  const parsed = new RegExp(
    `(?:ADD )?CONSTRAINT "${escapeRegExp(name)}"\\s+FOREIGN KEY \\(([^)]+)\\)\\s+REFERENCES (?:public\\.)?"([^"]+)"\\(([^)]+)\\)([\\s\\S]*?)(?=,\\s*(?:(?:ADD|DROP)\\s+)?CONSTRAINT|;)`,
    "u",
  ).exec(sql);
  if (!parsed) throw new Error(`missing migration FK ${name}`);
  const statementStart = Math.max(
    sql.lastIndexOf("ALTER TABLE", parsed.index),
    sql.lastIndexOf("CREATE TABLE", parsed.index),
  );
  const table = /^(?:ALTER|CREATE) TABLE (?:public\.)?"([^"]+)"/u.exec(
    sql.slice(statementStart),
  )?.[1];
  if (!table) throw new Error(`missing source table for migration FK ${name}`);
  const localColumns = parsed[1];
  const referencedTable = parsed[2];
  const referencedColumns = parsed[3];
  const actions = parsed[4];
  if (
    !localColumns ||
    !referencedTable ||
    !referencedColumns ||
    actions === undefined
  ) {
    throw new Error(`incomplete migration FK ${name}`);
  }
  return {
    table,
    localColumns: parseIdentifiers(localColumns),
    referencedTable,
    referencedColumns: parseIdentifiers(referencedColumns),
    onUpdate: parseAction(actions, "UPDATE"),
    onDelete: parseAction(actions, "DELETE"),
  };
}

function parseIdentifiers(value: string): readonly string[] {
  return value
    .split(",")
    .map((identifier) => identifier.trim().replace(/^"|"$/gu, ""));
}

function parseAction(
  value: string,
  event: "DELETE" | "UPDATE",
): ForeignKeyAction {
  return (new RegExp(
    `\\bON ${event} (CASCADE|NO ACTION|RESTRICT|SET DEFAULT|SET NULL)\\b`,
    "u",
  ).exec(value)?.[1] ?? "NO ACTION") as ForeignKeyAction;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
