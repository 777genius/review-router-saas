import { describe, expect, it } from "vitest";
import {
  assertHistorical89ExecutionPreconditions,
  assertHistorical89OriginalConnectAcl,
  renderHistorical89AdmissionRestoreSql,
  renderHistorical89AdmissionRestrictionSql,
  renderHistorical89AdmittedRoles,
  renderHistorical89BackupQuiescenceGuardSql,
  renderHistorical89ConnectAclSql,
  renderHistorical89FleetQuiescenceGuardSql,
  renderHistorical89SessionDrainSql,
} from "./render-historical89-execution-boundary.mjs";

const entry = (
  grantee: string,
  privilege: string,
  granteeOid: string,
  grantable = false,
) => ({
  grantee,
  granteeOid,
  grantor: "reviewrouter",
  grantorOid: "10",
  privilege,
  grantable,
});
const observation = {
  version: 1,
  database: "review_router_dimy",
  allowConnections: true,
  connectionLimit: -1,
  owner: "reviewrouter",
  raw: "{reviewrouter=CTc/reviewrouter,=Tc/reviewrouter,reviewrouter_api=c/reviewrouter}",
  entries: [
    entry("PUBLIC", "CONNECT", "0"),
    entry("reviewrouter", "CONNECT", "16390"),
    entry("reviewrouter_api", "CONNECT", "16391"),
    entry("PUBLIC", "TEMPORARY", "0"),
    entry("reviewrouter", "CREATE", "16390"),
  ],
  connectCapableRoles: [
    {
      role: "reviewrouter_api",
      canLogin: true,
      superuser: false,
      writesMigratedTables: true,
    },
  ],
  backends: [],
};

describe("historical89 execution boundary", () => {
  it("reads the EFFECTIVE database ACL so a default PUBLIC CONNECT is visible", () => {
    expect(renderHistorical89ConnectAclSql).toContain(
      "acldefault('d'::\"char\"",
    );
    // A database whose datacl is still NULL admits every login role; the
    // projection has to say so rather than report "no grants".
    const acl = assertHistorical89OriginalConnectAcl({
      ...observation,
      raw: null,
    });
    expect(acl.materializesDefaultAcl).toBe(true);
    expect(acl.withdraw.map((row) => row.grantee)).toEqual([
      "PUBLIC",
      "reviewrouter_api",
    ]);
    expect(acl.retain.map((row) => row.grantee)).toEqual(["reviewrouter"]);
  });

  it("refuses a CONNECT grant this coordinator cannot revoke", () => {
    expect(() =>
      assertHistorical89OriginalConnectAcl({
        ...observation,
        entries: [
          ...observation.entries,
          {
            ...entry("reviewrouter_worker", "CONNECT", "16392"),
            grantor: "postgres",
          },
        ],
      }),
    ).toThrow("connect_grantor_unavailable");
  });

  it.each([
    [
      "a duplicated entry",
      { entries: [...observation.entries, entry("PUBLIC", "CONNECT", "0")] },
    ],
    ["a database that refuses connections", { allowConnections: false }],
    ["a foreign owner", { owner: "postgres" }],
    ["an empty ACL", { entries: [] }],
    ["an unknown extra field", { extra: true }],
  ])("rejects %s", (_label, change) => {
    expect(() =>
      assertHistorical89OriginalConnectAcl({
        ...observation,
        ...(change as never),
      }),
    ).toThrow("render_historical89_boundary_rejected");
  });

  it("withdraws only CONNECT and restores every entry with its original grantor", () => {
    const restrict = renderHistorical89AdmissionRestrictionSql(observation);
    expect(restrict).toContain(
      'REVOKE CONNECT ON DATABASE "review_router_dimy" FROM PUBLIC GRANTED BY "reviewrouter";',
    );
    expect(restrict).toContain(
      'REVOKE CONNECT ON DATABASE "review_router_dimy" FROM "reviewrouter_api" GRANTED BY "reviewrouter";',
    );
    // TEMPORARY and CREATE are never touched, and the owner keeps CONNECT.
    expect(restrict).not.toMatch(/(?:REVOKE|GRANT) TEMPORARY/u);
    expect(restrict).not.toMatch(/(?:REVOKE|GRANT) CREATE/u);
    expect(restrict).not.toContain('FROM "reviewrouter" GRANTED BY');
    expect(restrict).toContain(renderHistorical89SessionDrainSql);
    const restore = renderHistorical89AdmissionRestoreSql(observation);
    expect(restore).toContain(
      'GRANT CONNECT ON DATABASE "review_router_dimy" TO PUBLIC GRANTED BY "reviewrouter";',
    );
    expect(restore).toContain(
      'REVOKE CONNECT ON DATABASE "review_router_dimy" FROM "reviewrouter_operation_custody_reader";',
    );
    expect(restore).toContain("historical89_restore_not_exact");
    expect(renderHistorical89AdmittedRoles).toEqual([
      "reviewrouter",
      "reviewrouter_operation_custody_reader",
    ]);
  });

  it("guards observers, admission and privileged backends inside the transaction", () => {
    expect(renderHistorical89FleetQuiescenceGuardSql).toContain(
      "historical89_fleet_not_quiesced",
    );
    expect(renderHistorical89FleetQuiescenceGuardSql).toContain(
      "historical89_admission_open",
    );
    expect(renderHistorical89FleetQuiescenceGuardSql).toContain(
      "historical89_privileged_backend_present",
    );
    expect(renderHistorical89FleetQuiescenceGuardSql).toContain(
      "historical89_ledger_locked_elsewhere",
    );
  });

  it("guards observers and privileged backends before admission restriction", () => {
    expect(renderHistorical89BackupQuiescenceGuardSql).toContain(
      "historical89_fleet_not_quiesced",
    );
    expect(renderHistorical89BackupQuiescenceGuardSql).not.toContain(
      "historical89_admission_open",
    );
    expect(renderHistorical89BackupQuiescenceGuardSql).toContain(
      "historical89_privileged_backend_present",
    );
    expect(renderHistorical89BackupQuiescenceGuardSql).toContain(
      "historical89_ledger_locked_elsewhere",
    );
  });

  it("observes only client backends in the original CONNECT ACL", () => {
    expect(renderHistorical89ConnectAclSql).toContain(
      "a.backend_type IS NULL OR a.backend_type = 'client backend'",
    );
    expect(renderHistorical89ConnectAclSql).toContain(
      "COALESCE(a.backend_type,'client backend')",
    );
  });

  it("requires qualified recovery, closed admission, disabled automation and a durable fence", () => {
    const preconditions = {
      recovery: {
        recoveryIdentitySha256: `sha256:${"a".repeat(64)}`,
        artifactDigest: `sha256:${"b".repeat(64)}`,
        capturedAt: "2026-09-07T00:00:00.000Z",
        dumpReadable: true,
        retained: true,
      },
      admission: {
        status: "closed",
        connectAclDigest: `sha256:${"c".repeat(64)}`,
        restrictedAt: "2026-09-07T00:01:00.000Z",
      },
      automation: {
        automaticMigrationsDisabled: true,
        declaredServices: [
          {
            serviceId: "srv-d7s6hgbeo5us73djlp00",
            autoDeploy: "no",
            suspended: "suspended",
          },
        ],
      },
      fence: {
        externalFenceSha256: `sha256:${"d".repeat(64)}`,
        holder: "release-operator",
        scope: ["srv-d7s6hgbeo5us73djlp00"],
        durable: true,
        survivesCoordinatorDeath: true,
        establishedAt: "2026-09-07T00:00:30.000Z",
      },
    };
    const accepted = assertHistorical89ExecutionPreconditions(preconditions);
    expect(accepted.externalFenceSha256).toBe(
      preconditions.fence.externalFenceSha256,
    );
    for (const suspended of ["not_suspended", "suspending", "", "unknown"]) {
      expect(() =>
        assertHistorical89ExecutionPreconditions({
          ...preconditions,
          automation: {
            ...preconditions.automation,
            declaredServices: [
              { ...preconditions.automation.declaredServices[0], suspended },
            ],
          },
        }),
      ).toThrow("automation_service");
    }
    const otherService = "srv-disposableworker";
    const fleet = {
      ...preconditions,
      automation: {
        ...preconditions.automation,
        declaredServices: [
          ...preconditions.automation.declaredServices,
          { serviceId: otherService, autoDeploy: "no", suspended: "suspended" },
        ],
      },
    };
    expect(() =>
      assertHistorical89ExecutionPreconditions({
        ...fleet,
        fence: { ...fleet.fence, scope: [otherService, ...fleet.fence.scope] },
      }),
    ).not.toThrow();
    const sparseScope = [otherService, "removed"];
    delete sparseScope[1];
    Object.assign(sparseScope, { unexpected: true });
    expect(() =>
      assertHistorical89ExecutionPreconditions({
        ...fleet,
        fence: { ...fleet.fence, scope: sparseScope },
      }),
    ).toThrow("fence_not_durable");
    for (const scope of [
      fleet.fence.scope,
      [otherService, otherService],
      [otherService, "srv-undeclared"],
      [otherService, ...fleet.fence.scope, "srv-undeclared"],
    ]) {
      expect(() =>
        assertHistorical89ExecutionPreconditions({
          ...fleet,
          fence: { ...fleet.fence, scope },
        }),
      ).toThrow("fence_scope_mismatch");
    }
    // The one thing a nonsuperuser owner cannot promise is stated, not hidden.
    expect(accepted.privilegedConcurrentMutation).toBe("detected-and-refused");
    for (const [label, change] of [
      [
        "unverified restore",
        { recovery: { ...preconditions.recovery, dumpReadable: false } },
      ],
      [
        "open admission",
        { admission: { ...preconditions.admission, status: "open" } },
      ],
      [
        "automatic migrations",
        {
          automation: {
            ...preconditions.automation,
            automaticMigrationsDisabled: false,
          },
        },
      ],
      [
        "an auto-deploying service",
        {
          automation: {
            ...preconditions.automation,
            declaredServices: [
              {
                serviceId: "srv-d7s6hgbeo5us73djlp00",
                autoDeploy: "yes",
                suspended: "suspended",
              },
            ],
          },
        },
      ],
      [
        "no declared services",
        { automation: { ...preconditions.automation, declaredServices: [] } },
      ],
      [
        "a non-durable fence",
        { fence: { ...preconditions.fence, durable: false } },
      ],
      [
        "a fence that dies with its coordinator",
        { fence: { ...preconditions.fence, survivesCoordinatorDeath: false } },
      ],
      ["an unscoped fence", { fence: { ...preconditions.fence, scope: [] } }],
    ] as const)
      expect(
        () =>
          assertHistorical89ExecutionPreconditions({
            ...preconditions,
            ...(change as never),
          }),
        `rejects ${label}`,
      ).toThrow("render_historical89_boundary_rejected");
  });
});
