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
    expect(sql).toContain(
      "candidate.rolname IN (SELECT role_name FROM expected_acl)",
    );
    expect(sql).toContain("authority_namespace.nspowner, 'MEMBER'");
    expect(sql).toContain("authority_namespace.nspowner, 'USAGE'");
    expect(sql).toContain("authority_namespace.nspowner, 'SET'");
  });
});
