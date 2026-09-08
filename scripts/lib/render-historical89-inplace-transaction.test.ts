import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  historical89InPlaceCustodyBinding,
  reconcileHistorical89InPlaceOperation,
} from "./render-historical89-operation.mjs";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { stripAtomicMigrationEnvelope } from "../run-codex-rotating-release-migration.mjs";
import {
  assertEmptyApplicableRenderDefaultAcl,
  readRenderManagedCheckoutInventory,
  renderManagedEvidenceDigest,
} from "./render-schema-handoff-policy.mjs";
import {
  qualifyHistorical89Admission,
  readHistorical89PendingIdentities,
  renderHistorical89AdmissionPhase as phase,
  renderHistorical89PendingDigest,
} from "./render-historical89-admission.mjs";
import { renderSchemaHandoffTransaction } from "./render-schema-handoff-transaction.mjs";
import { renderRetainedLedgerGuard } from "./render-retained-exclusion.mjs";
import {
  assertHistorical89InPlaceAclDelta,
  assertHistorical89InPlaceInputs,
  classifyHistorical89InPlaceOutcome,
  inspectHistorical89InPlaceLedger,
  renderHistorical89InPlaceMarkers,
  renderHistorical89InPlaceTransaction,
} from "./render-historical89-inplace-transaction.mjs";

const inventory = readRenderManagedCheckoutInventory();
const ledger = (count: number) =>
  inventory.slice(0, count).map((r, i) => ({
    migrationName: r.migrationName,
    checksum: r.checksum,
    id: `00000000-0000-0000-0000-${String(i + 1).padStart(12, "0")}`,
    startedAt: "2026-08-01T00:00:00.000001Z",
    finishedAt: "2026-08-01T00:00:01.000001Z",
    rolledBackAt: null,
    appliedStepsCount: 1,
    logsPresent: false,
    hasLogs: false,
    logsDigest: null,
  }));
const originalMembership = {
  role: "reviewrouter_release_schema_owner",
  member: "reviewrouter",
  grantor: "postgres",
  adminOption: true,
  inheritOption: false,
  setOption: false,
};
const baselineCatalog = {
  version: 1,
  serverVersionNum: 170010,
  database: "review_router_dimy",
  sessionUser: "reviewrouter",
  currentUser: "reviewrouter",
  facts: [
    {
      family: "authority",
      fact: {
        roles: [
          {
            name: "reviewrouter_release_schema_owner",
            canLogin: false,
            superuser: false,
            bypassRls: false,
            replication: false,
            createDatabase: false,
            createRole: false,
          },
          {
            name: "reviewrouter_release_migration",
            canLogin: true,
            superuser: false,
            bypassRls: false,
            replication: false,
            createDatabase: false,
            createRole: false,
          },
        ],
      },
    },
  ],
};
// The four reviewed provider rows, in the exact shape the 1A projection emits.
const providerRow = (
  oid: string,
  objectType: string,
  grantees: string[],
  privileges: string[],
) => ({
  oid,
  ownerOid: "10",
  owner: "postgres",
  namespaceOid: "0",
  schema: "*",
  objectType,
  raw: `{postgres=X/postgres}`,
  entries: grantees.flatMap((grantee) =>
    privileges.map((privilege) => ({
      grantee,
      granteeOid:
        grantee === "PUBLIC" ? "0" : grantee === "postgres" ? "10" : "20",
      grantor: "postgres",
      grantorOid: "10",
      privilege,
      grantable: false,
    })),
  ),
});
const defaultAcl = () => ({
  version: 1,
  rows: [
    providerRow(
      "101",
      "S",
      ["postgres", "reviewrouter"],
      ["SELECT", "UPDATE", "USAGE"],
    ),
    providerRow("102", "T", ["PUBLIC", "postgres", "reviewrouter"], ["USAGE"]),
    providerRow(
      "103",
      "f",
      ["PUBLIC", "postgres", "reviewrouter"],
      ["EXECUTE"],
    ),
    providerRow(
      "104",
      "r",
      ["postgres", "reviewrouter"],
      [
        "INSERT",
        "SELECT",
        "UPDATE",
        "DELETE",
        "TRUNCATE",
        "REFERENCES",
        "TRIGGER",
        "MAINTAIN",
      ],
    ),
  ],
});
const creatorEvidence = () => ({
  sessionUser: "reviewrouter",
  currentUser: "reviewrouter",
  creatingRoles: ["reviewrouter"],
  roleSettings: [],
  securityDefiners: [
    {
      identity: "public.codex_oauth_secret_namespace_tombstone_guard()",
      effectiveRole: "reviewrouter",
      createsObjects: false,
    },
  ],
  dynamicDdl: [
    {
      identity: "000089 canonical owner transfer",
      effectiveRole: "reviewrouter",
      createsObjects: false,
    },
  ],
  triggerCreators: [],
});
const gate = { gateStatus: "closed", authzEpoch: "3", revision: "7" };
const digest = (n: number) => `sha256:${String(n).padStart(2, "0").repeat(32)}`;
const admission = (overrides: Record<string, unknown> = {}) => ({
  providerDatabaseResourceId: "dpg-da32ipmk1f9s73dttm90-a",
  systemIdentifier: "7300000000000000001",
  databaseOid: "16401",
  databaseName: "review_router_dimy",
  recoveryIdentitySha256: digest(1),
  operationId: "12345678-abcd-abcd-abcd-123456789abc",
  providerEffectIds: ["dpg-effect-1"],
  qualifiedAt: "2026-09-07T00:00:00.000Z",
  handoffSourceCommit: phase.handoffSourceCommit,
  cutoverSourceCommit: phase.cutoverSourceCommit,
  sourceTree: "b".repeat(40),
  pendingEntriesSha256: renderHistorical89PendingDigest(
    readHistorical89PendingIdentities(),
  ),
  authorizedBinaryArtifactDigest: digest(2),
  baselineManifest: phase.baselineManifest,
  targetManifest: phase.targetManifest,
  originalLedgerDigest: renderManagedEvidenceDigest(ledger(89)),
  catalogDigest: renderManagedEvidenceDigest(baselineCatalog),
  topologyDigest: digest(3),
  ownershipDigest: digest(4),
  aclDigest: renderManagedEvidenceDigest(defaultAcl()),
  membershipDigest: renderManagedEvidenceDigest([originalMembership]),
  gateStatus: "closed",
  externalFenceSha256: digest(5),
  custodyDigest: renderManagedEvidenceDigest(gate),
  ...overrides,
});
const input = (overrides: Record<string, unknown> = {}) => ({
  admission: admission(),
  ledger: ledger(89),
  originalMembership: { ...originalMembership },
  baselineCatalog,
  defaultAcl: defaultAcl(),
  creatorEvidence: creatorEvidence(),
  gate: { ...gate },
  ...overrides,
});
const build = (overrides: Record<string, unknown> = {}) =>
  renderHistorical89InPlaceTransaction(input(overrides) as never);

describe("composed historical89 to96 in-place transaction", () => {
  it("applies exactly the seven immutable bodies in one uncommitted transaction", () => {
    const { sql } = build();
    expect(
      sql.match(/^BEGIN ISOLATION LEVEL READ COMMITTED;$/gmu),
    ).toHaveLength(1);
    expect(sql.match(/^COMMIT;$/gmu)).toBeNull();
    expect(
      sql.match(/^INSERT INTO public\._prisma_migrations/gmu),
    ).toHaveLength(7);
    expect(sql.match(/^UPDATE public\._prisma_migrations/gmu)).toHaveLength(7);
    const pending = readHistorical89PendingIdentities();
    expect(pending).toHaveLength(7);
    for (const row of pending) {
      const source = readFileSync(
        `packages/platform/db/prisma/migrations/${row.migrationName}/migration.sql`,
        "utf8",
      );
      expect(sql).toContain(
        `SET LOCAL search_path = public, pg_temp;\n${stripAtomicMigrationEnvelope(source, row.migrationName)}\nSET LOCAL search_path = pg_catalog, public;`,
      );
    }
    // Application order is the reviewed order, not directory order chance.
    const positions = pending.map((row) => sql.indexOf(row.checksum));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(sql).not.toMatch(/migrate resolve|REASSIGN OWNED|DROP OWNED/u);
  });

  it("requires an authentic guardless89 and never installs, drops or adopts the retained guard", () => {
    const { sql } = build();
    expect(sql).toContain("historical89_unexpected_retained_custody");
    expect(sql).toContain(
      "to_regprocedure('public.reviewrouter_managed_retained_ledger_guard()') IS NOT NULL",
    );
    expect(sql).not.toContain(
      "DROP TRIGGER reviewrouter_managed_retained_ledger_guard",
    );
    expect(sql).not.toContain(
      "DROP FUNCTION public.reviewrouter_managed_retained_ledger_guard",
    );
    expect(sql).not.toContain(
      "CREATE TRIGGER reviewrouter_managed_retained_ledger_guard",
    );
    expect(sql).not.toContain(
      "CREATE FUNCTION public.reviewrouter_managed_retained_ledger_guard",
    );
    expect(sql).not.toContain("render_retained_guard_drift");
  });

  it("leaves the retained 89->92 wrapper and the old default-ACL policy unweakened", () => {
    // The predecessor wrapper still refuses to build without real custody.
    expect(() =>
      renderSchemaHandoffTransaction({
        ledger: ledger(89),
        retainedBinding: undefined,
        originalMembership,
      } as never),
    ).toThrow("render_retained_guard_binding_invalid");
    expect(() => renderRetainedLedgerGuard({} as never)).toThrow(
      "render_retained_guard_binding_invalid",
    );
    // The old assertion still rejects exactly the four observed provider rows.
    expect(() =>
      assertEmptyApplicableRenderDefaultAcl(
        {
          version: 1,
          rows: defaultAcl().rows.map((row) => ({
            oid: row.oid,
            owner: row.owner,
            schema: row.schema,
            objectType: row.objectType,
            entries: row.entries.map((entry) => ({
              grantee: entry.grantee,
              grantor: entry.grantor,
              privilege: entry.privilege,
              grantable: entry.grantable,
            })),
          })),
        },
        ["reviewrouter", "reviewrouter_release_schema_owner"],
      ),
    ).toThrow("default_acl_policy");
  });

  it("verifies92 inside the same transaction and keeps89 and96 as the only endpoints", () => {
    const result = build();
    const { sql } = result;
    expect(result.durableEndpoints).toEqual([89, 96]);
    expect(result.interimVerification).toBe("transaction-local");
    // Both the interim and the terminal ledger predicate protect the SAME
    // original 89 prefix; neither reduces it to a later baseline.
    expect(sql.match(/\$\[0 to 88\]/gu)).toHaveLength(2);
    expect(sql).not.toContain("$[0 to 91]");
    expect(sql).toContain(
      "(SELECT count(*) FROM public._prisma_migrations)<>92",
    );
    expect(sql).toContain(
      "(SELECT count(*) FROM public._prisma_migrations)<>96",
    );
    expect(sql).toContain("render_handoff_terminal_ledger");
    expect(sql).toContain("historical89-interim92-verified");
    expect(sql).toContain(phase.interimManifest);
    // No durable 92 receipt or checkpoint is synthesized anywhere, and the
    // only COMMIT-shaped text is the ON COMMIT DROP of the two temp tables.
    expect(sql).not.toMatch(/receipt92|checkpoint92/iu);
    expect(sql).not.toMatch(/^\s*COMMIT\s*;\s*$/mu);
    expect(sql.match(/ON COMMIT DROP/gu)).toHaveLength(2);
  });

  it("orders identity, baseline, bodies, interim and terminal exactly once each", () => {
    const { sql, markers } = build();
    expect(markers).toEqual(renderHistorical89InPlaceMarkers);
    let previous = -1;
    for (const marker of markers) {
      expect(sql.match(new RegExp(`^-- ${marker}`, "gmu"))).toHaveLength(1);
      const at = sql.indexOf(`-- ${marker}`);
      expect(at).toBeGreaterThan(previous);
      previous = at;
    }
    const order = [
      "historical89_database_identity",
      "historical89_baseline_changed",
      "render_handoff_owner_precondition",
      "ALTER SCHEMA public OWNER TO reviewrouter_release_schema_owner;",
      "-- historical89-body-1-complete",
      "render_handoff_terminal_authority",
      "historical89_interim_boundary",
      "cutover_scope_activated",
      "-- historical89-body-4-complete",
      "cutover_security_changed",
      "historical89_provider_defaults_changed",
    ];
    const at = order.map((needle) => sql.indexOf(needle));
    expect(at.every((index) => index >= 0)).toBe(true);
    expect(at).toEqual([...at].sort((a, b) => a - b));
    // The temporary self-grant is taken and released once per phase, with the
    // original provider ADMIN edge preserved by GRANTED BY ... RESTRICT.
    expect(
      sql.match(/^GRANT reviewrouter_release_schema_owner TO reviewrouter$/gmu),
    ).toHaveLength(2);
    expect(
      sql.match(
        /^REVOKE reviewrouter_release_schema_owner FROM reviewrouter$/gmu,
      ),
    ).toHaveLength(2);
    expect(sql).toContain("GRANTED BY reviewrouter RESTRICT;");
  });

  it("starts and ends at a closed gate and never opens the pool", () => {
    const { sql } = build();
    expect(sql).toContain(
      "SELECT 1 FROM public.\"HostedCodexRuntimeGate\" WHERE id='global' FOR SHARE;",
    );
    // The same closed gate observation is bound at the baseline, at the
    // transaction-local 92 boundary and at the terminal check.
    expect(sql.match(/'gateStatus',status/gu)).toHaveLength(3);
    expect(sql).not.toMatch(/UPDATE public\."HostedCodexRuntimeGate"/u);
    expect(() => build({ gate: { ...gate, gateStatus: "open" } })).toThrow(
      "closed_gate_required",
    );
    expect(() =>
      build({ admission: admission({ gateStatus: "open" }) }),
    ).toThrow("closed_gate_required");
  });

  it("is not authorization and does not create custody", () => {
    const result = build();
    expect(result.authorizesMutation).toBe(false);
    expect(result.custodyEstablished).toBe(false);
    expect(result.requiresQualifiedAdmission).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
    // The independently reviewed expectation registry is still empty, so the
    // production qualifier still fails closed.
    expect(() =>
      qualifyHistorical89Admission({
        admission: admission(),
        defaultAcl: defaultAcl(),
        creatorEvidence: creatorEvidence(),
      } as never),
    ).toThrow("independent_review_missing");
  });

  it.each([76, 88, 90, 92, 95, 96])(
    "refuses to build from a %i-row ledger",
    (count) => {
      expect(() => build({ ledger: ledger(count) })).toThrow();
    },
  );

  it.each([
    { finishedAt: null },
    { rolledBackAt: "2026-08-01T00:00:02.000001Z" },
    { hasLogs: true },
    { appliedStepsCount: 0 },
    { unknown: true },
  ])("keeps ambiguous history %# out of construction", (change) => {
    const rows = ledger(89);
    Object.assign(rows[0]!, change);
    expect(() => build({ ledger: rows })).toThrow();
  });

  it("binds every observation to the admission instead of trusting the caller", () => {
    expect(() =>
      build({ admission: admission({ originalLedgerDigest: digest(9) }) }),
    ).toThrow("original_ledger_binding");
    expect(() =>
      build({ admission: admission({ membershipDigest: digest(9) }) }),
    ).toThrow("membership_binding");
    expect(() =>
      build({ admission: admission({ catalogDigest: digest(9) }) }),
    ).toThrow("render_managed_catalog_rejected");
    expect(() =>
      build({ admission: admission({ aclDigest: digest(9) }) }),
    ).toThrow("default_acl_binding");
    expect(() =>
      build({ admission: admission({ custodyDigest: digest(9) }) }),
    ).toThrow("gate_binding");
    expect(() =>
      build({
        admission: admission({ providerDatabaseResourceId: "dpg-other-a" }),
      }),
    ).toThrow("provider_resource_identity");
    expect(() =>
      build({ admission: admission({ databaseName: "review_router_other" }) }),
    ).toThrow("database_identity");
    expect(() =>
      build({ admission: admission({ pendingEntriesSha256: digest(9) }) }),
    ).toThrow("pending_entries_identity");
  });

  it("rejects a provider default that would initialize this operation's objects", () => {
    const drift = defaultAcl();
    drift.rows[0]!.owner = "reviewrouter";
    expect(() =>
      build({
        defaultAcl: drift,
        admission: admission({
          aclDigest: renderManagedEvidenceDigest(drift),
        }),
      }),
    ).toThrow("default_acl_creator_drift");
    const grantorDrift = defaultAcl();
    grantorDrift.rows[3]!.entries[0]!.grantor = "reviewrouter";
    expect(() =>
      build({
        defaultAcl: grantorDrift,
        admission: admission({
          aclDigest: renderManagedEvidenceDigest(grantorDrift),
        }),
      }),
    ).toThrow("default_acl_creator_drift");
    const extra = defaultAcl();
    extra.rows.push(providerRow("105", "n", ["postgres"], ["USAGE"]));
    expect(() =>
      build({
        defaultAcl: extra,
        admission: admission({ aclDigest: renderManagedEvidenceDigest(extra) }),
      }),
    ).toThrow("default_acl_multiplicity");
  });

  it.each([
    ["sessionUser", "reviewrouter_release_migration"],
    ["currentUser", "postgres"],
  ])("rejects a %s creator path split", (key, value) => {
    const evidence = creatorEvidence() as Record<string, unknown>;
    evidence[key] = value;
    expect(() => build({ creatorEvidence: evidence })).toThrow(
      "creator_role_path",
    );
  });

  it("rejects an alternative path that creates objects and a role-level SET", () => {
    const creating = creatorEvidence();
    creating.securityDefiners[0]!.createsObjects = true;
    expect(() => build({ creatorEvidence: creating })).toThrow(
      "creator_securitydefiners",
    );
    const setting = creatorEvidence() as Record<string, unknown>;
    setting.roleSettings = [
      { role: "reviewrouter", setting: "search_path", value: "other" },
    ];
    expect(() => build({ creatorEvidence: setting })).toThrow(
      "creator_rolesettings",
    );
  });

  it("changes the built transaction when any bound original row changes", () => {
    const first = build().sql;
    const rows = ledger(89);
    rows[0]!.id = "11111111-1111-1111-1111-111111111111";
    expect(() => build({ ledger: rows })).toThrow("original_ledger_binding");
    expect(
      build({
        ledger: rows,
        admission: admission({
          originalLedgerDigest: renderManagedEvidenceDigest(rows),
        }),
      }).sql,
    ).not.toBe(first);
  });

  it("validates inputs without emitting SQL", () => {
    const checked = assertHistorical89InPlaceInputs(input() as never);
    expect(checked.creators).toEqual(["reviewrouter"]);
    expect(checked.ordered).toHaveLength(89);
    expect(inspectHistorical89InPlaceLedger(ledger(89)).count).toBe(89);
    expect(inspectHistorical89InPlaceLedger(ledger(96)).count).toBe(96);
    expect(() => inspectHistorical89InPlaceLedger(ledger(92))).toThrow(
      "managed_ledger_count",
    );
  });
});

const aclRow = (
  oid: string,
  identity: string,
  owner: string,
  grantees: string[] = [owner],
) => ({
  oid,
  source: "pg_proc",
  identity,
  aclType: "f",
  ownerOid: "20",
  owner,
  raw: `{${owner}=X/${owner}}`,
  effective: grantees.map((grantee) => ({
    grantee,
    granteeOid: grantee === "PUBLIC" ? "0" : "20",
    grantor: owner,
    grantorOid: "20",
    privilege: "EXECUTE",
    grantable: false,
  })),
});
const before = {
  version: 1,
  rows: [
    aclRow("900", 'public."CodexOAuthSecretNamespace"', "reviewrouter"),
    aclRow(
      "901",
      "public.codex_oauth_secret_namespace_tombstone_guard()",
      "reviewrouter",
    ),
    aclRow("902", "public.untouched()", "reviewrouter"),
  ],
};
const after = () => ({
  version: 1,
  rows: [
    aclRow(
      "900",
      'public."CodexOAuthSecretNamespace"',
      "reviewrouter_release_schema_owner",
    ),
    aclRow(
      "901",
      "public.codex_oauth_secret_namespace_tombstone_guard()",
      "reviewrouter_release_schema_owner",
    ),
    aclRow("902", "public.untouched()", "reviewrouter"),
    aclRow(
      "903",
      "public.codex_oauth_workflow_compatibility_guard()",
      "reviewrouter_release_schema_owner",
    ),
  ],
});

describe("composed historical89 ACL delta", () => {
  const creators = ["reviewrouter"];
  it("accepts exactly the two reviewed owner transfers and the created objects", () => {
    const delta = assertHistorical89InPlaceAclDelta({
      baseline: before,
      terminal: after(),
      creators,
    } as never);
    expect(delta.created.map((row) => row.oid)).toEqual(["903"]);
    expect(delta.ownerTransfers.map((row) => row.identity)).toEqual([
      'public."CodexOAuthSecretNamespace"',
      "public.codex_oauth_secret_namespace_tombstone_guard()",
    ]);
  });

  it("rejects an unreviewed owner transfer, a removal and a rename", () => {
    const extra = after();
    extra.rows[2]!.owner = "reviewrouter_release_schema_owner";
    expect(() =>
      assertHistorical89InPlaceAclDelta({
        baseline: before,
        terminal: extra,
        creators,
      } as never),
    ).toThrow("object_acl_owner_transfer");
    const removed = after();
    removed.rows = removed.rows.filter((row) => row.oid !== "902");
    expect(() =>
      assertHistorical89InPlaceAclDelta({
        baseline: before,
        terminal: removed,
        creators,
      } as never),
    ).toThrow("object_acl_removed");
    const renamed = after();
    renamed.rows[2]!.identity = "public.renamed()";
    expect(() =>
      assertHistorical89InPlaceAclDelta({
        baseline: before,
        terminal: renamed,
        creators,
      } as never),
    ).toThrow("object_acl_renamed");
  });

  it("rejects a created object with PUBLIC, a grant option or a foreign owner", () => {
    for (const [mutate, reason] of [
      [
        (rows: ReturnType<typeof after>) => {
          rows.rows[3]!.effective.push({
            grantee: "PUBLIC",
            granteeOid: "0",
            grantor: "reviewrouter_release_schema_owner",
            grantorOid: "20",
            privilege: "EXECUTE",
            grantable: false,
          });
        },
        "object_acl_public_grant",
      ],
      [
        (rows: ReturnType<typeof after>) => {
          rows.rows[3]!.effective[0]!.grantable = true;
        },
        "object_acl_grant_option",
      ],
      [
        (rows: ReturnType<typeof after>) => {
          rows.rows[3]!.owner = "postgres";
        },
        "object_acl_creator",
      ],
      [
        (rows: ReturnType<typeof after>) => {
          rows.rows[3]!.effective[0]!.grantor = "postgres";
        },
        "object_acl_grantor",
      ],
    ] as const) {
      const terminal = after();
      mutate(terminal);
      expect(() =>
        assertHistorical89InPlaceAclDelta({
          baseline: before,
          terminal,
          creators,
        } as never),
      ).toThrow(reason);
    }
  });
});

describe("composed historical89 outcome classification", () => {
  const aclDelta = assertHistorical89InPlaceAclDelta({
    baseline: before,
    terminal: after(),
    creators: ["reviewrouter"],
  } as never);
  const terminalCatalog = { ...baselineCatalog };
  const base = {
    admission: admission(),
    backendState: "terminated",
    gate: { ...gate },
    memberships: [{ ...originalMembership }],
    originalMembership: { ...originalMembership },
    terminalCatalog,
    reviewedCatalogDigest: renderManagedEvidenceDigest(terminalCatalog),
    aclDelta,
  };

  it("treats a confirmed rollback to the exact original89 as continuable, never as success", () => {
    expect(
      classifyHistorical89InPlaceOutcome({
        ...base,
        ledger: ledger(89),
        rollbackConfirmed: true,
      } as never),
    ).toEqual({
      status: "uncommitted-candidate",
      replay: false,
      requiresSameAuthorityOperation: true,
      requiresOperationBoundReceipt: true,
    });
    expect(
      classifyHistorical89InPlaceOutcome({
        ...base,
        ledger: ledger(89),
        rollbackConfirmed: false,
      } as never),
    ).toEqual({ status: "hold-closed", replay: false });
  });

  it("accepts an authentic96 with an untouched original prefix, without replay", () => {
    expect(
      classifyHistorical89InPlaceOutcome({
        ...base,
        ledger: ledger(96),
      } as never),
    ).toEqual({
      status: "committed-candidate",
      replay: false,
      requiresOperationBoundReceipt: true,
    });
  });

  it.each([
    ["unknown backend", { backendState: "unknown" }],
    ["partial ledger", { ledger: ledger(93) }],
    [
      "changed original prefix",
      {
        ledger: [
          { ...ledger(96)[0]!, id: "99999999-9999-9999-9999-999999999999" },
          ...ledger(96).slice(1),
        ],
      },
    ],
    ["missing acl delta", { aclDelta: undefined }],
    ["foreign catalog digest", { reviewedCatalogDigest: digest(9) }],
    ["temporary membership left behind", { memberships: [] }],
    ["changed gate", { gate: { ...gate, revision: "8" } }],
  ])("holds closed on %s", (_name, change) => {
    expect(
      classifyHistorical89InPlaceOutcome({
        ...base,
        ledger: ledger(96),
        ...change,
      } as never),
    ).toEqual({ status: "hold-closed", replay: false });
  });
});

describe("current permit reconciliation", () => {
  const aclDelta = assertHistorical89InPlaceAclDelta({ baseline: before, terminal: after(), creators: ["reviewrouter"] } as never);
  const plan = {
    kind: phase.kind,
    admission: admission(),
    binding: historical89InPlaceCustodyBinding(admission()),
    coordinates: { epoch: 1, generation: 1, nonce: "0".repeat(32) },
    reviewedTerminalCatalogDigest: renderManagedEvidenceDigest(baselineCatalog),
    identityDigest: renderManagedEvidenceDigest(admission()),
  };
  const currentPermit = {
    ...plan.binding,
    kind: phase.kind,
    admissionIdentityDigest: plan.identityDigest,
    terminalCatalogDigest: plan.reviewedTerminalCatalogDigest,
    epoch: "1", generation: "1", nonce: plan.coordinates.nonce, state: "open",
  };
  const evidenceBase = {
    plan, backendState: "terminated", rollbackConfirmed: true,
    ledger: ledger(89), terminalCatalog: baselineCatalog, gate,
    memberships: [originalMembership], originalMembership,
    aclDelta: undefined, receipt: null, currentPermit, fenceHeld: true,
  };
  const fenced = (evidence: Record<string, unknown>) => {
    const result = reconcileHistorical89InPlaceOperation(evidence as never);
    assert.equal(result.decision, "fenced");
    assert.equal(result.continueOperation, false);
    assert.equal(result.replay, false);
    return result;
  };
  it("exact89 rollback continues only with the matching current open permit", () => {
    assert.deepEqual(reconcileHistorical89InPlaceOperation(evidenceBase), {
      decision: "resume-same-operation", replay: false, continueOperation: true,
      requiresSameAuthorityOperation: true, requiresPermitEpochAdvance: true,
      gate: "closed", reasons: [],
    });
  });
  for (const permit of [null, undefined, {}, { ...currentPermit, extra: true }]) {
    it(`rejects missing or malformed permit (${typeof permit})`, () => {
      assert.deepEqual(fenced({ ...evidenceBase, currentPermit: permit }).reasons, ["current_permit_untrusted"]);
    });
  }
  it("omitted current permit fails closed", () => {
    const { currentPermit: omitted, ...evidence } = evidenceBase;
    fenced(evidence);
  });
  for (const [field, values] of Object.entries({
    state: ["terminal", "closed", "unknown", null],
    epoch: ["2", "0", 1], generation: ["2", "0", 1], nonce: ["1".repeat(32)],
    operationId: ["aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"],
    kind: ["other"], systemIdentifier: ["7300000000000000002"],
    databaseOid: ["16402"], databaseName: ["other"],
    recoveryIdentitySha256: [digest(9)], externalFenceSha256: [digest(9)],
    admissionIdentityDigest: [digest(9)], terminalCatalogDigest: [digest(9)],
  })) {
    for (const value of values) it(`rejects changed permit ${field}=${value}`, () => {
      assert.deepEqual(fenced({ ...evidenceBase, currentPermit: { ...currentPermit, [field]: value } }).reasons, ["current_permit_untrusted"]);
    });
  }
  it("open permit cannot override unknown outcomes or an unreadable receipt", () => {
    for (const change of [
      { backendState: "unknown" }, { rollbackConfirmed: false },
      { fenceHeld: false }, { ledger: ledger(90) }, { receipt: undefined },
      { receipt: {} },
    ]) fenced({ ...evidenceBase, ...change });
  });
  it("exact96 still requires a matching verified terminal effect receipt", () => {
    const receipt = {
      kind: phase.kind, operationId: plan.binding.operationId,
      generation: "1", epoch: "1", nonce: plan.coordinates.nonce,
      ledgerManifest: phase.targetManifest,
      terminalCatalogDigest: plan.reviewedTerminalCatalogDigest,
      backendPid: 42, transactionId: "123", recordedAt: "2026-09-08T00:00:00.000Z",
      permitState: "terminal", effectFingerprint: "",
    };
    receipt.effectFingerprint = `sha256:${createHash("sha256").update([
      receipt.kind, receipt.operationId, plan.identityDigest,
      plan.binding.systemIdentifier, plan.binding.databaseOid, plan.binding.databaseName,
      plan.binding.recoveryIdentitySha256, plan.binding.externalFenceSha256,
      receipt.generation, receipt.epoch, receipt.nonce, receipt.ledgerManifest,
      receipt.terminalCatalogDigest,
    ].join("\n")).digest("hex")}`;
    const evidence = { ...evidenceBase, ledger: ledger(96), rollbackConfirmed: false,
      aclDelta, receipt,
      currentPermit: { ...currentPermit, state: "terminal" },
    };
    assert.equal(reconcileHistorical89InPlaceOperation(evidence).decision, "reconciled-without-replay");
    for (const bad of [null, { ...receipt, nonce: "1".repeat(32) },
      { ...receipt, effectFingerprint: digest(9) }, { ...receipt, permitState: "open" }]) {
      fenced({ ...evidence, receipt: bad });
    }
  });

});
