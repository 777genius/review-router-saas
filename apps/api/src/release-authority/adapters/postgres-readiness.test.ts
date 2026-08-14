import { describe, expect, it, vi } from "vitest";
import { observeReleaseAuthorityDatabaseReadiness } from "./postgres-readiness";

describe("release authority ACL readiness observation", () => {
  it("observes direct, transitive, inherited, and SET owner-role privilege paths", async () => {
    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce([{ authorityPresent: true }])
      .mockResolvedValue([{ schemaVersion: 0, migrationManifest: [] }]);

    await observeReleaseAuthorityDatabaseReadiness({
      $queryRaw: queryRaw,
    } as never);

    const sql = String(queryRaw.mock.calls[1]?.[0]?.text);
    expect(sql).toContain("candidate.rolcanlogin");
    expect(sql).toContain("candidate.rolsuper");
    expect(sql).toContain("'reviewrouter_release_control'");
    expect(sql).toContain("authority_namespace.nspowner, 'MEMBER'");
    expect(sql).toContain("authority_namespace.nspowner, 'USAGE'");
    expect(sql).toContain("authority_namespace.nspowner, 'SET'");
    expect(sql).toContain('AS "catalogExact"');
    expect(sql).not.toContain("pg_get_functiondef");
    expect(sql).not.toContain(" LIKE ");
  });

  it("observes the exact catalog without DDL, TEMP privileges, or connection affinity", async () => {
    const executeRawUnsafe = vi.fn().mockResolvedValue(0);
    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce([{ authorityPresent: true }])
      .mockResolvedValue([{ schemaVersion: 0, migrationManifest: [] }]);
    const prisma = {
      $executeRawUnsafe: executeRawUnsafe,
      $queryRaw: queryRaw,
      $transaction: vi.fn(),
    };

    await observeReleaseAuthorityDatabaseReadiness(prisma as never);

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(executeRawUnsafe).not.toHaveBeenCalled();
    const sql = String(queryRaw.mock.calls[1]?.[0]?.text);
    expect(sql).toContain("pg_catalog.aclexplode");
    expect(sql).toContain("'release_authority'::text");
    expect(sql).not.toContain("CREATE ");
    expect(sql).not.toContain("pg_temp");
  });

  it("skips the authority catalog serializer for activation-only databases", async () => {
    const queryRaw = vi.fn().mockResolvedValue([
      {
        roleName: "reviewrouter_activation_permit_installer",
        systemIdentifier: "target-system",
        postgresMajor: 17,
        authorityPresent: false,
        installerRoutine: true,
        readerRoutine: false,
      },
    ]);

    const readiness = await observeReleaseAuthorityDatabaseReadiness({
      $queryRaw: queryRaw,
    } as never);

    expect(queryRaw).toHaveBeenCalledOnce();
    expect(readiness).toMatchObject({
      schemaVersion: 0,
      catalogExact: false,
      installerRoutine: true,
      readerRoutine: false,
    });
    expect(String(queryRaw.mock.calls[0]?.[0]?.text)).not.toContain(
      "pg_catalog.aclexplode",
    );
  });
});
