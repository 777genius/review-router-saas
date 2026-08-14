import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  decomposePostgresConnection,
  effectivePrincipalInventorySql,
  PostgreSqlGenerationAdapter,
} from "./postgres-generation";
import type { CommandExecutor } from "./process-command";
import {
  evaluateEffectivePrincipalInventory,
  PrincipalCapability,
  type EffectivePrincipalPolicy,
} from "../domain/effective-principal-inventory";

const sourceGeneration = {
  renderResourceId: "dpg-source",
  internalHostname: "source.internal",
  databaseName: "reviewrouter",
  systemIdentifier: "100",
  majorVersion: 16,
  recoveryWitnessSha256: "witness",
} as const;
const runtimeRoleNames = [
  "reviewrouter_api",
  "reviewrouter_web",
  "reviewrouter_worker",
  "reviewrouter_codex_effect_authority",
];
const principalPolicy = (fenced: boolean): EffectivePrincipalPolicy => ({
  version: 1,
  publicPermissions: [],
  principals: [
    {
      principal: "admin",
      mayLogin: true,
      inherit: true,
      connectionLimit: -1,
      validUntil: null,
      permissions: [
        {
          capability: PrincipalCapability.Connect,
          resource: "database:reviewrouter",
        },
      ],
    },
    ...runtimeRoleNames.map((principal) => ({
      principal,
      mayLogin: true,
      inherit: true,
      connectionLimit: -1,
      validUntil: null,
      permissions: fenced
        ? []
        : [
            {
              capability: PrincipalCapability.Connect,
              resource: "database:reviewrouter",
            },
          ],
    })),
  ],
});

describe("PostgreSQL secret and connection boundary", () => {
  it("decomposes private URLs into nonsecret argv and a non-workspace 0600 passfile", () => {
    const connection = decomposePostgresConnection(
      "postgresql://runtime:s3cret@source.internal:5432/reviewrouter?sslmode=require",
    );
    const passfile = connection.env.PGPASSFILE!;
    expect(connection.args.join(" ")).not.toContain("s3cret");
    expect(JSON.stringify(connection.env)).not.toContain("s3cret");
    expect(passfile).toMatch(/\/rr-pgpass-[^/]+\/pgpass$/u);
    expect(readFileSync(passfile, "utf8")).toContain("s3cret");
    connection.cleanup();
    expect(existsSync(passfile)).toBe(false);
  });
  it.each(["localhost", "db.example.com", "public.render.com"])(
    "rejects public hostname %s",
    (host) => {
      expect(() =>
        decomposePostgresConnection(`postgresql://u:p@${host}/db`),
      ).toThrow("postgres_generation_connection_invalid");
    },
  );
});

describe("PostgreSQL effective-principal catalog adapter", () => {
  it("projects role attributes through the roles CTE alias", () => {
    expect(effectivePrincipalInventorySql).toContain(
      "SELECT role.name, capability, resource, 'attribute', true, role.name",
    );
    expect(effectivePrincipalInventorySql).not.toContain("role.rolname");
  });

  it("casts the internal-char default ACL object type before resource concatenation", () => {
    expect(effectivePrincipalInventorySql).toContain(
      "defaults.defaclobjtype::text||':'||coalesce(namespace.nspname,'*')",
    );
    expect(effectivePrincipalInventorySql).not.toContain(
      "defaults.defaclobjtype||':'||coalesce(namespace.nspname,'*')",
    );
  });

  it("enumerates login attributes, membership options, ownership, and every write surface", () => {
    for (const token of [
      "rolcanlogin",
      "rolsuper",
      "rolbypassrls",
      "rolreplication",
      "rolcreatedb",
      "rolcreaterole",
      "pg_auth_members",
      "set_option",
      "inherit_option",
      "owner:database",
      "owner:schema",
      "owner:object",
      "table:insert",
      "column:update",
      "sequence:update",
      "routine:execute",
      "pg_default_acl",
      "type:usage",
      "PUBLIC",
    ])
      expect(effectivePrincipalInventorySql).toContain(token);
  });
});

describe("target generation pre-binding", () => {
  const target = {
    renderResourceId: "dpg-target",
    internalHostname: "target.internal",
    databaseName: "reviewrouter",
    systemIdentifier: "200",
    majorVersion: 17,
    recoveryWitnessSha256: "b".repeat(64),
  } as const;

  it.each([
    null,
    JSON.stringify({
      version: 1,
      systemIdentifier: "200",
      recoveryWitnessSha256: "b".repeat(64),
    }),
  ])("accepts a fresh or already idempotently bound target: %s", (binding) => {
    const adapter = new PostgreSqlGenerationAdapter({
      execute: vi.fn(() => ({
        stdout: `${JSON.stringify({ systemIdentifier: "200", majorVersion: 17, databaseName: "reviewrouter", binding })}\n`,
      })),
      hashStdout: vi.fn(),
      executeExpectingFailure: vi.fn(),
    });
    expect(
      adapter.observeTargetBeforeBinding(
        "postgresql://reviewrouter_role_bootstrap:s@target.internal/reviewrouter",
        target,
      ),
    ).toBe(target);
  });

  it("rejects a foreign comment before restore", () => {
    const adapter = new PostgreSqlGenerationAdapter({
      execute: vi.fn(() => ({
        stdout: `${JSON.stringify({ systemIdentifier: "200", majorVersion: 17, databaseName: "reviewrouter", binding: '{"recoveryWitnessSha256":"foreign"}' })}\n`,
      })),
      hashStdout: vi.fn(),
      executeExpectingFailure: vi.fn(),
    });
    expect(() =>
      adapter.observeTargetBeforeBinding(
        "postgresql://reviewrouter_role_bootstrap:s@target.internal/reviewrouter",
        target,
      ),
    ).toThrow("postgres_generation_unbound_target_identity_mismatch");
  });
});

describe("source quiescence", () => {
  it("requires observed writer suspension, committed effective ACL denial, bounded zeros, and failed reconnect probes", () => {
    let inventoryCalls = 0;
    const execute = vi.fn((_command, args: readonly string[]) => {
      const sql = args.at(-1) ?? "";
      if (sql.includes("recoveryWitnessSha256"))
        return {
          stdout: `${JSON.stringify({ systemIdentifier: "100", majorVersion: 16, internalHostname: "source.internal", databaseName: "reviewrouter", recoveryWitnessSha256: "witness" })}\n`,
        };
      if (sql.includes("SELECT system_identifier::text"))
        return { stdout: "100\n" };
      if (sql.includes("'sessionPrincipal',session_user")) {
        inventoryCalls += 1;
        const connected =
          inventoryCalls === 1 ? ["admin", ...runtimeRoleNames] : ["admin"];
        return {
          stdout: `${JSON.stringify({
            version: 1,
            database: "reviewrouter",
            sessionPrincipal: "admin",
            roles: ["admin", ...runtimeRoleNames].map((name) => ({
              name,
              canLogin: true,
              inherit: true,
              superuser: false,
              bypassRls: false,
              replication: false,
              createDatabase: false,
              createRole: false,
              connectionLimit: -1,
              validUntil: null,
            })),
            memberships: [],
            grants: connected.map((principal) => ({
              principal,
              capability: "database:connect",
              resource: "database:reviewrouter",
              source: "privilege",
            })),
          })}\n`,
        };
      }
      if (sql.includes("json_build_object('role',current_user")) {
        const role = args[args.indexOf("--username") + 1];
        return {
          stdout: `${JSON.stringify({ role, systemIdentifier: "100" })}\n`,
        };
      }
      if (sql.includes("json_build_object('effectiveConnectDenied'"))
        return {
          stdout:
            '{"effectiveConnectDenied":true,"publicConnectDenied":true,"membershipSha256":"abc"}\n',
        };
      if (sql.startsWith("SELECT count(*) FROM pg_stat_activity"))
        return { stdout: "0\n" };
      if (sql.includes("'activeLeaseIds'"))
        return {
          stdout:
            '{"activeLeaseIds":["lease-1"],"fetchedSetupIds":["setup-1"],"pendingIntentIds":[],"intentStatuses":["completed","failed"]}\n',
        };
      if (
        sql.includes(
          "FROM release_authority.source_database_fence WHERE rollout_id",
        )
      )
        return {
          stdout: `${JSON.stringify({ fenceId: "source-fence:rollout-1", rolloutId: "rollout-1", sourceSystemIdentifier: "100", authorityPrincipal: "admin", priorConnectAclSha256: `sha256:${"b".repeat(64)}`, lifecycle: "active", observedAt: "2026-08-12T00:00:00.000Z" })}\n`,
        };
      if (sql.includes("SET fenced_inventory_sha256")) return { stdout: "t\n" };
      return { stdout: "" };
    });
    const commands: CommandExecutor = {
      execute,
      hashStdout: vi.fn(),
      executeExpectingFailure: vi
        .fn()
        .mockReturnValue({ reason: "database_connect_permission_denied" }),
    };
    const observedAt = [
      new Date("2026-08-12T00:00:00.000Z"),
      new Date("2026-08-12T00:00:00.200Z"),
    ];
    const adapter = new PostgreSqlGenerationAdapter(
      commands,
      () => observedAt.shift()!,
    );
    const urls = Object.fromEntries(
      runtimeRoleNames.map((role) => [
        role,
        `postgresql://${role}:secret@source.internal/reviewrouter`,
      ]),
    );
    const result = adapter.quiesceSource({
      adminUrl: "postgresql://admin:secret@source.internal/reviewrouter",
      source: sourceGeneration,
      rolloutId: "rollout-1",
      fenceId: "source-fence:rollout-1",
      beforePolicy: principalPolicy(false),
      fencedPolicy: principalPolicy(true),
      writerSuspension: {
        services: [
          {
            serviceId: "srv-api",
            suspended: true,
            observedAt: "2026-08-12T00:00:00.000Z",
          },
        ],
        complete: true,
      },
      reconnectUrls: urls,
    });
    expect(result.evidence.stabilizationSeries).toEqual([0, 0, 0]);
    expect(result.evidence.reconnectDeniedRoles).toHaveLength(4);
    expect(result.evidence.fence).toMatchObject({
      fenceId: "source-fence:rollout-1",
      lifecycle: "active",
    });
    expect(result.evidence.legacyAmbiguity).toMatchObject({
      stable: true,
      activeLeaseIds: ["lease-1"],
      fetchedSetupIds: ["setup-1"],
    });
    expect(
      execute.mock.calls.some((call) =>
        String(call[1].at(-1)).includes("source_database_fence"),
      ),
    ).toBe(true);
    const fenceSql = String(
      execute.mock.calls
        .find((call) =>
          String(call[1].at(-1)).includes(
            "source database fence replay mismatch",
          ),
        )?.[1]
        .at(-1),
    );
    expect(fenceSql).toContain("prior_connect_acl");
    expect(fenceSql).toContain("rolname<>session_user");
    expect(fenceSql).toContain("pg_terminate_backend");
    expect(fenceSql.indexOf("COMMIT;")).toBeLessThan(
      fenceSql.indexOf("pg_terminate_backend"),
    );
  });

  it("never synthesizes writer suspension and fails if any reconnect succeeds", () => {
    const adapter = new PostgreSqlGenerationAdapter({
      execute: vi.fn(),
      hashStdout: vi.fn(),
      executeExpectingFailure: vi.fn(),
    });
    expect(() =>
      adapter.quiesceSource({
        adminUrl: "postgresql://admin:s@source.internal/db",
        source: sourceGeneration,
        rolloutId: "rollout-1",
        fenceId: "source-fence:rollout-1",
        beforePolicy: principalPolicy(false),
        fencedPolicy: principalPolicy(true),
        writerSuspension: { services: [], complete: true },
        reconnectUrls: {},
      }),
    ).toThrow("postgres_generation_writers_not_observably_suspended");
  });
});

describe("source fence recovery", () => {
  it("replays the durable active fence without replacing the saved ACL", () => {
    const roles = ["admin", ...runtimeRoleNames].map((name) => ({
      name,
      canLogin: true,
      inherit: true,
      superuser: false,
      bypassRls: false,
      replication: false,
      createDatabase: false,
      createRole: false,
      connectionLimit: -1,
      validUntil: null,
    }));
    const inventory = {
      version: 1 as const,
      database: "reviewrouter",
      sessionPrincipal: "admin",
      roles,
      memberships: [],
      grants: [
        {
          principal: "admin",
          capability: PrincipalCapability.Connect,
          resource: "database:reviewrouter",
          source: "privilege" as const,
        },
      ],
    };
    const beforeInventory = {
      ...inventory,
      grants: ["admin", ...runtimeRoleNames].map((principal) => ({
        principal,
        capability: PrincipalCapability.Connect,
        resource: "database:reviewrouter",
        source: "privilege" as const,
      })),
    };
    const before = evaluateEffectivePrincipalInventory(
      beforeInventory,
      principalPolicy(false),
    );
    const fenced = evaluateEffectivePrincipalInventory(
      inventory,
      principalPolicy(true),
    );
    const execute = vi.fn((_command, args: readonly string[]) => {
      const sql = String(args.at(-1));
      if (sql.includes("recoveryWitnessSha256"))
        return {
          stdout: `${JSON.stringify({ systemIdentifier: "100", majorVersion: 16, internalHostname: "source.internal", databaseName: "reviewrouter", recoveryWitnessSha256: "witness" })}\n`,
        };
      if (sql.includes("to_regclass")) return { stdout: "t\n" };
      if (
        sql.includes(
          "FROM release_authority.source_database_fence WHERE rollout_id",
        )
      )
        return {
          stdout: `${JSON.stringify({ version: 1, fenceId: "source-fence:rollout-1", rolloutId: "rollout-1", sourceSystemIdentifier: "100", authorityPrincipal: "admin", beforeInventorySha256: before.inventorySha256, fencedInventorySha256: fenced.inventorySha256, beforePolicySha256: before.policySha256, fencedPolicySha256: fenced.policySha256, priorConnectAclSha256: `sha256:${"e".repeat(64)}`, lifecycle: "active", observedAt: "2026-08-12T00:00:00.000Z" })}\n`,
        };
      if (sql.includes("'sessionPrincipal',session_user"))
        return { stdout: `${JSON.stringify(inventory)}\n` };
      if (sql.includes("SET fenced_inventory_sha256")) return { stdout: "t\n" };
      return { stdout: "" };
    });
    const adapter = new PostgreSqlGenerationAdapter({
      execute,
      hashStdout: vi.fn(),
      executeExpectingFailure: vi.fn(),
    });
    expect(
      adapter.establishSourceFence({
        adminUrl: "postgresql://admin:secret@source.internal/reviewrouter",
        source: sourceGeneration,
        rolloutId: "rollout-1",
        fenceId: "source-fence:rollout-1",
        beforePolicy: principalPolicy(false),
        fencedPolicy: principalPolicy(true),
      }),
    ).toMatchObject({
      fencedInventorySha256: fenced.inventorySha256,
      lifecycle: "active",
    });
    expect(
      execute.mock.calls.some((call) =>
        String(call[1].at(-1)).includes("INTO prior_acl"),
      ),
    ).toBe(false);
  });

  it("restores the exact persisted CONNECT ACL and proves the original inventory", () => {
    const inventory = {
      version: 1 as const,
      database: "reviewrouter",
      sessionPrincipal: "admin",
      roles: ["admin", ...runtimeRoleNames].map((name) => ({
        name,
        canLogin: true,
        inherit: true,
        superuser: false,
        bypassRls: false,
        replication: false,
        createDatabase: false,
        createRole: false,
        connectionLimit: -1,
        validUntil: null,
      })),
      memberships: [],
      grants: ["admin", ...runtimeRoleNames].map((principal) => ({
        principal,
        capability: PrincipalCapability.Connect,
        resource: "database:reviewrouter",
        source: "privilege" as const,
      })),
    };
    const before = evaluateEffectivePrincipalInventory(
      inventory,
      principalPolicy(false),
    );
    const fencedInventory = {
      ...inventory,
      grants: inventory.grants.filter((grant) => grant.principal === "admin"),
    };
    const fenced = evaluateEffectivePrincipalInventory(
      fencedInventory,
      principalPolicy(true),
    );
    let inventoryReads = 0;
    const execute = vi.fn((_command, args: readonly string[]) => {
      const sql = String(args.at(-1));
      if (sql.includes("recoveryWitnessSha256"))
        return {
          stdout: `${JSON.stringify({ systemIdentifier: "100", majorVersion: 16, internalHostname: "source.internal", databaseName: "reviewrouter", recoveryWitnessSha256: "witness" })}\n`,
        };
      if (sql.includes("'sessionPrincipal',session_user"))
        return {
          stdout: `${JSON.stringify(inventoryReads++ === 0 ? fencedInventory : inventory)}\n`,
        };
      if (sql.includes("source database fence restore attestation mismatch"))
        return {
          stdout: `${JSON.stringify({ lifecycle: "released", sourceSystemIdentifier: "100" })}\n`,
        };
      return { stdout: "" };
    });
    const adapter = new PostgreSqlGenerationAdapter({
      execute,
      hashStdout: vi.fn(),
      executeExpectingFailure: vi.fn(),
    });
    expect(
      adapter.restoreSourceFence({
        adminUrl: "postgresql://admin:secret@source.internal/reviewrouter",
        source: sourceGeneration,
        beforePolicy: principalPolicy(false),
        fence: {
          version: 1,
          fenceId: "source-fence:rollout-1",
          rolloutId: "rollout-1",
          sourceSystemIdentifier: "100",
          authorityPrincipal: "admin",
          beforeInventorySha256: before.inventorySha256,
          fencedInventorySha256: fenced.inventorySha256,
          beforePolicySha256: before.policySha256,
          fencedPolicySha256: `sha256:${"d".repeat(64)}`,
          priorConnectAclSha256: `sha256:${"e".repeat(64)}`,
          lifecycle: "active",
          observedAt: "2026-08-12T00:00:00.000Z",
        },
      }),
    ).toMatchObject({ sourceWritesRestored: true });
    const restoreSql = String(
      execute.mock.calls
        .find((call) =>
          String(call[1].at(-1)).includes(
            "source database fence restore attestation mismatch",
          ),
        )?.[1]
        .at(-1),
    );
    expect(restoreSql).toContain(
      "jsonb_array_elements(fence.prior_connect_acl)",
    );
    expect(restoreSql).toContain("WITH GRANT OPTION");
    expect(restoreSql).toContain("lifecycle='released'");
  });
});

describe("generation equivalence", () => {
  it("streams table rows and binds the complete catalog matrix", async () => {
    const execute = vi.fn((_command, args: readonly string[]) => {
      const sql = args.at(-1) ?? "";
      if (sql.includes("json_agg(n.nspname||'.'||c.relname"))
        return { stdout: '["public.items"]\n' };
      if (sql.includes("'sessionPrincipal',session_user"))
        return {
          stdout: `${JSON.stringify({ version: 1, database: "db", sessionPrincipal: "a", roles: [{ name: "a", canLogin: true, inherit: true, superuser: false, bypassRls: false, replication: false, createDatabase: false, createRole: false, connectionLimit: -1, validUntil: null }], memberships: [], grants: [] })}\n`,
        };
      return { stdout: "[]\n" };
    });
    const hashStdout = vi
      .fn()
      .mockResolvedValue({ rows: 3, sha256: `sha256:${"a".repeat(64)}` });
    const adapter = new PostgreSqlGenerationAdapter({
      execute,
      hashStdout,
      executeExpectingFailure: vi.fn(),
    });
    const result = await adapter.verifyEquivalence(
      "postgresql://a:s@source.internal/db",
      "postgresql://a:s@target.internal/db",
      ["public"],
      {
        source: {
          version: 1,
          publicPermissions: [],
          principals: [
            {
              principal: "a",
              mayLogin: true,
              inherit: true,
              connectionLimit: -1,
              validUntil: null,
              permissions: [],
            },
          ],
        },
        target: {
          version: 1,
          publicPermissions: [],
          principals: [
            {
              principal: "a",
              mayLogin: true,
              inherit: true,
              connectionLimit: -1,
              validUntil: null,
              permissions: [],
            },
          ],
        },
      },
    );
    expect(result.evidence.streamingHash).toBe(true);
    expect(Object.keys(result.evidence.catalogSha256)).toHaveLength(7);
    expect(result.evidence.effectivePrincipals.stable).toBe(true);
    expect(hashStdout).toHaveBeenCalledTimes(2);
    expect(String(hashStdout.mock.calls[0]?.[1].at(-1))).toContain(
      "COPY (SELECT",
    );
  });
});
