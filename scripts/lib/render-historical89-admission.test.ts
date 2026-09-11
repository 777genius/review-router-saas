import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assertHistorical89AdmissionIdentity,
  assertHistorical89CreatedObjectAcl,
  assertHistorical89Creators,
  assertHistorical89ProviderDefaultAcl,
  qualifyHistorical89Admission,
  readHistorical89PendingIdentities,
  readReviewedHistorical89Contract,
  readReviewedHistorical89Bundle,
  readReviewedHistorical89Preparation,
  readReviewedHistorical89ExternalRecovery,
  renderHistorical89AdmissionPhase as phase,
  renderHistorical89DefaultAclSql,
  renderHistorical89ObjectAclSql,
  renderHistorical89PendingBodies,
  renderHistorical89PendingDigest,
} from "./render-historical89-admission.mjs";
import {
  assertEmptyApplicableRenderDefaultAcl,
  renderManagedEvidenceDigest,
} from "./render-schema-handoff-policy.mjs";
import { renderRetainedLedgerGuard } from "./render-retained-exclusion.mjs";

const rejected = (reason: string) =>
  new RegExp(`^render_historical89_admission_rejected:${reason}$`, "u");

const pending = readHistorical89PendingIdentities();
const pendingDigest = renderHistorical89PendingDigest(pending);
const moduleSource = readFileSync(
  new URL("./render-historical89-admission.mjs", import.meta.url),
  "utf8",
);

const creatorEvidence = () => ({
  sessionUser: "reviewrouter",
  currentUser: "reviewrouter",
  creatingRoles: ["reviewrouter"],
  roleSettings: [] as Record<string, unknown>[],
  securityDefiners: [] as Record<string, unknown>[],
  dynamicDdl: [] as Record<string, unknown>[],
  triggerCreators: [] as Record<string, unknown>[],
});

// A path that exists in the reviewed bodies but creates nothing: the ownership
// transfer 000089 issues through EXECUTE format, and the SECURITY DEFINER
// routines 000087 defines.
const reviewedPath = (identity: string) => ({
  identity,
  effectiveRole: "reviewrouter",
  createsObjects: false,
});

// Exactly the four rows observed on the production database, supplemented with
// the OID/grantor fields the old bounded observation did not carry.
const defaultAclRow = (
  oid: string,
  objectType: string,
  grantees: string[],
  privileges: string[],
  raw: string,
) => ({
  oid,
  ownerOid: "10",
  owner: "postgres",
  namespaceOid: "0",
  schema: "*",
  objectType,
  raw,
  entries: grantees.flatMap((grantee) =>
    privileges.map((privilege) => ({
      grantee,
      granteeOid:
        grantee === "PUBLIC" ? "0" : grantee === "postgres" ? "10" : "16389",
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
    defaultAclRow(
      "16401",
      "S",
      ["postgres", "reviewrouter"],
      ["SELECT", "UPDATE", "USAGE"],
      "{postgres=rwU/postgres,reviewrouter=rwU/postgres}",
    ),
    defaultAclRow(
      "16402",
      "T",
      ["PUBLIC", "postgres", "reviewrouter"],
      ["USAGE"],
      "{=U/postgres,postgres=U/postgres,reviewrouter=U/postgres}",
    ),
    defaultAclRow(
      "16403",
      "f",
      ["PUBLIC", "postgres", "reviewrouter"],
      ["EXECUTE"],
      "{=X/postgres,postgres=X/postgres,reviewrouter=X/postgres}",
    ),
    defaultAclRow(
      "16404",
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
      "{postgres=arwdDxtm/postgres,reviewrouter=arwdDxtm/postgres}",
    ),
  ],
});

const admission = () => ({
  providerDatabaseResourceId: "dpg-da32ipmk1f9s73dttm90-a",
  systemIdentifier: "7401234567890123456",
  databaseOid: "16400",
  databaseName: "review_router_dimy",
  recoveryIdentitySha256: `sha256:${"1".repeat(64)}`,
  operationId: randomUUID(),
  providerEffectIds: ["dep-d11m6c0dl3ps73cuh2gg"],
  qualifiedAt: "2026-09-07T03:00:00.000Z",
  handoffSourceCommit: phase.handoffSourceCommit,
  cutoverSourceCommit: phase.cutoverSourceCommit,
  sourceTree: "7825f8227f3141d856c4f33a8eec9e83d1d4227c",
  pendingEntriesSha256: pendingDigest,
  authorizedBinaryArtifactDigest: `sha256:${"2".repeat(64)}`,
  baselineManifest: phase.baselineManifest,
  targetManifest: phase.targetManifest,
  originalLedgerDigest: `sha256:${"3".repeat(64)}`,
  catalogDigest: `sha256:${"a".repeat(64)}`,
  topologyDigest: `sha256:${"4".repeat(64)}`,
  ownershipDigest: `sha256:${"5".repeat(64)}`,
  aclDigest: `sha256:${"6".repeat(64)}`,
  membershipDigest: `sha256:${"7".repeat(64)}`,
  gateStatus: "closed",
  externalFenceSha256: `sha256:${"8".repeat(64)}`,
  custodyDigest: `sha256:${"9".repeat(64)}`,
});

type AclEntry = Record<string, unknown>;
const aclEntry = (
  grantee: string,
  privilege: string,
  over: AclEntry = {},
): AclEntry => ({
  grantee,
  granteeOid:
    grantee === "PUBLIC" ? "0" : grantee === "reviewrouter" ? "16389" : "16500",
  grantor: "reviewrouter",
  grantorOid: "16389",
  privilege,
  grantable: false,
  ...over,
});

const objectRow = (over: Record<string, unknown> = {}) => ({
  oid: "20001",
  source: "pg_class",
  identity: 'public."CodexOAuthWorkflowCompatibility"',
  aclType: "r",
  ownerOid: "16389",
  owner: "reviewrouter",
  raw: "{reviewrouter=arwdDxtm/reviewrouter,reviewrouter_api=r/reviewrouter}",
  effective: [
    aclEntry("reviewrouter", "SELECT"),
    aclEntry("reviewrouter_api", "SELECT"),
  ],
  ...over,
});

// A sequence left at its built-in default: acldefault('S',owner) grants only
// the owner, so 000091's CREATE SEQUENCE is admissible with a null raw ACL.
const createdSequence = () =>
  objectRow({
    oid: "20002",
    identity: 'public."RepositoryInventoryGeneration"',
    aclType: "S",
    raw: null,
    effective: [
      aclEntry("reviewrouter", "SELECT"),
      aclEntry("reviewrouter", "UPDATE"),
      aclEntry("reviewrouter", "USAGE"),
    ],
  });

const baselineObjects = () => ({
  version: 1,
  rows: [
    objectRow({ oid: "10001", identity: 'public."CodexOAuthSecretNamespace"' }),
  ],
});
const terminalObjects = (...created: Record<string, unknown>[]) => ({
  version: 1,
  rows: [
    ...baselineObjects().rows,
    ...(created.length ? created : [objectRow()]),
  ],
});
const createdAcl = (over: Record<string, unknown> = {}) =>
  assertHistorical89CreatedObjectAcl({
    baseline: baselineObjects(),
    terminal: terminalObjects(),
    creators: ["reviewrouter"],
    ...over,
  });

describe("historical89 phase contract", () => {
  it("pins 89 and 96 as the only durable endpoints", () => {
    expect(phase.kind).toBe("managed-historical89-in-place/v1");
    expect(phase.baselineCount).toBe(89);
    expect(phase.interimCount).toBe(92);
    expect(phase.targetCount).toBe(96);
    expect(phase.atomic).toBe(true);
  });

  it("uses the exact reviewed manifest boundaries", () => {
    expect(phase.baselineManifest).toBe(
      "sha256:13acb121fbc5bbdebef197d58d5e8dcfca99815e005acc0aae7988bc86d33ef2",
    );
    expect(phase.interimManifest).toBe(
      "sha256:7e53c8fe3c84c3979b6e8c6b1b8f5ded6734f2f053f0a17ae03a468a5939c063",
    );
    expect(phase.targetManifest).toBe(
      "sha256:5faad7059a2f57055086dd1571e87706c261a486e8952334401f1d91cc41c97b",
    );
  });

  it("binds both reviewed lanes the seven bodies come from", () => {
    expect(phase.handoffSourceCommit).toBe(
      "42134d9b8c263915340f910786b6826824bf30b5",
    );
    expect(phase.cutoverSourceCommit).toBe(
      "7870300e71932d8b8cf185004641470d0283cf11",
    );
  });

  it("resolves exactly seven pending bodies leaving an 89-row baseline", () => {
    expect(pending).toHaveLength(7);
    expect(pending.map((row) => row.migrationName)).toEqual([
      ...renderHistorical89PendingBodies,
    ]);
    expect(pending.every((row) => /^[a-f0-9]{64}$/u.test(row.checksum))).toBe(
      true,
    );
  });

  it("treats body order as part of the identity", () => {
    const swapped = [pending[1], pending[0], ...pending.slice(2)];
    expect(() => renderHistorical89PendingDigest(swapped)).toThrow(
      rejected("pending_digest_input"),
    );
  });

  it("rejects an added, removed or edited body", () => {
    expect(() =>
      renderHistorical89PendingDigest([...pending, pending[0]]),
    ).toThrow(rejected("pending_digest_input"));
    expect(() => renderHistorical89PendingDigest(pending.slice(1))).toThrow(
      rejected("pending_digest_input"),
    );
    expect(() => renderHistorical89PendingDigest(undefined)).toThrow(
      rejected("pending_digest_input"),
    );
    // An edited body keeps the shape but must not keep the identity.
    expect(
      renderHistorical89PendingDigest(
        pending.map((row, i) =>
          i === 3 ? { ...row, checksum: "0".repeat(64) } : row,
        ),
      ),
    ).not.toBe(pendingDigest);
  });

  it("keeps raw ACL text in the qualification projection", () => {
    // The old projection decodes only. A null-versus-empty override and an
    // unresolved identity are invisible without the raw aclitem[] text.
    expect(renderHistorical89DefaultAclSql).toContain("d.defaclacl::text");
    expect(renderHistorical89DefaultAclSql).toContain("'granteeOid'");
    expect(renderHistorical89DefaultAclSql).toContain("'grantorOid'");
    expect(renderHistorical89DefaultAclSql).toContain("pg_catalog.aclexplode");
  });

  it("projects the effective object ACL, not only the stored one", () => {
    // A routine left at its built-in default stores NULL and still grants
    // EXECUTE to PUBLIC. Only acldefault() makes that visible.
    expect(renderHistorical89ObjectAclSql).toContain("pg_catalog.acldefault");
    expect(renderHistorical89ObjectAclSql).toContain("'effective'");
    expect(renderHistorical89ObjectAclSql).toContain("o.acl::text");
  });

  it("emits read-only SQL only: this phase performs no production mutation", () => {
    const mutating =
      /\b(INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|GRANT|REVOKE|TRUNCATE|COMMIT|ROLLBACK|BEGIN|COPY|CALL|LOCK)\b/u;
    for (const sql of [
      renderHistorical89DefaultAclSql,
      renderHistorical89ObjectAclSql,
    ]) {
      expect(sql.startsWith("SET search_path = pg_catalog, public;")).toBe(
        true,
      );
      expect(mutating.test(sql)).toBe(false);
    }
  });

  it("does not touch, adopt or install the retained ledger guard", () => {
    // The predecessor custody this database never had stays required by the
    // old lane. The new admission neither installs that guard nor imports it.
    expect(moduleSource).not.toContain("render-retained-exclusion");
    expect(moduleSource).not.toContain("renderRetainedLedgerGuard");
    expect(() =>
      renderRetainedLedgerGuard({
        operationId: randomUUID(),
        implementationSha: "0".repeat(40),
      }),
    ).toThrow("render_retained_guard_binding_invalid");
  });

  it("keeps the old empty-applicable-default-ACL check rejecting this database", () => {
    // The new creator-aware branch is an addition, not a relaxation: the old
    // policy must still refuse the very observation the new one admits.
    expect(() =>
      assertEmptyApplicableRenderDefaultAcl(defaultAcl(), ["reviewrouter"]),
    ).toThrow("render_schema_handoff_rejected:default_acl_policy");
  });
});

describe("creator-aware provider default ACL policy", () => {
  it("admits exactly the four observed provider rows", () => {
    expect(() =>
      assertHistorical89ProviderDefaultAcl(defaultAcl(), ["reviewrouter"]),
    ).not.toThrow();
  });

  it("rejects an added row", () => {
    const observation = defaultAcl();
    observation.rows.push(
      defaultAclRow(
        "16405",
        "n",
        ["postgres"],
        ["USAGE"],
        "{postgres=U/postgres}",
      ),
    );
    expect(() =>
      assertHistorical89ProviderDefaultAcl(observation, ["reviewrouter"]),
    ).toThrow(rejected("default_acl_multiplicity"));
  });

  it("rejects an omitted row", () => {
    const observation = defaultAcl();
    observation.rows.pop();
    expect(() =>
      assertHistorical89ProviderDefaultAcl(observation, ["reviewrouter"]),
    ).toThrow(rejected("default_acl_multiplicity"));
  });

  it("rejects a duplicated object type at a second OID", () => {
    const observation = defaultAcl();
    observation.rows[3] = { ...observation.rows[0], oid: "16409" };
    expect(() =>
      assertHistorical89ProviderDefaultAcl(observation, ["reviewrouter"]),
    ).toThrow(rejected("default_acl_unreviewed_row"));
  });

  it("rejects the same OID observed twice", () => {
    const observation = defaultAcl();
    observation.rows[3] = {
      ...observation.rows[3],
      oid: observation.rows[0].oid,
    };
    expect(() =>
      assertHistorical89ProviderDefaultAcl(observation, ["reviewrouter"]),
    ).toThrow(rejected("default_acl_unresolved"));
  });

  it("rejects a changed privilege set", () => {
    const observation = defaultAcl();
    observation.rows[0].entries = observation.rows[0].entries.filter(
      (entry) => entry.privilege !== "USAGE",
    );
    expect(() =>
      assertHistorical89ProviderDefaultAcl(observation, ["reviewrouter"]),
    ).toThrow(rejected("default_acl_policy"));
  });

  it("rejects an added grantee", () => {
    const observation = defaultAcl();
    observation.rows[3].entries.push({
      grantee: "reviewrouter_api",
      granteeOid: "16500",
      grantor: "postgres",
      grantorOid: "10",
      privilege: "SELECT",
      grantable: false,
    });
    expect(() =>
      assertHistorical89ProviderDefaultAcl(observation, ["reviewrouter"]),
    ).toThrow(rejected("default_acl_policy"));
  });

  it("rejects a duplicated entry rather than deduplicating it", () => {
    const observation = defaultAcl();
    observation.rows[0].entries.push({ ...observation.rows[0].entries[0] });
    expect(() =>
      assertHistorical89ProviderDefaultAcl(observation, ["reviewrouter"]),
    ).toThrow(rejected("default_acl_policy"));
  });

  it("rejects a grant option", () => {
    const observation = defaultAcl();
    observation.rows[0].entries[0].grantable = true;
    expect(() =>
      assertHistorical89ProviderDefaultAcl(observation, ["reviewrouter"]),
    ).toThrow(rejected("default_acl_unresolved"));
  });

  it("rejects a grantor other than the provider owner", () => {
    const observation = defaultAcl();
    observation.rows[0].entries[0].grantor = "postgres_backup";
    observation.rows[0].entries[0].grantorOid = "16777";
    expect(() =>
      assertHistorical89ProviderDefaultAcl(observation, ["reviewrouter"]),
    ).toThrow(rejected("default_acl_unresolved"));
  });

  it("rejects a grantor OID that disagrees with the row owner", () => {
    const observation = defaultAcl();
    observation.rows[0].entries[0].grantorOid = "16777";
    expect(() =>
      assertHistorical89ProviderDefaultAcl(observation, ["reviewrouter"]),
    ).toThrow(rejected("default_acl_unresolved"));
  });

  it("rejects a schema-scoped default presented as global", () => {
    const observation = defaultAcl();
    observation.rows[0].namespaceOid = "2200";
    observation.rows[0].schema = "public";
    expect(() =>
      assertHistorical89ProviderDefaultAcl(observation, ["reviewrouter"]),
    ).toThrow(rejected("default_acl_unresolved"));
  });

  it("rejects an unresolved grantee identity in both directions", () => {
    const named = defaultAcl();
    named.rows[0].entries[0].grantee = "PUBLIC";
    expect(() =>
      assertHistorical89ProviderDefaultAcl(named, ["reviewrouter"]),
    ).toThrow(rejected("default_acl_unresolved"));
    const anonymous = defaultAcl();
    anonymous.rows[1].entries[0].granteeOid = "16389";
    expect(() =>
      assertHistorical89ProviderDefaultAcl(anonymous, ["reviewrouter"]),
    ).toThrow(rejected("default_acl_unresolved"));
    const dropped = defaultAcl();
    // A deleted role leaves the LEFT JOIN with a null rolname.
    dropped.rows[0].entries[0].grantee = null as unknown as string;
    expect(() =>
      assertHistorical89ProviderDefaultAcl(dropped, ["reviewrouter"]),
    ).toThrow(rejected("default_acl_unresolved"));
  });

  it("distinguishes a null override from an empty entry list", () => {
    const observation = defaultAcl();
    observation.rows[0].raw = null as unknown as string;
    observation.rows[0].entries = null as unknown as [];
    expect(() =>
      assertHistorical89ProviderDefaultAcl(observation, ["reviewrouter"]),
    ).toThrow(rejected("default_acl_unresolved"));
    const emptied = defaultAcl();
    emptied.rows[0].raw = "{}";
    emptied.rows[0].entries = [];
    expect(() =>
      assertHistorical89ProviderDefaultAcl(emptied, ["reviewrouter"]),
    ).toThrow(rejected("default_acl_policy"));
  });

  it("rejects a row missing or gaining a projected field", () => {
    const missing = defaultAcl() as unknown as {
      rows: Record<string, unknown>[];
    };
    delete missing.rows[0].raw;
    expect(() =>
      assertHistorical89ProviderDefaultAcl(missing, ["reviewrouter"]),
    ).toThrow(rejected("default_acl_unresolved"));
    const extra = defaultAcl();
    (extra.rows[0] as Record<string, unknown>).inherited = true;
    expect(() =>
      assertHistorical89ProviderDefaultAcl(extra, ["reviewrouter"]),
    ).toThrow(rejected("default_acl_unresolved"));
    const entryExtra = defaultAcl();
    (entryExtra.rows[0].entries[0] as Record<string, unknown>).applies = true;
    expect(() =>
      assertHistorical89ProviderDefaultAcl(entryExtra, ["reviewrouter"]),
    ).toThrow(rejected("default_acl_unresolved"));
  });

  it("rejects a default owned by one of this operation's creating roles", () => {
    // ALTER DEFAULT PRIVILEGES FOR ROLE reviewrouter WOULD initialize the
    // objects this operation creates. That is drift, not an unexpected owner.
    const observation = defaultAcl();
    observation.rows[2].owner = "reviewrouter";
    expect(() =>
      assertHistorical89ProviderDefaultAcl(observation, ["reviewrouter"]),
    ).toThrow(rejected("default_acl_creator_drift"));
  });

  it("rejects a default granted by one of this operation's creating roles", () => {
    const observation = defaultAcl();
    observation.rows[1].entries[0].grantor = "reviewrouter";
    expect(() =>
      assertHistorical89ProviderDefaultAcl(observation, ["reviewrouter"]),
    ).toThrow(rejected("default_acl_creator_drift"));
  });

  it("rejects a missing observation rather than coercing it to empty", () => {
    expect(() =>
      assertHistorical89ProviderDefaultAcl(undefined, ["reviewrouter"]),
    ).toThrow(rejected("default_acl_unknown"));
    expect(() =>
      assertHistorical89ProviderDefaultAcl({ version: 2, rows: [] }, [
        "reviewrouter",
      ]),
    ).toThrow(rejected("default_acl_unknown"));
    expect(() =>
      assertHistorical89ProviderDefaultAcl({ version: 1 }, ["reviewrouter"]),
    ).toThrow(rejected("default_acl_unknown"));
    expect(() =>
      assertHistorical89ProviderDefaultAcl({ version: 1, rows: [] }, [
        "reviewrouter",
      ]),
    ).toThrow(rejected("default_acl_multiplicity"));
  });

  it("rejects an absent, duplicated or unresolved creator list", () => {
    for (const creators of [
      [],
      ["reviewrouter", "reviewrouter"],
      [""],
      [null],
      "reviewrouter",
      undefined,
    ])
      expect(() =>
        assertHistorical89ProviderDefaultAcl(defaultAcl(), creators),
      ).toThrow(rejected("default_acl_unknown"));
  });
});

describe("creator evidence", () => {
  it("accepts the reviewed reviewrouter creation path", () => {
    expect(assertHistorical89Creators(creatorEvidence())).toEqual([
      "reviewrouter",
    ]);
  });

  it("accepts the reviewed non-creating SECURITY DEFINER and dynamic DDL paths", () => {
    // These really exist in the seven bodies. Rejecting their mere presence
    // would make this qualifier unsatisfiable for its own reviewed source.
    expect(
      assertHistorical89Creators({
        ...creatorEvidence(),
        securityDefiners: [
          reviewedPath('public."codex_oauth_v4_v5_reattestation_transition"'),
        ],
        dynamicDdl: [reviewedPath("000089 ALTER TABLE ... OWNER TO")],
        triggerCreators: [
          reviewedPath('public."codex_oauth_workflow_compatibility_guard"'),
        ],
        roleSettings: [
          { role: "reviewrouter_api", setting: "search_path", value: "public" },
        ],
      }),
    ).toEqual(["reviewrouter"]);
  });

  it("rejects a session/current user split", () => {
    expect(() =>
      assertHistorical89Creators({
        ...creatorEvidence(),
        currentUser: "postgres",
      }),
    ).toThrow(rejected("creator_role_path"));
    expect(() =>
      assertHistorical89Creators({
        ...creatorEvidence(),
        sessionUser: "postgres",
        currentUser: "postgres",
      }),
    ).toThrow(rejected("creator_role_path"));
  });

  it("rejects an unreviewed or empty creating role set", () => {
    expect(() =>
      assertHistorical89Creators({
        ...creatorEvidence(),
        creatingRoles: ["reviewrouter", "postgres"],
      }),
    ).toThrow(rejected("creator_unreviewed"));
    expect(() =>
      assertHistorical89Creators({ ...creatorEvidence(), creatingRoles: [] }),
    ).toThrow(rejected("creator_unreviewed"));
    expect(() =>
      assertHistorical89Creators({
        ...creatorEvidence(),
        creatingRoles: "reviewrouter",
      }),
    ).toThrow(rejected("creator_unreviewed"));
  });

  it("rejects any alternative path that creates an object", () => {
    for (const key of [
      "securityDefiners",
      "dynamicDdl",
      "triggerCreators",
    ] as const)
      expect(() =>
        assertHistorical89Creators({
          ...creatorEvidence(),
          [key]: [
            { ...reviewedPath("public.installer"), createsObjects: true },
          ],
        }),
      ).toThrow(rejected(`creator_${key.toLowerCase()}`));
  });

  it("rejects an incomplete or unresolved alternative path", () => {
    for (const key of [
      "securityDefiners",
      "dynamicDdl",
      "triggerCreators",
    ] as const) {
      const incomplete = { ...reviewedPath("public.x") } as Record<
        string,
        unknown
      >;
      delete incomplete.createsObjects;
      expect(() =>
        assertHistorical89Creators({
          ...creatorEvidence(),
          [key]: [incomplete],
        }),
      ).toThrow(rejected(`creator_${key.toLowerCase()}`));
      expect(() =>
        assertHistorical89Creators({
          ...creatorEvidence(),
          [key]: [{ ...reviewedPath("public.x"), effectiveRole: null }],
        }),
      ).toThrow(rejected(`creator_${key.toLowerCase()}`));
      expect(() =>
        assertHistorical89Creators({
          ...creatorEvidence(),
          [key]: ["observed"],
        }),
      ).toThrow(rejected(`creator_${key.toLowerCase()}`));
    }
  });

  it("rejects a role-level setting on a creating role", () => {
    // A persisted SET on reviewrouter changes what its future sessions create
    // under, outside the transaction that would observe it.
    expect(() =>
      assertHistorical89Creators({
        ...creatorEvidence(),
        roleSettings: [
          { role: "reviewrouter", setting: "role", value: "postgres" },
        ],
      }),
    ).toThrow(rejected("creator_rolesettings"));
    expect(() =>
      assertHistorical89Creators({
        ...creatorEvidence(),
        roleSettings: [{ role: "reviewrouter_api", setting: "search_path" }],
      }),
    ).toThrow(rejected("creator_rolesettings"));
  });

  it("rejects incomplete creator evidence rather than defaulting it", () => {
    const partial = creatorEvidence() as Record<string, unknown>;
    delete partial.dynamicDdl;
    expect(() => assertHistorical89Creators(partial)).toThrow(
      rejected("creator_evidence_unknown"),
    );
    expect(() =>
      assertHistorical89Creators({ ...creatorEvidence(), extra: 1 }),
    ).toThrow(rejected("creator_evidence_unknown"));
    expect(() => assertHistorical89Creators(undefined)).toThrow(
      rejected("creator_evidence_unknown"),
    );
    for (const key of [
      "roleSettings",
      "securityDefiners",
      "dynamicDdl",
      "triggerCreators",
    ] as const)
      expect(() =>
        assertHistorical89Creators({ ...creatorEvidence(), [key]: {} }),
      ).toThrow(rejected("creator_evidence_unknown"));
  });
});

describe("resulting object ACLs", () => {
  it("admits created objects that carry no PUBLIC privilege", () => {
    expect(createdAcl()).toEqual([
      {
        oid: "20001",
        identity: 'public."CodexOAuthWorkflowCompatibility"',
        owner: "reviewrouter",
      },
    ]);
  });

  it("admits a sequence left at its owner-only built-in default", () => {
    expect(
      assertHistorical89CreatedObjectAcl({
        baseline: baselineObjects(),
        terminal: terminalObjects(createdSequence()),
        creators: ["reviewrouter"],
      }),
    ).toHaveLength(1);
  });

  it("rejects a routine left at its built-in PUBLIC EXECUTE default", () => {
    // acldefault('f',owner) grants EXECUTE to PUBLIC. A routine created without
    // an explicit REVOKE is exactly as exposed as one granted to PUBLIC.
    expect(() =>
      assertHistorical89CreatedObjectAcl({
        baseline: baselineObjects(),
        terminal: terminalObjects(
          objectRow({
            oid: "20003",
            source: "pg_proc",
            aclType: "f",
            identity: 'public."codex_oauth_workflow_compatibility_guard"()',
            raw: null,
            effective: [
              aclEntry("PUBLIC", "EXECUTE"),
              aclEntry("reviewrouter", "EXECUTE"),
            ],
          }),
        ),
        creators: ["reviewrouter"],
      }),
    ).toThrow(rejected("object_acl_public_grant"));
  });

  it("rejects a grant option, a foreign creator and a foreign grantor", () => {
    expect(() =>
      createdAcl({
        terminal: terminalObjects(
          objectRow({
            effective: [
              aclEntry("reviewrouter", "SELECT", { grantable: true }),
            ],
          }),
        ),
      }),
    ).toThrow(rejected("object_acl_grant_option"));
    expect(() =>
      createdAcl({
        terminal: terminalObjects(
          objectRow({ owner: "reviewrouter_release_schema_owner" }),
        ),
      }),
    ).toThrow(rejected("object_acl_creator"));
    expect(() =>
      createdAcl({
        terminal: terminalObjects(
          objectRow({
            effective: [
              aclEntry("reviewrouter", "SELECT", {
                grantor: "postgres",
                grantorOid: "10",
              }),
            ],
          }),
        ),
      }),
    ).toThrow(rejected("object_acl_grantor"));
  });

  it("rejects an unresolved owner, grantee or grantor identity", () => {
    expect(() =>
      createdAcl({ terminal: terminalObjects(objectRow({ owner: null })) }),
    ).toThrow(rejected("object_acl_unresolved"));
    expect(() =>
      createdAcl({
        terminal: terminalObjects(
          objectRow({
            effective: [aclEntry("reviewrouter", "SELECT", { grantor: null })],
          }),
        ),
      }),
    ).toThrow(rejected("object_acl_unresolved"));
    expect(() =>
      createdAcl({
        terminal: terminalObjects(
          objectRow({
            effective: [
              aclEntry("reviewrouter", "SELECT", { granteeOid: "0" }),
            ],
          }),
        ),
      }),
    ).toThrow(rejected("object_acl_unresolved"));
  });

  it("rejects a duplicated entry and a duplicated object row", () => {
    expect(() =>
      createdAcl({
        terminal: terminalObjects(
          objectRow({
            effective: [
              aclEntry("reviewrouter", "SELECT"),
              aclEntry("reviewrouter", "SELECT"),
            ],
          }),
        ),
      }),
    ).toThrow(rejected("object_acl_multiplicity"));
    expect(() =>
      createdAcl({
        terminal: { version: 1, rows: [objectRow(), objectRow()] },
      }),
    ).toThrow(rejected("object_acl_unresolved"));
  });

  it("rejects a null raw ACL that decoded to nothing", () => {
    // acldefault always yields the owner's privileges; an empty decode of a
    // null ACL is a broken observation, not an object without grants.
    expect(() =>
      createdAcl({
        terminal: terminalObjects(objectRow({ raw: null, effective: [] })),
      }),
    ).toThrow(rejected("object_acl_unresolved"));
  });

  it("rejects a malformed or missing projection", () => {
    for (const observation of [
      undefined,
      { version: 2, rows: [] },
      { version: 1 },
      { version: 1, rows: [{ ...objectRow(), extra: 1 }] },
    ]) {
      expect(() => createdAcl({ terminal: observation })).toThrow(
        /^render_historical89_admission_rejected:object_acl_(unknown|unresolved)$/u,
      );
      expect(() => createdAcl({ baseline: observation })).toThrow(
        /^render_historical89_admission_rejected:object_acl_(unknown|unresolved)$/u,
      );
    }
    expect(() => createdAcl({ creators: [] })).toThrow(
      rejected("object_acl_unknown"),
    );
  });

  it("rejects a terminal state that created nothing", () => {
    expect(() => createdAcl({ terminal: baselineObjects() })).toThrow(
      rejected("object_acl_no_created_objects"),
    );
  });
});

describe("admission identity", () => {
  it("accepts a complete identity and returns its evidence digest", () => {
    const value = admission();
    expect(assertHistorical89AdmissionIdentity(value)).toBe(
      renderManagedEvidenceDigest(value),
    );
  });

  it("rejects a missing or extra field", () => {
    for (const key of Object.keys(admission())) {
      const value = admission() as Record<string, unknown>;
      delete value[key];
      expect(() => assertHistorical89AdmissionIdentity(value)).toThrow(
        rejected("admission_shape"),
      );
    }
    expect(() =>
      assertHistorical89AdmissionIdentity({ ...admission(), extra: 1 }),
    ).toThrow(rejected("admission_shape"));
  });

  it("rejects a non-plain admission object", () => {
    for (const value of [
      undefined,
      null,
      "admission",
      [admission()],
      Object.assign(Object.create(null), admission()),
      new (class {
        constructor() {
          Object.assign(this, admission());
        }
      })(),
    ])
      expect(() => assertHistorical89AdmissionIdentity(value)).toThrow(
        rejected("admission_shape"),
      );
  });

  it("rejects any database other than the one this phase exists for", () => {
    expect(() =>
      assertHistorical89AdmissionIdentity({
        ...admission(),
        providerDatabaseResourceId: "srv-d7s6hgbeo5us73djlp00",
      }),
    ).toThrow(rejected("provider_resource_identity"));
    // A different Render database of the same shape is still a different one.
    expect(() =>
      assertHistorical89AdmissionIdentity({
        ...admission(),
        providerDatabaseResourceId: "dpg-zz99zzzz9z9z99zzzz99-a",
      }),
    ).toThrow(rejected("provider_resource_identity"));
    expect(() =>
      assertHistorical89AdmissionIdentity({
        ...admission(),
        databaseName: "review_router_other",
      }),
    ).toThrow(rejected("database_identity"));
    for (const systemIdentifier of ["0", "", "74012345678901234a"])
      expect(() =>
        assertHistorical89AdmissionIdentity({
          ...admission(),
          systemIdentifier,
        }),
      ).toThrow(rejected("database_identity"));
    expect(() =>
      assertHistorical89AdmissionIdentity({ ...admission(), databaseOid: "0" }),
    ).toThrow(rejected("database_identity"));
  });

  it("rejects a non-canonical operation identity", () => {
    for (const operationId of [
      "operation-1",
      "",
      randomUUID().toUpperCase(),
      `${randomUUID()} `,
    ])
      expect(() =>
        assertHistorical89AdmissionIdentity({ ...admission(), operationId }),
      ).toThrow(rejected("operation_identity"));
  });

  it("requires real provider effect ids, without duplicates", () => {
    for (const providerEffectIds of [
      [],
      ["dep-a", "dep-a"],
      ["dep a"],
      [""],
      "dep-a",
      [`dep-${"a".repeat(200)}`],
    ])
      expect(() =>
        assertHistorical89AdmissionIdentity({
          ...admission(),
          providerEffectIds,
        }),
      ).toThrow(rejected("provider_effect_identity"));
  });

  it("rejects a qualification time that is not a canonical instant", () => {
    for (const qualifiedAt of [
      "2026-09-07T03:00:00Z",
      "2026-09-07 03:00:00.000Z",
      "2026-13-07T03:00:00.000Z",
      "2026-09-31T03:00:00.000Z",
      1757214000000,
    ])
      expect(() =>
        assertHistorical89AdmissionIdentity({ ...admission(), qualifiedAt }),
      ).toThrow(rejected("qualification_time"));
  });

  it("rejects a source identity other than the two reviewed lanes", () => {
    expect(() =>
      assertHistorical89AdmissionIdentity({
        ...admission(),
        handoffSourceCommit: "0".repeat(40),
      }),
    ).toThrow(rejected("source_identity"));
    expect(() =>
      assertHistorical89AdmissionIdentity({
        ...admission(),
        cutoverSourceCommit: phase.handoffSourceCommit,
      }),
    ).toThrow(rejected("source_identity"));
    expect(() =>
      assertHistorical89AdmissionIdentity({
        ...admission(),
        sourceTree: "7825f822",
      }),
    ).toThrow(rejected("source_identity"));
  });

  it("rejects a restated pending digest that does not match source", () => {
    // The admission may only restate what the reviewed checkout already fixes:
    // a client-supplied digest never becomes the authority root.
    for (const pendingEntriesSha256 of [
      `sha256:${"0".repeat(64)}`,
      pendingDigest.toUpperCase(),
      "",
    ])
      expect(() =>
        assertHistorical89AdmissionIdentity({
          ...admission(),
          pendingEntriesSha256,
        }),
      ).toThrow(rejected("pending_entries_identity"));
  });

  it("rejects an unauthorized binary artifact identity", () => {
    for (const authorizedBinaryArtifactDigest of [
      "",
      "2".repeat(64),
      `sha256:${"2".repeat(63)}`,
      `SHA256:${"2".repeat(64)}`,
    ])
      expect(() =>
        assertHistorical89AdmissionIdentity({
          ...admission(),
          authorizedBinaryArtifactDigest,
        }),
      ).toThrow(rejected("binary_artifact_identity"));
  });

  it("rejects a transition that is not 89 to 96", () => {
    expect(() =>
      assertHistorical89AdmissionIdentity({
        ...admission(),
        targetManifest: phase.interimManifest,
      }),
    ).toThrow(rejected("transition_contract"));
    expect(() =>
      assertHistorical89AdmissionIdentity({
        ...admission(),
        baselineManifest: phase.interimManifest,
      }),
    ).toThrow(rejected("transition_contract"));
  });

  it("rejects missing qualified evidence", () => {
    for (const key of [
      "originalLedgerDigest",
      "catalogDigest",
      "topologyDigest",
      "ownershipDigest",
      "aclDigest",
      "membershipDigest",
      "custodyDigest",
      "externalFenceSha256",
    ])
      for (const value of [
        "sha256:not-a-digest",
        `sha256:${"A".repeat(64)}`,
        null,
      ])
        expect(() =>
          assertHistorical89AdmissionIdentity({ ...admission(), [key]: value }),
        ).toThrow(rejected("qualified_evidence_missing"));
    expect(() =>
      assertHistorical89AdmissionIdentity({
        ...admission(),
        recoveryIdentitySha256: "",
      }),
    ).toThrow(rejected("recovery_identity"));
  });

  it("requires the gate to be closed before the operation", () => {
    for (const gateStatus of ["open", "opening", "", "OPEN", null])
      expect(() =>
        assertHistorical89AdmissionIdentity({ ...admission(), gateStatus }),
      ).toThrow(rejected("closed_gate_required"));
  });
});

describe("qualification", () => {
  it("fails closed: no independently qualified registry exists yet", () => {
    // Deliberate. A production-shaped capture has no independent approval in
    // this checkout, so qualification cannot succeed here by construction.
    for (const read of [
      readReviewedHistorical89Contract,
      readReviewedHistorical89Bundle,
      readReviewedHistorical89Preparation,
      readReviewedHistorical89ExternalRecovery,
    ])
      expect(() => read()).toThrow(rejected("independent_review_missing"));
    expect(() =>
      qualifyHistorical89Admission({
        admission: admission(),
        defaultAcl: defaultAcl(),
        creatorEvidence: creatorEvidence(),
      }),
    ).toThrow(rejected("independent_review_missing"));
  });

  it("keeps the registry unreachable from any caller input", () => {
    // Neither a CLI path, an environment value nor a fixture may populate it.
    expect(moduleSource).not.toContain("process.env");
    expect(moduleSource).not.toContain("process.argv");
    expect(moduleSource).toContain('"managed-historical89-in-place/v1": null,');
  });

  it("rejects an unknown admission kind", () => {
    for (const kind of [
      "managed-schema-handoff",
      "managed-retained-upgrade",
      "managed-historical89-in-place/v2",
      "",
    ])
      expect(() => readReviewedHistorical89Contract(kind)).toThrow(
        rejected("admission_kind"),
      );
  });

  it("refuses caller-supplied expectations outright", () => {
    // A digest sent by the client never becomes the authority root, and a
    // matching capture never becomes an approval by carrying its own digest.
    for (const reviewedExpectations of [
      { baselineManifest: phase.baselineManifest },
      null,
      {},
    ])
      expect(() =>
        qualifyHistorical89Admission({
          admission: admission(),
          defaultAcl: defaultAcl(),
          creatorEvidence: creatorEvidence(),
          reviewedExpectations,
        }),
      ).toThrow(rejected("caller_supplied_expectations"));
  });

  it("validates identity, creators and ACLs before consulting the registry", () => {
    // Order matters: a malformed admission must not reach the registry and be
    // reported as a mere "missing review".
    expect(() =>
      qualifyHistorical89Admission({
        admission: { ...admission(), gateStatus: "open" },
        defaultAcl: defaultAcl(),
        creatorEvidence: creatorEvidence(),
      }),
    ).toThrow(rejected("closed_gate_required"));
    expect(() =>
      qualifyHistorical89Admission({
        admission: admission(),
        defaultAcl: defaultAcl(),
        creatorEvidence: {
          ...creatorEvidence(),
          dynamicDdl: [
            { ...reviewedPath("public.installer"), createsObjects: true },
          ],
        },
      }),
    ).toThrow(rejected("creator_dynamicddl"));
    expect(() =>
      qualifyHistorical89Admission({
        admission: admission(),
        defaultAcl: { version: 1, rows: [] },
        creatorEvidence: creatorEvidence(),
      }),
    ).toThrow(rejected("default_acl_multiplicity"));
  });
});
