import { createHash } from "node:crypto";
import { readRenderHistorical96CheckoutInventory } from "./render-historical96-checkout.mjs";
import { renderManagedEvidenceDigest } from "./render-schema-handoff-policy.mjs";
import { assertHistorical89InPlaceAclDelta } from "./render-historical89-inplace-transaction.mjs";
import {
  compareHistorical89ReviewedContract,
  qualifyHistorical89Admission,
  renderHistorical89PendingDigest,
} from "./render-historical89-admission.mjs";
import { describe, expect, it } from "vitest";
import {
  authorizeHistorical89InPlaceOperation,
  historical89InPlaceCustodyBinding,
  planHistorical89InPlaceOperation,
  reconcileHistorical89InPlaceOperation,
  renderHistorical89InPlacePreflightSql,
} from "./render-historical89-operation.mjs";
import {
  readHistorical89PendingIdentities,
  renderHistorical89AdmissionPhase,
  renderHistorical89PendingBodies,
} from "./render-historical89-admission.mjs";
import {
  managedInPlaceBaselineManifest,
  managedInPlacePendingEntries,
  managedInPlacePendingMigrationNames,
  managedInPlaceTargetManifest,
  ManagedInPlaceTransitionType,
} from "../../packages/features/release-rollout/src/domain/managed-in-place-transition";

const admission = {
  operationId: "11111111-2222-3333-4444-555555555555",
  systemIdentifier: "7482837671845777452",
  databaseOid: "16385",
  databaseName: "review_router_dimy",
  recoveryIdentitySha256: `sha256:${"b".repeat(64)}`,
  externalFenceSha256: `sha256:${"c".repeat(64)}`,
};

describe("historical89 in-place operation", () => {
  it("agrees exactly with the typed domain contract about what this operation is", () => {
    // Two layers state the same operation. A drift between them would let the
    // typed authority admit a transition the SQL side would not apply.
    expect(ManagedInPlaceTransitionType).toBe(
      renderHistorical89AdmissionPhase.kind,
    );
    expect([...managedInPlacePendingMigrationNames]).toEqual([
      ...renderHistorical89PendingBodies,
    ]);
    expect(managedInPlaceBaselineManifest).toBe(
      renderHistorical89AdmissionPhase.baselineManifest,
    );
    expect(managedInPlaceTargetManifest).toBe(
      renderHistorical89AdmissionPhase.targetManifest,
    );
    const checkouts = readHistorical89PendingIdentities();
    expect(
      managedInPlacePendingEntries.map((entry) => entry.migrationSqlSha256),
    ).toEqual(checkouts.map((row: { checksum: string }) => row.checksum));
  });

  it("derives the custody binding from catalog-independent identity only", () => {
    expect(historical89InPlaceCustodyBinding(admission as never)).toEqual(
      admission,
    );
  });

  it("renders a rehearsal preflight without the permit that does not exist yet", () => {
    const binding = historical89InPlaceCustodyBinding(admission as never);
    const rehearsal = renderHistorical89InPlacePreflightSql(binding);
    expect(rehearsal).toContain("historical89_fleet_not_quiesced");
    expect(rehearsal).toContain("custody_attestation_failed");
    expect(rehearsal).not.toContain("historical89_permit_stale");
    const full = renderHistorical89InPlacePreflightSql(binding, {
      epoch: 1,
      nonce: "0".repeat(32),
      generation: 1,
      terminalCatalogDigest: `sha256:${"d".repeat(64)}`,
      admissionIdentityDigest: `sha256:${"e".repeat(64)}`,
    });
    expect(full).toContain("historical89_permit_stale");
    // The rehearsal is a strict prefix of the real preflight, so the terminal
    // catalog it observes is the one the real run reaches.
    expect(full.startsWith(rehearsal)).toBe(true);
  });

  it("never authorizes production mutation and names every blocker", () => {
    const authorization = authorizeHistorical89InPlaceOperation({
      admission: {},
      defaultAcl: {},
      creatorEvidence: {},
      terminalCatalogProvenance: "reviewed-registry",
    } as never);
    expect(authorization.authorizesProductionMutation).toBe(false);

    expect(
      authorization.blockedBy.some((reason) =>
        reason.startsWith("admission_qualification:"),
      ),
    ).toBe(true);
    const rehearsed = authorizeHistorical89InPlaceOperation({
      admission: {},
      defaultAcl: {},
      creatorEvidence: {},
      terminalCatalogProvenance: "disposable-rehearsal",
    } as never);
    expect(rehearsed.blockedBy).toContain(
      "terminal_catalog_provenance:disposable-rehearsal",
    );
  });

  it("rejects an incomplete plan input rather than rendering a partial operation", () => {
    expect(() => planHistorical89InPlaceOperation({} as never)).toThrow(
      "render_historical89_operation_rejected:plan_shape",
    );
  });

  it("fences every reconciliation it cannot resolve", () => {
    const plan = {
      kind: renderHistorical89AdmissionPhase.kind,
      binding: admission,
      coordinates: { epoch: 1, generation: 1, nonce: "0".repeat(32) },
      reviewedTerminalCatalogDigest: `sha256:${"d".repeat(64)}`,
      identityDigest: `sha256:${"e".repeat(64)}`,
    };
    const base = {
      plan,
      backendState: "terminated",
      rollbackConfirmed: true,
      ledger: [],
      terminalCatalog: {},
      gate: {},
      memberships: [],
      originalMembership: {},
      aclDelta: undefined,
      receipt: null,
      currentPermit: null,
      fenceHeld: true,
    };
    expect(
      reconcileHistorical89InPlaceOperation({
        ...base,
        fenceHeld: false,
      } as never),
    ).toMatchObject({
      decision: "fenced",
      replay: false,
      reasons: ["external_fence_not_held"],
    });
    expect(
      reconcileHistorical89InPlaceOperation({
        ...base,
        backendState: "unknown",
      } as never),
    ).toMatchObject({ reasons: ["original_backend_unresolved"] });
    expect(
      reconcileHistorical89InPlaceOperation({ plan: null } as never),
    ).toMatchObject({
      decision: "fenced",
      reasons: ["reconciliation_input_shape"],
    });
    expect(
      reconcileHistorical89InPlaceOperation({
        ...base,
        plan: { ...plan, kind: "other" },
      } as never),
    ).toMatchObject({ decision: "fenced", reasons: ["plan_untrusted"] });
    // Every outcome, including the fenced ones, refuses replay.
    for (const change of [{}, { fenceHeld: false }, { backendState: "alive" }])
      expect(
        reconcileHistorical89InPlaceOperation({ ...base, ...change } as never)
          .replay,
      ).toBe(false);
  });

  it("rejects malformed coordinates/reviewedTerminalCatalogDigest/identityDigest before classifying the outcome", () => {
    // These fields are only read inside the committed-candidate branch below,
    // but the gate must reject a malformed plan up front regardless of which
    // outcome (committed-candidate or resume-same-operation) the schema/ledger
    // observations would otherwise select.
    const validPlan = {
      kind: renderHistorical89AdmissionPhase.kind,
      binding: admission,
      coordinates: { epoch: 1, generation: 1, nonce: "0".repeat(32) },
      reviewedTerminalCatalogDigest: `sha256:${"d".repeat(64)}`,
      identityDigest: `sha256:${"e".repeat(64)}`,
    };
    // resume-same-operation shape: uncommitted candidate, no receipt.
    const resumeBase = {
      backendState: "terminated" as const,
      rollbackConfirmed: true,
      ledger: [],
      terminalCatalog: {},
      gate: {},
      memberships: [],
      originalMembership: {},
      aclDelta: undefined,
      receipt: null,
      currentPermit: null,
      fenceHeld: true,
    };
    const malformedPlans = [
      { ...validPlan, coordinates: undefined },
      {
        ...validPlan,
        coordinates: { epoch: 0, generation: 1, nonce: "0".repeat(32) },
      },
      {
        ...validPlan,
        coordinates: { epoch: 1, generation: 1, nonce: "not-a-nonce" },
      },
      { ...validPlan, reviewedTerminalCatalogDigest: "" },
      { ...validPlan, reviewedTerminalCatalogDigest: undefined },
      { ...validPlan, identityDigest: "" },
      { ...validPlan, identityDigest: undefined },
    ];
    for (const malformed of malformedPlans) {
      expect(
        reconcileHistorical89InPlaceOperation({
          ...resumeBase,
          plan: malformed,
        } as never),
      ).toMatchObject({ decision: "fenced", reasons: ["plan_untrusted"] });
    }
  });
});

// Synthetic observations; exercise the real planner, classifier and receipt validator.
describe("operation observation bindings", () => {
  const phase = renderHistorical89AdmissionPhase;
  const inventory = readRenderHistorical96CheckoutInventory();
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
      providerRow(
        "102",
        "T",
        ["PUBLIC", "postgres", "reviewrouter"],
        ["USAGE"],
      ),
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
  const digest = (n: number) =>
    `sha256:${String(n).padStart(2, "0").repeat(32)}`;
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

  const preconditions = {
    recovery: {
      recoveryIdentitySha256: admission().recoveryIdentitySha256,
      artifactDigest: `sha256:${"b".repeat(64)}`,
      qualifiedAt: "2026-09-07T00:00:00.000Z",
      restoreVerified: true,
    },
    admission: {
      status: "closed",
      connectAclDigest: renderManagedEvidenceDigest(observation),
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
      externalFenceSha256: admission().externalFenceSha256,
      holder: "release-operator",
      scope: ["srv-d7s6hgbeo5us73djlp00"],
      durable: true,
      survivesCoordinatorDeath: true,
      establishedAt: "2026-09-07T00:00:30.000Z",
    },
  };

  const planInput = () => ({
    ...input(),
    connectAcl: structuredClone(observation),
    preconditions: structuredClone(preconditions),
    coordinates: { epoch: 1, generation: 1, nonce: "0".repeat(32) },
    reviewedTerminalCatalog: baselineCatalog,
    reviewedTerminalCatalogDigest: renderManagedEvidenceDigest(baselineCatalog),
    terminalCatalogProvenance: "disposable-rehearsal",
  });

  // Synthetic only: an independent fixture expectation stays fixed while each
  // observation changes. Nothing registers this contract in production source.
  const syntheticContract = () => {
    const stable = { ...admission() } as Record<string, unknown>;
    for (const key of [
      "operationId",
      "providerEffectIds",
      "qualifiedAt",
      "recoveryIdentitySha256",
      "externalFenceSha256",
      "custodyDigest",
      "gateStatus",
    ])
      delete stable[key];
    return {
      kind: phase.kind,
      version: 1,
      comparisonPoint: "post-preparation-before-migration/v1",
      identity: stable,
      creatorEvidence: creatorEvidence(),
      terminalCatalog: structuredClone(baselineCatalog),
      terminalCatalogDigest: renderManagedEvidenceDigest(baselineCatalog),
    };
  };

  it("compares a complete synthetic contract without granting source qualification", () => {
    expect(
      compareHistorical89ReviewedContract(syntheticContract(), planInput()),
    ).toBe(true);
    const supplied = planInput();
    const {
      admission,
      defaultAcl,
      creatorEvidence,
      ledger,
      originalMembership,
      baselineCatalog,
      reviewedTerminalCatalog,
      reviewedTerminalCatalogDigest,
    } = supplied;
    const observations = {
      admission,
      defaultAcl,
      creatorEvidence,
      ledger,
      originalMembership,
      baselineCatalog,
      reviewedTerminalCatalog,
      reviewedTerminalCatalogDigest,
    };
    expect(() => qualifyHistorical89Admission(observations)).toThrow(
      "independent_review_missing",
    );
    expect(() =>
      qualifyHistorical89Admission({
        ...observations,
        reviewedExpectations: syntheticContract(),
      }),
    ).toThrow("caller_supplied_expectations");
    expect(
      authorizeHistorical89InPlaceOperation({
        ...observations,
        terminalCatalogProvenance: "reviewed-registry",
      }),
    ).toMatchObject({
      authorizesProductionMutation: false,
      blockedBy: ["admission_qualification:independent_review_missing"],
    });
  });

  it.each(Object.keys(syntheticContract().identity))(
    "rejects mismatched stable %s",
    (key) => {
      const supplied = planInput();
      const identity = supplied.admission as Record<string, unknown>;
      identity[key] = String(identity[key]).startsWith("sha256:")
        ? digest(99)
        : key === "sourceTree"
          ? "c".repeat(40)
          : String(identity[key]) + "0";
      expect(() =>
        compareHistorical89ReviewedContract(syntheticContract(), supplied),
      ).toThrow();
    },
  );

  it.each([
    "ledger",
    "originalMembership",
    "baselineCatalog",
    "defaultAcl",
    "creatorEvidence",
  ])("rejects changed actual %s with unchanged asserted digest", (key) => {
    const supplied = planInput() as Record<string, any>;
    supplied[key] = structuredClone(supplied[key]);
    if (key === "ledger")
      supplied.ledger[0].id = "00000000-0000-0000-0000-999999999999";
    else if (key === "creatorEvidence")
      supplied.creatorEvidence.dynamicDdl = [];
    else supplied[key].unexpected = true;
    expect(() =>
      compareHistorical89ReviewedContract(syntheticContract(), supplied),
    ).toThrow();
  });

  it.each([
    "sessionUser",
    "currentUser",
    "creatingRoles",
    "roleSettings",
    "securityDefiners",
    "dynamicDdl",
    "triggerCreators",
  ])("compares complete creator %s", (key) => {
    const supplied = planInput();
    const evidence = supplied.creatorEvidence as Record<string, unknown>;
    evidence[key] = key.endsWith("User")
      ? "other"
      : key === "creatingRoles"
        ? ["reviewrouter", "reviewrouter"]
        : key === "roleSettings"
          ? [{ role: "other", setting: "search_path", value: "public" }]
          : [
              {
                identity: "different reviewed path",
                effectiveRole: "reviewrouter",
                createsObjects: false,
              },
            ];
    expect(() =>
      compareHistorical89ReviewedContract(syntheticContract(), supplied),
    ).toThrow();
  });

  it("rejects a self-consistent unreviewed catalog and terminal", () => {
    for (const terminal of [false, true]) {
      const supplied = planInput();
      const changed = {
        ...baselineCatalog,
        facts: [...baselineCatalog.facts, { family: "unreviewed", fact: {} }],
      };
      if (terminal) {
        supplied.reviewedTerminalCatalog = changed as typeof baselineCatalog;
        supplied.reviewedTerminalCatalogDigest =
          renderManagedEvidenceDigest(changed);
      } else {
        supplied.baselineCatalog = changed as typeof baselineCatalog;
        supplied.admission.catalogDigest = renderManagedEvidenceDigest(changed);
      }
      expect(() =>
        compareHistorical89ReviewedContract(syntheticContract(), supplied),
      ).toThrow();
    }
  });

  it.each([undefined, null, {}, { version: 1, facts: [] }])(
    "rejects missing/malformed terminal %j",
    (value) => {
      expect(() =>
        compareHistorical89ReviewedContract(syntheticContract(), {
          ...planInput(),
          reviewedTerminalCatalog: value,
        }),
      ).toThrow();
    },
  );

  it.each([undefined, "", digest(9)])(
    "rejects missing/mismatched terminal digest %s",
    (value) => {
      expect(() =>
        compareHistorical89ReviewedContract(syntheticContract(), {
          ...planInput(),
          reviewedTerminalCatalogDigest: value,
        }),
      ).toThrow();
    },
  );

  it.each([
    "kind",
    "version",
    "comparisonPoint",
    "identity",
    "creatorEvidence",
    "terminalCatalog",
    "terminalCatalogDigest",
  ])("requires contract %s", (key) => {
    const contract = syntheticContract() as Record<string, unknown>;
    delete contract[key];
    expect(() =>
      compareHistorical89ReviewedContract(contract, planInput()),
    ).toThrow();
  });

  it("does not treat operation-specific coordinates as stable approval", () => {
    const supplied = planInput();
    supplied.admission.operationId = "99999999-abcd-abcd-abcd-123456789abc";
    supplied.admission.providerEffectIds = ["other-effect"];
    supplied.admission.qualifiedAt = "2026-09-08T00:00:00.000Z";
    supplied.admission.recoveryIdentitySha256 = digest(88);
    supplied.admission.externalFenceSha256 = digest(88);
    supplied.admission.custodyDigest = digest(88);
    expect(
      compareHistorical89ReviewedContract(syntheticContract(), supplied),
    ).toBe(true);
    // The planner still rejects these unbound recovery/fence/gate observations.
    expect(() => planHistorical89InPlaceOperation(supplied)).toThrow();
  });

  it.each([
    { version: 2 },
    { comparisonPoint: "pre-preparation/v1" },
    { unexpected: true },
  ])("rejects a changed contract schema %j", (change) => {
    expect(() =>
      compareHistorical89ReviewedContract(
        { ...syntheticContract(), ...change },
        planInput(),
      ),
    ).toThrow();
  });

  it("binds the complete original CONNECT observation and preserves its grantor", () => {
    const supplied = planInput();
    const original = structuredClone(supplied.connectAcl);
    // Canonical hashing ignores object key insertion order.
    supplied.connectAcl = Object.fromEntries(
      Object.entries(supplied.connectAcl).reverse(),
    ) as typeof supplied.connectAcl;
    const plan = planHistorical89InPlaceOperation(supplied as never);
    expect(plan.boundary.connectAclDigest).toBe(
      renderManagedEvidenceDigest(original),
    );
    expect(plan.admissionRestoreSql).toContain(
      'GRANT CONNECT ON DATABASE "review_router_dimy" TO "reviewrouter_api" GRANTED BY "reviewrouter";',
    );
    expect(supplied.connectAcl).toEqual(original);
    expect(plan.authorization.authorizesProductionMutation).toBe(false);
  });

  it("rejects a well-formed digest for a different CONNECT observation", () => {
    const supplied = planInput();
    supplied.preconditions.admission.connectAclDigest = digest(9);
    expect(() => planHistorical89InPlaceOperation(supplied as never)).toThrow(
      "render_historical89_operation_rejected:connect_acl_binding",
    );
  });

  it.each([
    [
      "grantor",
      {
        entries: observation.entries.map((e) => ({
          ...e,
          grantor: "postgres",
        })),
      },
    ],
    [
      "grantor OID",
      { entries: observation.entries.map((e) => ({ ...e, grantorOid: "11" })) },
    ],
    ["raw ACL", { raw: null }],
    ["connection limit", { connectionLimit: 10 }],
  ] as const)(
    "rejects changed %s under the original digest",
    (_name, change) => {
      const supplied = planInput();
      expect(() =>
        planHistorical89InPlaceOperation({
          ...supplied,
          connectAcl: { ...supplied.connectAcl, ...change },
        } as never),
      ).toThrow("render_historical89_operation_rejected:connect_acl_binding");
    },
  );

  const committedEvidence = () => {
    const plan = planHistorical89InPlaceOperation(planInput() as never);
    const currentPermit = {
      ...plan.binding,
      kind: phase.kind,
      admissionIdentityDigest: plan.identityDigest,
      terminalCatalogDigest: plan.reviewedTerminalCatalogDigest,
      epoch: "1",
      generation: "1",
      nonce: plan.coordinates.nonce,
      state: "terminal",
    };
    const receipt = {
      kind: phase.kind,
      operationId: plan.binding.operationId,
      epoch: "1",
      generation: "1",
      nonce: plan.coordinates.nonce,
      ledgerManifest: phase.targetManifest,
      terminalCatalogDigest: plan.reviewedTerminalCatalogDigest,
      effectFingerprint: "",
      backendPid: 42,
      transactionId: "123",
      recordedAt: "2026-09-08T00:00:00.000Z",
      permitState: "terminal",
    };
    receipt.effectFingerprint = `sha256:${createHash("sha256")
      .update(
        [
          receipt.kind,
          receipt.operationId,
          plan.identityDigest,
          plan.binding.systemIdentifier,
          plan.binding.databaseOid,
          plan.binding.databaseName,
          plan.binding.recoveryIdentitySha256,
          plan.binding.externalFenceSha256,
          receipt.generation,
          receipt.epoch,
          receipt.nonce,
          receipt.ledgerManifest,
          receipt.terminalCatalogDigest,
        ].join("\n"),
      )
      .digest("hex")}`;
    return {
      plan,
      backendState: "terminated",
      rollbackConfirmed: false,
      ledger: ledger(96),
      terminalCatalog: baselineCatalog,
      gate,
      memberships: [originalMembership],
      originalMembership,
      aclDelta: assertHistorical89InPlaceAclDelta({
        baseline: before,
        terminal: after(),
        creators: ["reviewrouter"],
      }),
      receipt,
      currentPermit,
      fenceHeld: true,
    };
  };

  it("reconciles a verified receipt with the exact current terminal permit", () => {
    const evidence = committedEvidence();
    expect(reconcileHistorical89InPlaceOperation(evidence)).toEqual({
      decision: "reconciled-without-replay",
      replay: false,
      continueOperation: false,
      requiresSameAuthorityOperation: true,
      gate: "closed",
      effectFingerprint: evidence.receipt.effectFingerprint,
      reasons: [],
    });
  });

  it.each([null, undefined, {}, { extra: true }])(
    "fences a committed schema and valid receipt with malformed permit %#",
    (currentPermit) => {
      expect(
        reconcileHistorical89InPlaceOperation({
          ...committedEvidence(),
          currentPermit,
        } as never),
      ).toMatchObject({
        decision: "fenced",
        replay: false,
        continueOperation: false,
        gate: "closed",
        reasons: ["current_permit_untrusted"],
      });
    },
  );

  it.each([
    ["state", "open"],
    ["state", "closed"],
    ["state", "consumed"],
    ["epoch", "2"],
    ["epoch", 1],
    ["generation", "2"],
    ["generation", 1],
    ["nonce", "1".repeat(32)],
    ["kind", "other"],
    ["operationId", "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"],
    ["systemIdentifier", "7300000000000000002"],
    ["databaseOid", "16402"],
    ["databaseName", "other"],
    ["recoveryIdentitySha256", digest(9)],
    ["externalFenceSha256", digest(9)],
    ["admissionIdentityDigest", digest(9)],
    ["terminalCatalogDigest", digest(9)],
    ["extra", true],
  ] as const)(
    "fences a committed receipt with mismatched permit %s=%s",
    (key, value) => {
      const evidence = committedEvidence();
      expect(
        reconcileHistorical89InPlaceOperation({
          ...evidence,
          currentPermit: { ...evidence.currentPermit, [key]: value },
        }),
      ).toMatchObject({
        decision: "fenced",
        replay: false,
        continueOperation: false,
        gate: "closed",
        reasons: ["current_permit_untrusted"],
      });
    },
  );

  it("keeps receipt verification mandatory with a matching terminal permit", () => {
    const evidence = committedEvidence();
    for (const receipt of [
      null,
      { ...evidence.receipt, effectFingerprint: digest(9) },
      { ...evidence.receipt, permitState: "open" },
    ])
      expect(
        reconcileHistorical89InPlaceOperation({ ...evidence, receipt }),
      ).toMatchObject({
        decision: "fenced",
        replay: false,
        continueOperation: false,
        gate: "closed",
      });
  });

  it("still requires confirmed rollback, no receipt and the exact open permit to resume", () => {
    const committed = committedEvidence();
    const rollback = {
      ...committed,
      ledger: ledger(89),
      rollbackConfirmed: true,
      receipt: null,
      currentPermit: { ...committed.currentPermit, state: "open" },
    };
    expect(reconcileHistorical89InPlaceOperation(rollback)).toMatchObject({
      decision: "resume-same-operation",
      replay: false,
      continueOperation: true,
      requiresPermitEpochAdvance: true,
      gate: "closed",
      reasons: [],
    });
    for (const change of [
      { rollbackConfirmed: false },
      { receipt: committed.receipt },
      { currentPermit: committed.currentPermit },
      { currentPermit: null },
      { currentPermit: { ...rollback.currentPermit, epoch: "2" } },
    ])
      expect(
        reconcileHistorical89InPlaceOperation({ ...rollback, ...change }),
      ).toMatchObject({
        decision: "fenced",
        replay: false,
        continueOperation: false,
        gate: "closed",
      });
  });
});
