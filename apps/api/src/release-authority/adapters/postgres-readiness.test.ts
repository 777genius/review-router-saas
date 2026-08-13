import { describe, expect, it, vi } from "vitest";
import { observeReleaseAuthorityDatabaseReadiness } from "./postgres-readiness";

describe("release authority ACL readiness observation", () => {
  it("observes direct, transitive, inherited, and SET owner-role privilege paths", async () => {
    const queryRaw = vi
      .fn()
      .mockResolvedValue([{ schemaVersion: 0, migrationManifest: [] }]);

    await observeReleaseAuthorityDatabaseReadiness({
      $queryRaw: queryRaw,
    } as never);

    const sql = String(queryRaw.mock.calls[0]?.[0]?.text);
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

  it("installs the shared exact serializer and reads the catalog on one connection", async () => {
    const executeRawUnsafe = vi.fn().mockResolvedValue(0);
    const queryRaw = vi
      .fn()
      .mockResolvedValue([{ schemaVersion: 0, migrationManifest: [] }]);
    const transaction = {
      $executeRawUnsafe: executeRawUnsafe,
      $queryRaw: queryRaw,
    };
    const prisma = {
      $executeRawUnsafe: executeRawUnsafe,
      $queryRaw: queryRaw,
      $transaction: vi.fn(
        async (operation: (client: typeof transaction) => unknown) =>
          operation(transaction),
      ),
    };

    await observeReleaseAuthorityDatabaseReadiness(prisma as never);

    expect(prisma.$transaction).toHaveBeenCalledOnce();
    expect(executeRawUnsafe).toHaveBeenCalledTimes(2);
    expect(String(executeRawUnsafe.mock.calls[0]?.[0])).toContain(
      "release_authority_acl_fingerprint",
    );
    expect(String(executeRawUnsafe.mock.calls[1]?.[0])).toContain(
      "release_authority_catalog_fingerprint",
    );
  });
});
