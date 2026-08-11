import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Codex rotating PostgreSQL 17 rehearsal contract", () => {
  const source = readFileSync(
    resolve(
      import.meta.dirname,
      "check-codex-rotating-migration-rehearsal.mjs",
    ),
    "utf8",
  );
  const runtimeProofSource = readFileSync(
    resolve(
      import.meta.dirname,
      "prove-codex-runtime-versioned-writeback-prisma.ts",
    ),
    "utf8",
  );
  const prismaRetentionProofSource = readFileSync(
    resolve(import.meta.dirname, "prove-codex-rotating-evidence-prisma.ts"),
    "utf8",
  );

  it("keeps 000063 and 000064 in the late-failure rollback/replay matrix", () => {
    const matrix =
      /function proveLateMigrationRollbackAndReplayMatrix\(\) \{([\s\S]+?)\n\}/u.exec(
        source,
      )?.[1];
    expect(matrix).toBeDefined();
    expect(matrix).toContain("name: migration63Name");
    expect(matrix).toContain("name: migration64Name");
    expect(matrix).toContain('psql(url, ["-c", testCase.decoy])');
    expect(matrix).toContain("`${testCase.name} injected failure missing`");
    expect(matrix).toContain(
      "`${testCase.name} leaked partial catalog state after rollback`",
    );
    expect(matrix).toContain('.stdout.trim() === "0"');
    expect(matrix).toContain('psql(url, ["-c", testCase.cleanup])');
    expect(matrix).toContain("const failed = migrateDeploy(url, false)");
    expect(matrix).toContain(
      "proveMigrationRunnerHistory(url, testCase.name, false)",
    );
    expect(matrix).toContain(
      'migrateResolve(url, "--rolled-back", testCase.name)',
    );
    expect(matrix).toContain("migrateDeploy(url)");
    expect(matrix).toContain(
      "proveMigrationRunnerHistory(url, testCase.name, true)",
    );
    expect(matrix).not.toContain("registerDirectMigrationSuccess");
    expect(source).not.toContain("function registerDirectMigrationSuccess");
  });

  it("uses the production exact catalog observation and verifier", () => {
    expect(source).toContain(
      "verifyCodexRotatingDatabaseCatalog(observation.catalog, {",
    );
    expect(source).toContain(
      "production catalog verifier rejected the PostgreSQL 17 rehearsal",
    );
    expect(source).toContain("verifyPrivileges: false");
    const collection =
      /function collectObservation\(url\) \{([\s\S]+?)\n\}/u.exec(source)?.[1];
    expect(collection).toBeDefined();
    expect(collection).toContain(
      "codexRotatingProductionWriterBaseObservationSql",
    );
    expect(collection).toContain(").catalog");
  });

  it("binds acknowledged W2 recovery issuance to the explicit proof witness", () => {
    const recoveryFlow =
      /const recoveryRequestId = "recovery:runtime-proof-ambiguous";([\s\S]+?)\n {2}ledger = rotatedRuntime;/u.exec(
        runtimeProofSource,
      )?.[1];

    expect(recoveryFlow).toBeDefined();
    expect(recoveryFlow).toContain(
      "acknowledgement: codexRotatingSetupRecoveryAcknowledgement",
    );
    expect(recoveryFlow).toMatch(
      /new PrismaCodexRotatingSetupRecovery\(\s*prisma,\s*databaseRecoveryWitnessW2,\s*\)/u,
    );
    expect(recoveryFlow).toMatch(
      /issueCodexRotatingSetupCommand\(\{[\s\S]+?databaseRecoveryWitness: databaseRecoveryWitnessW2,/u,
    );
    expect(recoveryFlow).not.toContain(
      "process.env.REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS",
    );
  });

  it("rejects W2 at the healthy W1 witness boundary without ambient flag mutation", () => {
    const witnessBoundary =
      /const rotatedRuntime = new PrismaCodexRotatingOAuthRepository([\s\S]+?)\n {2}const definite = await run/u.exec(
        runtimeProofSource,
      )?.[1];

    expect(witnessBoundary).toBeDefined();
    expect(witnessBoundary).toContain(
      'providerBeforeRejectedPrelease.state !== "active"',
    );
    expect(witnessBoundary).toContain(
      '"codex_rotating_database_recovery_witness_mismatch"',
    );
    expect(witnessBoundary).toContain(
      "leaseCountAfterRejectedPrelease !== leaseCountBeforeRejectedPrelease",
    );
    expect(runtimeProofSource).toContain(
      "runtimeEnvironment: localProofRuntimeEnvironment",
    );
    expect(runtimeProofSource).not.toMatch(
      /process\.env\.REVIEW_ROUTER_(?:CODEX_ROTATING_SETUP_ISSUANCE_ENABLED|ENABLE_CODEX_ROTATING_OAUTH|CODEX_ROTATING_OAUTH_REPOSITORIES)\s*=/u,
    );
  });

  it("reuses exact production-path namespace evidence for ledger retention proofs", () => {
    const ledgerProof =
      /function proveVersionedNamespaceLedger\(url\) \{([\s\S]+?)\n\}\n\nfunction assertVersionedNamespaceEvidenceRetained/u.exec(
        source,
      )?.[1];

    expect(ledgerProof).toBeDefined();
    expect(ledgerProof).toContain("operation:runtime-proof-initial");
    expect(ledgerProof).toContain("operation:runtime-proof-recovery");
    expect(ledgerProof).toContain("proof:ambiguous");
    expect(ledgerProof).toContain("CodexOAuthSecretNamespace_secretName_key");
    expect(ledgerProof).not.toContain("claim-proof");
    expect(ledgerProof).not.toContain("p-fetched");
    expect(source).toContain('retained === "1:1:1:1:1:1"');
    expect(prismaRetentionProofSource).toContain(
      "REVIEW_ROUTER_PRISMA_EVIDENCE_IDENTITIES",
    );
    expect(prismaRetentionProofSource).not.toContain("claim-proof");
    expect(prismaRetentionProofSource).not.toContain("p-fetched");
  });
});
