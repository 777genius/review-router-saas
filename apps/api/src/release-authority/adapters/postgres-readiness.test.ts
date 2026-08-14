import { describe, expect, it, vi } from "vitest";
import { observeReleaseAuthorityDatabaseReadiness } from "./postgres-readiness";

const transactionHarness = (queryRaw: ReturnType<typeof vi.fn>) => {
  const executeRawUnsafe = vi.fn().mockResolvedValue(0);
  let released = false;
  const transaction = vi.fn(
    async (operation: (client: unknown) => unknown, _options?: unknown) => {
      try {
        return await operation({
          $queryRaw: queryRaw,
          $executeRawUnsafe: executeRawUnsafe,
        });
      } finally {
        released = true;
      }
    },
  );
  return {
    prisma: { $transaction: transaction, $queryRaw: vi.fn() },
    executeRawUnsafe,
    transaction,
    released: () => released,
  };
};

const sqlText = (queryRaw: ReturnType<typeof vi.fn>) =>
  queryRaw.mock.calls.map((call) => String(call[0]?.text)).join("\n");

const withTimeoutSetup = (values: readonly unknown[]) => {
  let valueIndex = 0;
  return vi.fn((query: { text?: string; values?: readonly unknown[] }) =>
    String(query.text).includes("set_config('statement_timeout'")
      ? Promise.resolve([{}])
      : Promise.resolve(values[valueIndex++]),
  );
};

describe("release authority ACL readiness observation", () => {
  it("observes direct, transitive, inherited, and SET owner-role privilege paths", async () => {
    const queryRaw = withTimeoutSetup([
      [{ authorityPresent: true }],
      [{ schemaVersion: 0, migrationManifest: [] }],
    ]);
    const harness = transactionHarness(queryRaw);

    await observeReleaseAuthorityDatabaseReadiness(harness.prisma as never);

    const sql = sqlText(queryRaw);
    expect(sql).toContain("candidate.rolcanlogin");
    expect(sql).toContain("candidate.rolsuper");
    expect(sql).toContain("'reviewrouter_release_control'");
    expect(sql).toContain("authority_namespace.nspowner, 'MEMBER'");
    expect(sql).toContain("authority_namespace.nspowner, 'USAGE'");
    expect(sql).toContain("authority_namespace.nspowner, 'SET'");
    expect(sql).toContain("pg_auth_members edge");
    expect(sql).toContain("granted.rolname=ANY");
    expect(sql).toContain("member.rolname=ANY");
    expect(sql).toContain("role.rolbypassrls");
    expect(sql).toContain('AS "authorityRoleTopologyExact"');
    expect(sql).toContain('AS "catalogExact"');
    expect(sql).toContain('AS "defaultAclExact"');
    expect(sql).toContain('AS "finalAclExact"');
    expect(sql).toContain("pg_catalog.pg_default_acl");
    expect(sql).toContain("expected_execute(routine_name,role_name)");
    expect(sql).toContain("attribute.attacl IS NOT NULL");
    expect(sql).toContain("type_record.typacl IS NOT NULL");
    expect(sql).not.toContain("pg_get_functiondef");
    expect(sql).not.toContain(" LIKE ");
  });

  it("attests activation routines, guard objects, inbound role edges, and runtime bounds", async () => {
    const queryRaw = withTimeoutSetup([
      [
        {
          authorityPresent: false,
          installerRoutine: false,
          readerRoutine: false,
        },
      ],
    ]);
    const harness = transactionHarness(queryRaw);

    await observeReleaseAuthorityDatabaseReadiness(harness.prisma as never);

    const sql = sqlText(queryRaw);
    expect(sql).toContain("p.prosecdef");
    expect(sql).toContain(
      "p.proconfig=ARRAY['search_path=pg_catalog, pg_temp']",
    );
    expect(sql).toContain("installerRoutineBodySha256");
    expect(sql).toContain("readerRoutineBodySha256");
    expect(sql).toContain(") bodies(ordinal,body_sha256)),'')");
    expect(sql).not.toContain(") bodies(ordinal,body_sha256))),'')");
    expect(sql).toContain(
      "activation_permit','activation_receipt','activation_principal_evidence",
    );
    expect(sql).toContain("assert_no_activation_receipt");
    expect(sql).toContain("project_effective_principal_authority(text)");
    expect(sql).toContain("validate_principal_evidence(text,bigint)");
    expect(sql).toContain("stage_principal_evidence(text)");
    expect(sql).toContain("activate_generation(text)");
    expect(sql).toContain("aclexplode(coalesce(p.proacl,acldefault");
    expect(sql).not.toContain(
      "stage_principal_evidence(text,jsonb,jsonb,jsonb,jsonb,jsonb",
    );
    expect(sql).toContain("pg_auth_members edge");
    expect(sql).toContain("rolbypassrls");
  });

  it("pins the exact catalog observation to one bounded read-only transaction", async () => {
    const queryRaw = withTimeoutSetup([
      [{ authorityPresent: true }],
      [{ schemaVersion: 0, migrationManifest: [] }],
    ]);
    const harness = transactionHarness(queryRaw);

    await observeReleaseAuthorityDatabaseReadiness(harness.prisma as never, {
      poolWaitMilliseconds: 123,
      lockTimeoutMilliseconds: 321,
      statementTimeoutMilliseconds: 432,
      transactionTimeoutMilliseconds: 543,
    });

    expect(harness.transaction).toHaveBeenCalledOnce();
    expect(harness.prisma.$queryRaw).not.toHaveBeenCalled();
    expect(harness.executeRawUnsafe).toHaveBeenCalledWith(
      "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY",
    );
    expect(harness.released()).toBe(true);
    const sql = sqlText(queryRaw);
    expect(queryRaw.mock.calls[0]?.[0]?.values).toEqual(["432ms", "321ms"]);
    expect(harness.transaction.mock.calls[0]?.[1]).toEqual({
      maxWait: 123,
      timeout: 543,
    });
    expect(sql).toContain("pg_catalog.aclexplode");
    expect(sql).toContain("'release_authority'::text");
    expect(sql).not.toContain("CREATE ");
    expect(sql).not.toContain("CREATE TEMP");
  });

  it("cannot assemble identity, catalog, and manifest from mixed pool sessions", async () => {
    const manifest = [
      {
        position: 1,
        migrationName: "000001_release_authority",
        checksumSha256: `sha256:${"a".repeat(64)}`,
        byteVariant: "canonical",
      },
    ];
    const queryRaw = withTimeoutSetup([
      [
        {
          authorityPresent: true,
          databaseIdentity: {
            serverIdentity: "1",
            databaseIdentity: "10",
            databaseName: "authority",
          },
        },
      ],
      [{ schemaVersion: 12, migrationManifest: [] }],
      [{ migrationManifest: manifest }],
    ]);
    const harness = transactionHarness(queryRaw);

    const observed = await observeReleaseAuthorityDatabaseReadiness(
      harness.prisma as never,
    );

    expect(observed.migrationManifest).toEqual(manifest);
    expect(harness.transaction).toHaveBeenCalledOnce();
    expect(harness.prisma.$queryRaw).not.toHaveBeenCalled();
    expect(harness.released()).toBe(true);
  });

  it("skips the authority catalog phase for activation-only databases", async () => {
    const queryRaw = withTimeoutSetup([
      [
        {
          roleName: "reviewrouter_activation_permit_installer",
          systemIdentifier: "target-system",
          postgresMajor: 17,
          authorityPresent: false,
          installerRoutine: true,
          readerRoutine: false,
          activationNamespaceFingerprint: `sha256:${"a".repeat(64)}`,
        },
      ],
      [
        {
          applicationMigrationManifestIdentity: `sha256:${"b".repeat(64)}`,
        },
      ],
    ]);
    const harness = transactionHarness(queryRaw);

    const readiness = await observeReleaseAuthorityDatabaseReadiness(
      harness.prisma as never,
    );

    expect(queryRaw).toHaveBeenCalledTimes(3);
    expect(readiness).toMatchObject({
      schemaVersion: 0,
      catalogExact: false,
      installerRoutine: true,
      readerRoutine: false,
      applicationMigrationManifestIdentity: `sha256:${"b".repeat(64)}`,
    });
    expect(sqlText(queryRaw)).toContain(
      "read_activation_migration_manifest_identity()",
    );
    expect(sqlText(queryRaw)).toContain("reviewrouter_activation");
    expect(sqlText(queryRaw)).not.toContain("WITH facts AS");
  });

  it("cancels before checkout and releases a failed pinned observation", async () => {
    const aborted = new AbortController();
    aborted.abort();
    const unused = transactionHarness(vi.fn());
    await expect(
      observeReleaseAuthorityDatabaseReadiness(unused.prisma as never, {
        signal: aborted.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(unused.transaction).not.toHaveBeenCalled();

    const failed = transactionHarness(
      vi.fn((query: { text?: string }) =>
        String(query.text).includes("set_config")
          ? Promise.resolve([{}])
          : Promise.reject(new Error("statement timeout")),
      ),
    );
    await expect(
      observeReleaseAuthorityDatabaseReadiness(failed.prisma as never),
    ).rejects.toThrow("statement timeout");
    expect(failed.released()).toBe(true);
  });
});
