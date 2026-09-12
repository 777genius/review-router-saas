import { assertHistorical89OriginalConnectAcl } from "./render-historical89-execution-boundary.mjs";
import { assertRenderManagedClosedGate } from "./render-managed-workflow-cutover.mjs";
import { readRenderHistorical96CheckoutInventory } from "./render-historical96-checkout.mjs";
import { assertRenderManagedCatalogMatches } from "./render-managed-catalog.mjs";
import { renderHistorical89AdmissionPhase } from "./render-historical89-phase.mjs";
import {
  renderManagedOperationCustodyContract,
  renderManagedOperationCustodyVerifySql,
} from "./render-managed-operation-custody.mjs";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  inspectRenderManagedLedgerRows,
  renderManagedEvidenceDigest,
} from "./render-schema-handoff-policy.mjs";

// Qualification evidence only. Nothing in this module creates custody, opens a
// gate, authorizes a mutation, connects to a database or registers a production
// root. Every exported SQL string is a read-only projection. It states one
// narrow fact: whether the CURRENT historical 89 baseline was independently
// qualified for THIS operation. It makes no claim about who executed migrations
// 1-89, about the predecessor retained phase, or about past custody. It does
// not install, adopt or weaken the retained ledger guard, which legitimately
// keeps requiring the original custody this database never had.
export { renderHistorical89AdmissionPhase };
const phase = renderHistorical89AdmissionPhase;

const fail = (reason) => {
  throw new Error(`render_historical89_admission_rejected:${reason}`);
};
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const digest = (value) => /^sha256:[a-f0-9]{64}$/u.test(value);
const uuid = (value) =>
  /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value);
const positive = (value) => /^[1-9][0-9]*$/u.test(value);
const oidOrPublic = (value) => /^(?:0|[1-9][0-9]*)$/u.test(value);
const name = (value) => typeof value === "string" && value.length > 0;
const keysOf = (value) =>
  value &&
  typeof value === "object" &&
  Object.getPrototypeOf(value) === Object.prototype
    ? Object.keys(value).sort().join()
    : null;
const shapeOf = (keys) => [...keys].sort().join();
const instant = (value) => {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
  )
    return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
};
const distinctNames = (values) =>
  Array.isArray(values) &&
  values.length > 0 &&
  values.every((value) => name(value)) &&
  new Set(values).size === values.length;

// ---------------------------------------------------------------------------
// The exact bodies this operation may apply
// ---------------------------------------------------------------------------

// The seven bodies, in application order. Three come from the managed 89->92
// contract and four from the checkout extension that the 92->96 cutover
// consumes. Both sets are already pinned in reviewed source; this list only
// fixes the order and the closure, and is cross-checked against the on-disk
// inventory so an added or edited body cannot pass.
export const renderHistorical89PendingBodies = Object.freeze([
  "000087_codex_oauth_v4_v5_workflow_reattestation",
  "000088_codex_oauth_reattestation_mutation_owner_fence",
  "000089_codex_oauth_v4_v5_staged_compatibility",
  "000089_workflow_provisioning_writer_quiescence",
  "000090_workflow_provisioning_attempt_authority",
  "000091_workflow_provisioning_artifact_and_inventory",
  "000096_hosted_pool_public_repository_eligibility",
]);

/**
 * Resolve the seven immutable SQL identities from the reviewed checkout. The
 * inventory reader already rejects hidden directories and edited bodies; this
 * additionally fixes the count, order and baseline/terminal closure so a body
 * cannot be silently added to or removed from the operation.
 */
export function readHistorical89PendingIdentities() {
  const inventory = readRenderHistorical96CheckoutInventory();
  if (inventory.length !== phase.targetCount) fail("checkout96_required");
  const baseline = inventory.filter(
    (row) => !renderHistorical89PendingBodies.includes(row.migrationName),
  );
  if (baseline.length !== phase.baselineCount) fail("baseline_closure");
  const pending = renderHistorical89PendingBodies.map((migrationName) => {
    const row = inventory.find(
      (entry) => entry.migrationName === migrationName,
    );
    if (!row) fail("pending_body_missing");
    return Object.freeze({ ...row });
  });
  return Object.freeze(pending);
}

/** Digest over the ordered seven bodies. Order is part of the identity. */
export function renderHistorical89PendingDigest(pending) {
  if (
    !Array.isArray(pending) ||
    pending.length !== renderHistorical89PendingBodies.length ||
    pending.some(
      (row, index) =>
        !row ||
        row.migrationName !== renderHistorical89PendingBodies[index] ||
        !/^[a-f0-9]{64}$/u.test(row.checksum),
    )
  )
    fail("pending_digest_input");
  return `sha256:${sha256(
    pending.map((row) => `${row.migrationName}:${row.checksum}`).join(","),
  )}`;
}

// ---------------------------------------------------------------------------
// Creator-aware provider default ACL policy
// ---------------------------------------------------------------------------

// The complete default-ACL catalog, keeping BOTH the raw aclitem[] text and the
// decoded entries. The old policy reads only decoded entries; qualification of a
// historical database must be able to detect a null-versus-empty override and an
// unresolved identity that decoding alone would hide.
export const renderHistorical89DefaultAclSql = `SET search_path = pg_catalog, public;
SELECT jsonb_build_object(
  'version',1,
  'rows',COALESCE(jsonb_agg(jsonb_build_object(
    'oid',d.oid::text,
    'ownerOid',d.defaclrole::text,'owner',owner.rolname,
    'namespaceOid',d.defaclnamespace::text,
    'schema',CASE WHEN d.defaclnamespace=0 THEN '*' ELSE n.nspname END,
    'objectType',d.defaclobjtype,
    'raw',CASE WHEN d.defaclacl IS NULL THEN NULL ELSE d.defaclacl::text END,
    'entries',CASE WHEN d.defaclacl IS NULL THEN NULL ELSE (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'grantee',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE grantee.rolname END,
        'granteeOid',a.grantee::text,
        'grantor',grantor.rolname,'grantorOid',a.grantor::text,
        'privilege',a.privilege_type,'grantable',a.is_grantable
      ) ORDER BY a.grantee,a.grantor,a.privilege_type),'[]'::jsonb)
      FROM pg_catalog.aclexplode(d.defaclacl) a
      LEFT JOIN pg_catalog.pg_roles grantee ON grantee.oid=a.grantee
      LEFT JOIN pg_catalog.pg_roles grantor ON grantor.oid=a.grantor
    ) END
  ) ORDER BY d.oid),'[]'::jsonb)
)
FROM pg_catalog.pg_default_acl d
LEFT JOIN pg_catalog.pg_roles owner ON owner.oid=d.defaclrole
LEFT JOIN pg_catalog.pg_namespace n ON n.oid=d.defaclnamespace;`;

// Exactly the four reviewed provider rows, pinned in source. PostgreSQL 17
// creates objects using the CURRENT role's defaults and does not inherit a
// member role's defaults, so these postgres-owned globals do not initialize an
// object created by reviewrouter. That conclusion is only usable once every
// creating role is separately proven, which assertHistorical89Creators does,
// and once the resulting object ACLs are checked, which
// assertHistorical89CreatedObjectAcl does.
const reviewedProviderDefaultAcl = Object.freeze([
  Object.freeze({
    objectType: "S",
    privileges: Object.freeze(["SELECT", "UPDATE", "USAGE"]),
    grantees: Object.freeze(["postgres", "reviewrouter"]),
  }),
  Object.freeze({
    objectType: "T",
    privileges: Object.freeze(["USAGE"]),
    grantees: Object.freeze(["PUBLIC", "postgres", "reviewrouter"]),
  }),
  Object.freeze({
    objectType: "f",
    privileges: Object.freeze(["EXECUTE"]),
    grantees: Object.freeze(["PUBLIC", "postgres", "reviewrouter"]),
  }),
  Object.freeze({
    objectType: "r",
    privileges: Object.freeze([
      "INSERT",
      "SELECT",
      "UPDATE",
      "DELETE",
      "TRUNCATE",
      "REFERENCES",
      "TRIGGER",
      "MAINTAIN",
    ]),
    grantees: Object.freeze(["postgres", "reviewrouter"]),
  }),
]);
const providerDefaultOwner = "postgres";
const defaultAclRowShape = shapeOf([
  "entries",
  "namespaceOid",
  "oid",
  "owner",
  "ownerOid",
  "objectType",
  "raw",
  "schema",
]);
const aclEntryShape = shapeOf([
  "grantable",
  "grantee",
  "granteeOid",
  "grantor",
  "grantorOid",
  "privilege",
]);

/**
 * Admit exactly the four observed, reviewed provider default-ACL rows and
 * nothing else. Additions, omissions, changed privileges, grant options, a
 * schema-scoped row, an unresolved identity, a null-versus-empty override and
 * creator drift are all rejected. Provider defaults are never removed or
 * rewritten by this operation; they are only qualified as non-initializing.
 *
 * @param observation result of renderHistorical89DefaultAclSql
 * @param creators the reviewed creating roles of this operation's objects
 */
export function assertHistorical89ProviderDefaultAcl(observation, creators) {
  if (
    !distinctNames(creators) ||
    observation?.version !== 1 ||
    !Array.isArray(observation.rows)
  )
    fail("default_acl_unknown");
  if (observation.rows.length !== reviewedProviderDefaultAcl.length)
    fail("default_acl_multiplicity");
  const seenOid = new Set();
  const seenType = new Set();
  for (const row of observation.rows) {
    if (keysOf(row) !== defaultAclRowShape) fail("default_acl_unresolved");
    // Creator drift first, so a default that WOULD initialize this operation's
    // objects is reported as drift rather than as a merely unexpected owner.
    // ALTER DEFAULT PRIVILEGES FOR ROLE reviewrouter is exactly that case: the
    // non-inheritance argument stops holding the moment a creating role owns or
    // grants a default.
    if (
      creators.includes(row.owner) ||
      (Array.isArray(row.entries) &&
        row.entries.some((entry) => creators.includes(entry?.grantor)))
    )
      fail("default_acl_creator_drift");
    if (
      !name(row.oid) ||
      !positive(row.oid) ||
      seenOid.has(row.oid) ||
      !name(row.ownerOid) ||
      !positive(row.ownerOid) ||
      row.owner !== providerDefaultOwner ||
      // A global default has namespace OID 0 and schema '*'. A schema-scoped
      // provider default is a different fact and is not admitted here.
      row.namespaceOid !== "0" ||
      row.schema !== "*" ||
      // A null override is not an empty one: the projection preserves both, and
      // neither may be coerced into the other.
      !name(row.raw) ||
      !Array.isArray(row.entries)
    )
      fail("default_acl_unresolved");
    seenOid.add(row.oid);
    const expected = reviewedProviderDefaultAcl.find(
      (entry) => entry.objectType === row.objectType,
    );
    if (!expected || seenType.has(row.objectType))
      fail("default_acl_unreviewed_row");
    seenType.add(row.objectType);
    const expectedEntries = expected.grantees
      .flatMap((grantee) =>
        expected.privileges.map((privilege) => `${grantee} ${privilege}`),
      )
      .sort();
    const observedEntries = [];
    for (const entry of row.entries) {
      if (
        keysOf(entry) !== aclEntryShape ||
        !name(entry.grantee) ||
        !name(entry.granteeOid) ||
        !oidOrPublic(entry.granteeOid) ||
        // PUBLIC is grantee OID 0; every named grantee must resolve.
        (entry.grantee === "PUBLIC") !== (entry.granteeOid === "0") ||
        // Every row is granted BY postgres, the provider owner, with no
        // grant option anywhere.
        entry.grantor !== providerDefaultOwner ||
        entry.grantorOid !== row.ownerOid ||
        !name(entry.privilege) ||
        entry.grantable !== false
      )
        fail("default_acl_unresolved");
      observedEntries.push(`${entry.grantee} ${entry.privilege}`);
    }
    observedEntries.sort();
    if (
      observedEntries.length !== expectedEntries.length ||
      observedEntries.some((entry, index) => entry !== expectedEntries[index])
    )
      fail("default_acl_policy");
  }
  if (seenType.size !== reviewedProviderDefaultAcl.length)
    fail("default_acl_multiplicity");
}

// ---------------------------------------------------------------------------
// Creating-role evidence
// ---------------------------------------------------------------------------

// Proving the four provider defaults do not initialize this operation's objects
// requires proving who actually creates them. The managed bodies run with
// session_user = current_user = reviewrouter; a later ownership transfer does
// not make postgres the creator.
const reviewedCreatingRoles = Object.freeze(["reviewrouter"]);

// The reviewed bodies genuinely contain SECURITY DEFINER routines and dynamic
// DDL (ALTER ... OWNER TO issued through EXECUTE format), so mere PRESENCE of
// such a path cannot be the rejection rule - that would make this qualifier
// unsatisfiable for its own reviewed source and invite later loosening. The
// rule is narrower and actually decidable: an alternative path is admissible
// only while it provably creates nothing. Any path that creates an object, and
// any unresolved role behind a path, is rejected.
const creationPathShape = shapeOf([
  "createsObjects",
  "effectiveRole",
  "identity",
]);
const roleSettingShape = shapeOf(["role", "setting", "value"]);
const creatorEvidenceShape = shapeOf([
  "creatingRoles",
  "currentUser",
  "dynamicDdl",
  "roleSettings",
  "securityDefiners",
  "sessionUser",
  "triggerCreators",
]);

/**
 * @param evidence {{sessionUser: string, currentUser: string,
 *   creatingRoles: string[],
 *   roleSettings: {role: string, setting: string, value: string}[],
 *   securityDefiners: {identity: string, effectiveRole: string, createsObjects: boolean}[],
 *   dynamicDdl: {identity: string, effectiveRole: string, createsObjects: boolean}[],
 *   triggerCreators: {identity: string, effectiveRole: string, createsObjects: boolean}[]}}
 * @returns the reviewed creating roles this operation is qualified for
 */
export function assertHistorical89Creators(evidence) {
  if (keysOf(evidence) !== creatorEvidenceShape)
    fail("creator_evidence_unknown");
  // A SET ROLE / SET SESSION AUTHORIZATION split is exactly the path that would
  // silently move creation to another role's defaults.
  if (
    !name(evidence.sessionUser) ||
    evidence.sessionUser !== evidence.currentUser ||
    !reviewedCreatingRoles.includes(evidence.sessionUser)
  )
    fail("creator_role_path");
  if (
    !Array.isArray(evidence.creatingRoles) ||
    evidence.creatingRoles.length === 0 ||
    evidence.creatingRoles.some((role) => !reviewedCreatingRoles.includes(role))
  )
    fail("creator_unreviewed");
  // A role-level setting on a creating role changes the defaults that role
  // creates under, for every future session, outside this transaction's view.
  if (!Array.isArray(evidence.roleSettings)) fail("creator_evidence_unknown");
  for (const setting of evidence.roleSettings) {
    if (
      keysOf(setting) !== roleSettingShape ||
      !name(setting.role) ||
      !name(setting.setting) ||
      typeof setting.value !== "string" ||
      reviewedCreatingRoles.includes(setting.role)
    )
      fail("creator_rolesettings");
  }
  for (const key of ["securityDefiners", "dynamicDdl", "triggerCreators"]) {
    if (!Array.isArray(evidence[key])) fail("creator_evidence_unknown");
    for (const path of evidence[key]) {
      if (
        keysOf(path) !== creationPathShape ||
        !name(path.identity) ||
        !name(path.effectiveRole) ||
        typeof path.createsObjects !== "boolean" ||
        path.createsObjects
      )
        fail(`creator_${key.toLowerCase()}`);
    }
  }
  return Object.freeze([...reviewedCreatingRoles]);
}

// ---------------------------------------------------------------------------
// Resulting object ACLs
// ---------------------------------------------------------------------------

// Bounded, read-only projection of every ACL-bearing application object, keeping
// the raw aclitem[] AND the EFFECTIVE ACL. The effective form matters: a routine
// left at its built-in default carries acldefault('f',owner), which grants
// EXECUTE to PUBLIC. Reading raw ACLs alone would report that object as having
// no grants at all. Indexes and triggers carry no ACL and are deliberately
// absent; the complete catalog/dependency closure is a separate contract.
export const renderHistorical89ObjectAclSql = `SET search_path = pg_catalog, public;
WITH namespaces AS (
  SELECT oid,nspname FROM pg_catalog.pg_namespace
  WHERE nspname NOT IN ('pg_catalog','information_schema')
    AND nspname !~ '^pg_(toast|temp_)'
), objects AS (
  SELECT c.oid AS oid,'pg_class' AS source,
    CASE WHEN c.relkind='S' THEN 'S' ELSE 'r' END AS acltype,
    pg_catalog.format('%I.%I',n.nspname,c.relname) AS identity,
    c.relowner AS ownerid,c.relacl AS acl
  FROM pg_catalog.pg_class c JOIN namespaces n ON n.oid=c.relnamespace
  WHERE c.relkind IN ('r','p','v','m','S','f')
  UNION ALL
  SELECT p.oid,'pg_proc','f',
    pg_catalog.format('%I.%I(%s)',n.nspname,p.proname,
      pg_catalog.pg_get_function_identity_arguments(p.oid)),
    p.proowner,p.proacl
  FROM pg_catalog.pg_proc p JOIN namespaces n ON n.oid=p.pronamespace
)
SELECT jsonb_build_object(
  'version',1,
  'rows',COALESCE(jsonb_agg(jsonb_build_object(
    'oid',o.oid::text,'source',o.source,'identity',o.identity,
    'aclType',o.acltype,'ownerOid',o.ownerid::text,'owner',owner.rolname,
    'raw',CASE WHEN o.acl IS NULL THEN NULL ELSE o.acl::text END,
    'effective',(
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'grantee',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE grantee.rolname END,
        'granteeOid',a.grantee::text,
        'grantor',grantor.rolname,'grantorOid',a.grantor::text,
        'privilege',a.privilege_type,'grantable',a.is_grantable
      ) ORDER BY a.grantee,a.grantor,a.privilege_type),'[]'::jsonb)
      FROM pg_catalog.aclexplode(
        COALESCE(o.acl,pg_catalog.acldefault(o.acltype::"char",o.ownerid))) a
      LEFT JOIN pg_catalog.pg_roles grantee ON grantee.oid=a.grantee
      LEFT JOIN pg_catalog.pg_roles grantor ON grantor.oid=a.grantor
    )
  ) ORDER BY o.oid),'[]'::jsonb)
)
FROM objects o LEFT JOIN pg_catalog.pg_roles owner ON owner.oid=o.ownerid;`;

const objectAclRowShape = shapeOf([
  "aclType",
  "effective",
  "identity",
  "oid",
  "owner",
  "ownerOid",
  "raw",
  "source",
]);

const readObjectAclRows = (observation) => {
  if (observation?.version !== 1 || !Array.isArray(observation.rows))
    fail("object_acl_unknown");
  const rows = new Map();
  for (const row of observation.rows) {
    if (
      keysOf(row) !== objectAclRowShape ||
      !name(row.oid) ||
      !positive(row.oid) ||
      rows.has(row.oid) ||
      !["pg_class", "pg_proc"].includes(row.source) ||
      !["r", "S", "f"].includes(row.aclType) ||
      !name(row.identity) ||
      !name(row.ownerOid) ||
      !positive(row.ownerOid) ||
      // An unresolved owner OID arrives as a null rolname from the LEFT JOIN.
      !name(row.owner) ||
      (row.raw !== null && !name(row.raw)) ||
      !Array.isArray(row.effective)
    )
      fail("object_acl_unresolved");
    rows.set(row.oid, row);
  }
  return rows;
};

/**
 * Qualify the resulting ACLs of the objects THIS operation creates.
 *
 * The provider-default argument is only usable once the objects actually
 * created are shown to carry no PUBLIC privilege, no grant option, no
 * unresolved identity and no foreign creator. The created set is the OID delta
 * between two runs of the same projection; nothing here approves a particular
 * grant set, which remains a registry contract.
 *
 * @param baseline projection taken before the operation
 * @param terminal projection taken after the operation
 * @param creators reviewed creating roles from assertHistorical89Creators
 * @param owners reviewed roles a created object may be OWNED by at the end of
 *   the operation. It defaults to `creators`, which is the only correct value
 *   when the operation performs no ownership transfer. A composed operation
 *   that applies the reviewed 89->92 ownership handover must pass the reviewed
 *   terminal owner set explicitly and pin it in its own source: the immutable
 *   087/089 bodies re-own what they create to the CURRENT owner of
 *   CodexOAuthSecretNamespace, and PostgreSQL rewrites the object's ACL owner
 *   and grantor entries with it. Creating role and terminal owner are two
 *   different facts; only the creating role decides which default ACLs
 *   initialized the object, and that remains `creators`.
 */
export function assertHistorical89CreatedObjectAcl({
  baseline,
  terminal,
  creators,
  owners = creators,
}) {
  if (!distinctNames(creators) || !distinctNames(owners))
    fail("object_acl_unknown");
  const before = readObjectAclRows(baseline);
  const after = readObjectAclRows(terminal);
  const created = [...after.values()].filter((row) => !before.has(row.oid));
  if (created.length === 0) fail("object_acl_no_created_objects");
  for (const row of created) {
    // The creator, not a later ALTER ... OWNER TO, decides which defaults
    // initialized the object. An object owned outside the reviewed terminal
    // owner set means the non-inheritance argument was never established for
    // it, or an unreviewed transfer happened.
    if (!owners.includes(row.owner)) fail("object_acl_creator");
    const seen = new Set();
    for (const entry of row.effective) {
      if (
        keysOf(entry) !== aclEntryShape ||
        !name(entry.grantee) ||
        !name(entry.granteeOid) ||
        !oidOrPublic(entry.granteeOid) ||
        (entry.grantee === "PUBLIC") !== (entry.granteeOid === "0") ||
        !name(entry.grantor) ||
        !name(entry.grantorOid) ||
        !positive(entry.grantorOid) ||
        !name(entry.privilege) ||
        typeof entry.grantable !== "boolean"
      )
        fail("object_acl_unresolved");
      const key = `${entry.grantee} ${entry.grantor} ${entry.privilege}`;
      if (seen.has(key)) fail("object_acl_multiplicity");
      seen.add(key);
      // A built-in default is still an ACL. A routine whose proacl is NULL
      // carries PUBLIC EXECUTE and is rejected exactly like an explicit grant.
      if (entry.grantee === "PUBLIC") fail("object_acl_public_grant");
      if (entry.grantable) fail("object_acl_grant_option");
      // A reviewed ownership transfer rewrites every grantor to the new owner.
      if (!owners.includes(entry.grantor)) fail("object_acl_grantor");
    }
    // acldefault always yields the owner's own privileges, so a null raw ACL
    // can never decode to nothing. An empty effective set with a null raw is a
    // broken observation, not an object without grants.
    if (row.raw === null && row.effective.length === 0)
      fail("object_acl_unresolved");
  }
  return Object.freeze(
    created.map((row) =>
      Object.freeze({
        oid: row.oid,
        identity: row.identity,
        owner: row.owner,
      }),
    ),
  );
}

// ---------------------------------------------------------------------------
// Admission identity
// ---------------------------------------------------------------------------

const admissionShape = shapeOf([
  // Authentic provider resource and PostgreSQL identity.
  "providerDatabaseResourceId",
  "systemIdentifier",
  "databaseOid",
  "databaseName",
  "recoveryIdentitySha256",
  // This operation, stable across retries, plus real provider effects.
  "operationId",
  "providerEffectIds",
  "qualifiedAt",
  // Reviewed implementation and the exact bodies it may apply.
  "handoffSourceCommit",
  "cutoverSourceCommit",
  "sourceTree",
  "pendingEntriesSha256",
  "authorizedBinaryArtifactDigest",
  // Baseline and terminal contracts.
  "baselineManifest",
  "targetManifest",
  // Complete original history and qualified topology.
  "originalLedgerDigest",
  "catalogDigest",
  "topologyDigest",
  "ownershipDigest",
  "aclDigest",
  "membershipDigest",
  // Boundary state.
  "gateStatus",
  "externalFenceSha256",
  "custodyDigest",
]);

// The single production database this phase exists for. A shape-only check
// would let the same machinery be pointed at another Render database that
// happens to look like a managed one.
const expectedProviderDatabaseResourceId = "dpg-da32ipmk1f9s73dttm90-a";
const expectedDatabaseName = "review_router_dimy";

/**
 * Validate a complete `managed-historical89-in-place/v1` admission identity.
 *
 * This is structural and contract validation of externally authenticated
 * evidence. It does NOT authenticate the evidence, create custody, or admit a
 * mutation. A caller-supplied digest never becomes an authority root: every
 * reviewed expectation compared here comes from pinned source, and the
 * qualifier refuses caller-provided expectations outright.
 */
export function assertHistorical89AdmissionIdentity(admission) {
  if (keysOf(admission) !== admissionShape) fail("admission_shape");
  if (
    admission.providerDatabaseResourceId !== expectedProviderDatabaseResourceId
  )
    fail("provider_resource_identity");
  if (
    !name(admission.systemIdentifier) ||
    !positive(admission.systemIdentifier) ||
    !name(admission.databaseOid) ||
    !positive(admission.databaseOid) ||
    admission.databaseName !== expectedDatabaseName
  )
    fail("database_identity");
  if (!digest(admission.recoveryIdentitySha256)) fail("recovery_identity");
  if (!uuid(admission.operationId)) fail("operation_identity");
  if (
    !Array.isArray(admission.providerEffectIds) ||
    admission.providerEffectIds.length === 0 ||
    admission.providerEffectIds.some(
      (id) => !name(id) || !/^[A-Za-z0-9._:-]{1,128}$/u.test(id),
    ) ||
    new Set(admission.providerEffectIds).size !==
      admission.providerEffectIds.length
  )
    fail("provider_effect_identity");
  if (!instant(admission.qualifiedAt)) fail("qualification_time");
  if (
    admission.handoffSourceCommit !== phase.handoffSourceCommit ||
    admission.cutoverSourceCommit !== phase.cutoverSourceCommit ||
    !name(admission.sourceTree) ||
    !/^[a-f0-9]{40}$/u.test(admission.sourceTree)
  )
    fail("source_identity");
  // The seven bodies are re-derived from the reviewed checkout on every call.
  // The admission may only restate what source already fixes.
  if (
    admission.pendingEntriesSha256 !==
    renderHistorical89PendingDigest(readHistorical89PendingIdentities())
  )
    fail("pending_entries_identity");
  if (!digest(admission.authorizedBinaryArtifactDigest))
    fail("binary_artifact_identity");
  if (
    admission.baselineManifest !== phase.baselineManifest ||
    admission.targetManifest !== phase.targetManifest
  )
    fail("transition_contract");
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
    if (!digest(admission[key])) fail("qualified_evidence_missing");
  // The operation begins closed and ends closed. Schema success never opens it.
  if (admission.gateStatus !== "closed") fail("closed_gate_required");
  return renderManagedEvidenceDigest(admission);
}

// ---------------------------------------------------------------------------
// Reviewed expectation registry
// ---------------------------------------------------------------------------

// A SEPARATE registry for this phase. The existing managed registry stays
// unapproved and unchanged. No production-shaped baseline or postcondition
// capture has independent approval in this checkout, so this map is null and
// qualification fails closed. A capture does not become an approval by being
// assigned its own digest, and no CLI path, environment value or fixture may
// populate this map.
// prettier-ignore
const reviewedHistorical89Contracts = Object.freeze({
  "managed-historical89-in-place/v1": {
    "path": "./render-historical89-reviewed-bundle.json",
    "digest":
      "sha256:0fcc3faa7c786fad1f602cad441fc1c09ff81b79c982d384898e911d586248a7",
  },
});

export function readReviewedHistorical89Bundle(kind = phase.kind) {
  if (!Object.hasOwn(reviewedHistorical89Contracts, kind))
    fail("admission_kind");
  const review = reviewedHistorical89Contracts[kind];
  if (!review) fail("independent_review_missing");
  const bytes = readFileSync(new URL(review.path, import.meta.url));
  if (`sha256:${sha256(bytes)}` !== review.digest) fail("review_bytes");
  const bundle = JSON.parse(bytes.toString("utf8"));
  assertReviewedHistorical89Bundle(bundle);
  return bundle;
}

export function readReviewedHistorical89BundleDigest(kind = phase.kind) {
  readReviewedHistorical89Bundle(kind);
  return reviewedHistorical89Contracts[kind].digest;
}

export function readReviewedHistorical89Contract(kind = phase.kind) {
  return readReviewedHistorical89Bundle(kind).migration;
}

export function readReviewedHistorical89Preparation(kind = phase.kind) {
  return readReviewedHistorical89Bundle(kind).preparation;
}

/** A separately reviewed external qualification is a prerequisite, not a
 * RecoveryArtifact. Its source registration must cover the exact retained
 * export, approved recovery point, full effective principals, authentication,
 * same-database restore procedure, and the exclusive maintenance window.
 * A standalone isolated restore report cannot populate this registry.
 * Runtime checks pin the independently reviewed proof bytes; they do not turn
 * operator-provided claims into a qualification. Registration remains absent. */
export function readReviewedHistorical89ExternalRecovery(kind = phase.kind) {
  const bundle = readReviewedHistorical89Bundle(kind);
  const review = reviewedHistorical89Contracts[kind].externalRecovery;
  if (!review) fail("qualified_external_recovery_missing");
  const bytes = readFileSync(new URL(review.path, import.meta.url));
  if (`sha256:${sha256(bytes)}` !== review.digest)
    fail("recovery_review_bytes");
  const qualification = JSON.parse(bytes.toString("utf8"));
  if (
    keysOf(qualification) !==
      shapeOf([
        "source",
        "originalCatalogDigest",
        "originalLedgerDigest",
        "proofs",
        "maintenance",
        "capturedAt",
        "qualifiedAt",
      ]) ||
    keysOf(qualification.source) !==
      shapeOf([
        "providerDatabaseResourceId",
        "systemIdentifier",
        "databaseOid",
        "databaseName",
      ]) ||
    keysOf(qualification.maintenance) !==
      shapeOf(["holder", "reference", "startsAt", "expiresAt", "serviceIds"])
  )
    fail("recovery_qualification_shape");
  for (const key of [
    "providerDatabaseResourceId",
    "systemIdentifier",
    "databaseOid",
    "databaseName",
  ])
    if (qualification.source?.[key] !== bundle.migration.identity[key])
      fail("recovery_source");
  if (
    qualification.originalCatalogDigest !==
      bundle.preparation.originalCatalogDigest ||
    qualification.originalLedgerDigest !==
      bundle.migration.identity.originalLedgerDigest
  )
    fail("recovery_point");
  // Each required claim has independently reviewed evidence bytes, including
  // effective LOGIN principals and authentication recovery beyond a schema dump.
  const proofKinds = [
    "export",
    "recoveryPoint",
    "effectivePrincipals",
    "restore",
    "authentication",
    "sameDatabaseRestore",
    "administrativeExclusion",
  ];
  if (keysOf(qualification.proofs) !== shapeOf(proofKinds))
    fail("recovery_proof_scope");
  for (const key of proofKinds) {
    const proof = qualification.proofs[key];
    if (
      keysOf(proof) !== shapeOf(["path", "digest", "bytes"]) ||
      !digest(proof?.digest) ||
      !Number.isSafeInteger(proof.bytes) ||
      proof.bytes <= 0 ||
      !name(proof.path)
    )
      fail("recovery_proof_shape");
    const observed = readFileSync(
      new URL(proof.path, new URL(review.path, import.meta.url)),
    );
    if (
      observed.byteLength !== proof.bytes ||
      `sha256:${sha256(observed)}` !== proof.digest
    )
      fail(`recovery_proof_${key}`);
  }
  const window = qualification.maintenance;
  if (
    !name(window?.holder) ||
    !name(window.reference) ||
    !instant(window.startsAt) ||
    !instant(window.expiresAt) ||
    Date.now() < Date.parse(window.startsAt) ||
    Date.now() >= Date.parse(window.expiresAt) ||
    renderManagedEvidenceDigest([...window.serviceIds].sort()) !==
      renderManagedEvidenceDigest(
        bundle.preparation.fleet.map((s) => s.serviceId).sort(),
      ) ||
    !instant(qualification.capturedAt) ||
    !instant(qualification.qualifiedAt) ||
    Date.parse(qualification.capturedAt) >
      Date.parse(qualification.qualifiedAt) ||
    Date.parse(qualification.qualifiedAt) > Date.now()
  )
    fail("recovery_window");
  return { ...qualification, recoveryIdentitySha256: review.digest };
}

const reviewedCustodySourceDigest = sha256(
  readFileSync(
    new URL("./render-managed-operation-custody.mjs", import.meta.url),
  ),
);

// The PG17 catalog contains pg_get_functiondef hashes, not routine bodies.
// Derive those exact definitions from the existing custody verifier's source
// and THIS admission binding. Never trust a supplied source/body digest. The
// SQL preflight still performs the full custody/ACL/preparation attestation.
function reviewedCustodyDefinitions(admission) {
  const binding = Object.fromEntries(
    [
      "operationId",
      "systemIdentifier",
      "databaseOid",
      "databaseName",
      "recoveryIdentitySha256",
      "externalFenceSha256",
    ].map((key) => [key, admission[key]]),
  );
  const verifier = renderManagedOperationCustodyVerifySql(binding);
  const schema = renderManagedOperationCustodyContract.schema;
  const expected = new Map();
  for (const signature of renderManagedOperationCustodyContract.routines) {
    const routine = signature.split("(")[0];
    const block = verifier.split(`AND p.proname='${routine}'`)[1];
    const args = block?.match(
      /pg_get_function_identity_arguments\(p.oid\)='([^']+)'/u,
    )?.[1];
    const body = block?.split(`$${routine}_expected$`)[1];
    if (!args || !body) fail("review_custody_source");
    // pg_get_functiondef formatting for the pinned PG17 plpgsql signatures.
    // A server/source formatting change fails closed; it requires new review.
    const definition = `CREATE OR REPLACE FUNCTION ${schema}.${routine}(${args})
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$${body}$function$
`;
    expected.set(`${schema}.${routine}(${args})`, {
      observed: sha256(definition),
      stable: sha256(
        `source-verified:${reviewedCustodySourceDigest}:${routine}`,
      ),
    });
  }
  return expected;
}

export function historical89StableReviewedCatalog(catalog, admission) {
  const expected = reviewedCustodyDefinitions(admission);
  // Preserve every other fact, including custody ownership, ACL, dependencies,
  // signatures and configuration. Only source-proven bound definition hashes
  // change representation, and every expected routine must occur exactly once.
  const seen = new Set();
  const facts = [];
  for (const row of catalog.facts) {
    const definition =
      row?.family === "routine" && expected.get(row.fact?.identity);
    if (!definition) {
      facts.push(row);
      continue;
    }
    if (
      seen.has(row.fact.identity) ||
      row.fact.definitionDigest !== definition.observed
    )
      fail("review_custody_definition");
    seen.add(row.fact.identity);
    facts.push({
      ...row,
      fact: { ...row.fact, definitionDigest: definition.stable },
    });
  }
  if (seen.size !== expected.size) fail("review_custody_missing");
  return { ...catalog, facts };
}

// v1 commits to the COMPLETE stable catalog in both domains, not a selection
// of topology/owner fields. Envelope metadata, ordering, multiplicity, unknown
// facts, ACLs and nulls all remain evidence. The only representation change is
// the existing source-proven custody definition binding above. These digests
// are derivations, never approval; reviewed registry entries remain independent.
const historical89CatalogPins = (stableCatalog) =>
  Object.fromEntries(
    ["topology", "ownership"].map((domain) => [
      `${domain}Digest`,
      renderManagedEvidenceDigest({
        domain: `render-historical89/${domain}/v1`,
        catalog: stableCatalog,
      }),
    ]),
  );

export function deriveHistorical89CatalogPins(catalog, admission) {
  assertRenderManagedCatalogMatches(
    catalog,
    renderManagedEvidenceDigest(catalog),
  );
  return historical89CatalogPins(
    historical89StableReviewedCatalog(catalog, admission),
  );
}

/** Materialize only exact source-bound routine tokens, then prove the inverse. */
export function materializeHistorical89ReviewedTerminal(contract, binding) {
  assertReviewedHistorical89Contract(contract);
  const definitions = reviewedCustodyDefinitions(binding);
  const catalog = {
    ...contract.terminalCatalog,
    facts: contract.terminalCatalog.facts.map((row) => {
      const definition =
        row.family === "routine" && definitions.get(row.fact?.identity);
      if (!definition) return row;
      if (row.fact.definitionDigest !== definition.stable)
        fail("review_terminal_token");
      return {
        ...row,
        fact: { ...row.fact, definitionDigest: definition.observed },
      };
    }),
  };
  if (
    renderManagedEvidenceDigest(
      historical89StableReviewedCatalog(catalog, binding),
    ) !== contract.terminalCatalogDigest
  )
    fail("review_terminal_roundtrip");
  return { catalog, digest: renderManagedEvidenceDigest(catalog) };
}

const originalAclKeys = [
  "version",
  "database",
  "allowConnections",
  "connectionLimit",
  "owner",
  "raw",
  "entries",
];
export function historical89OriginalDatabaseAcl(observation) {
  assertHistorical89OriginalConnectAcl(observation);
  return Object.fromEntries(
    originalAclKeys.map((key) => [key, observation[key]]),
  );
}

function assertReviewedHistorical89Bundle(bundle) {
  if (keysOf(bundle) !== shapeOf(["preparation", "migration"]))
    fail("review_bundle_shape");
  assertReviewedHistorical89Contract(bundle.migration);
  const p = bundle.preparation;
  if (
    keysOf(p) !==
      shapeOf([
        "version",
        "comparisonPoint",
        "originalCatalogDigest",
        "originalDatabaseAcl",
        "preparedCatalogDigest",
        "finalizedCatalogDigest",
        "fleet",
      ]) ||
    p.version !== 1 ||
    p.comparisonPoint !== "original-before-preparation/v1" ||
    [
      p.originalCatalogDigest,
      p.preparedCatalogDigest,
      p.finalizedCatalogDigest,
    ].some((v) => !digest(v)) ||
    keysOf(p.originalDatabaseAcl) !== shapeOf(originalAclKeys)
  )
    fail("review_preparation_shape");
  assertHistorical89OriginalConnectAcl({
    ...p.originalDatabaseAcl,
    backends: [],
    connectCapableRoles: [],
  });
  if (
    p.originalDatabaseAcl.database !== bundle.migration.identity.databaseName ||
    !Array.isArray(p.fleet) ||
    p.fleet.length !== 3 ||
    new Set(p.fleet.map((s) => s.serviceId)).size !== 3 ||
    p.fleet
      .map((s) => s.role)
      .sort()
      .join() !== "api,web,worker" ||
    p.fleet.some(
      (s) =>
        keysOf(s) !== shapeOf(["role", "serviceId", "ownerId", "type"]) ||
        !/^srv-[a-z0-9]{1,64}$/u.test(s.serviceId) ||
        !name(s.ownerId) ||
        !name(s.type),
    )
  )
    fail("review_preparation_fleet");
}

function comparePreparationObservations(bundle, observation) {
  const { migration } = bundle;
  const connect = observation.connectAcl;
  if (
    !Array.isArray(connect?.backends) ||
    connect.backends.some(
      (backend) =>
        !name(backend.role) ||
        backend.superuser !== false ||
        backend.backendType !== "client backend",
    ) ||
    !Array.isArray(connect.connectCapableRoles) ||
    connect.connectCapableRoles.some(
      (role) =>
        !name(role.role) ||
        role.canLogin !== true ||
        role.superuser !== false ||
        typeof role.writesMigratedTables !== "boolean",
    )
  )
    fail("review_original_live_admission");
  const history = inspectRenderManagedLedgerRows(
    readRenderHistorical96CheckoutInventory(),
    observation.ledger,
    phase,
  );
  if (
    history.count !== phase.baselineCount ||
    history.ledgerDigest !== migration.identity.originalLedgerDigest
  )
    fail("review_original_ledger");
  assertRenderManagedClosedGate(observation.gate);
  const creators = assertHistorical89Creators(observation.creatorEvidence);
  assertHistorical89ProviderDefaultAcl(observation.defaultAcl, creators);
  for (const [value, expected, label] of [
    [observation.defaultAcl, migration.identity.aclDigest, "acl"],
    [
      [observation.originalMembership],
      migration.identity.membershipDigest,
      "membership",
    ],
    [
      observation.creatorEvidence,
      renderManagedEvidenceDigest(migration.creatorEvidence),
      "creators",
    ],
    [
      historical89OriginalDatabaseAcl(observation.connectAcl),
      renderManagedEvidenceDigest(bundle.preparation.originalDatabaseAcl),
      "connect",
    ],
  ])
    if (renderManagedEvidenceDigest(value) !== expected)
      fail(`review_original_${label}`);
  if (
    renderHistorical89PendingDigest(readHistorical89PendingIdentities()) !==
    migration.identity.pendingEntriesSha256
  )
    fail("review_original_pending");
}

/** Comparators accept synthetic expectations for tests; only the fixed reader authorizes. */
export function compareHistorical89Original(bundle, observation) {
  assertReviewedHistorical89Bundle(bundle);
  comparePreparationObservations(bundle, observation);
  assertRenderManagedCatalogMatches(
    observation.catalog,
    bundle.preparation.originalCatalogDigest,
  );
  if (observation.catalog.database !== bundle.migration.identity.databaseName)
    fail("review_original_database");
}

export function compareHistorical89PreparationStage(
  bundle,
  stage,
  observation,
  identity,
  binding,
) {
  assertReviewedHistorical89Bundle(bundle);
  if (stage !== "prepared" && stage !== "finalized")
    fail("review_preparation_stage");
  comparePreparationObservations(bundle, observation);
  for (const key of ["systemIdentifier", "databaseOid", "databaseName"])
    if (identity[key] !== bundle.migration.identity[key])
      fail("review_preparation_identity");
  if (
    stage === "finalized" &&
    ["operationId", "systemIdentifier", "databaseOid", "databaseName"].some(
      (key) => binding?.[key] !== identity[key],
    )
  )
    fail("review_preparation_binding");
  assertRenderManagedCatalogMatches(
    stage === "prepared"
      ? observation.catalog
      : historical89StableReviewedCatalog(observation.catalog, binding),
    bundle.preparation[`${stage}CatalogDigest`],
  );
  const stored = observation.preparation;
  const acl = observation.connectAcl;
  if (
    renderManagedEvidenceDigest(stored?.identity) !==
      renderManagedEvidenceDigest(identity) ||
    renderManagedEvidenceDigest(stored?.originalConnect) !==
      renderManagedEvidenceDigest({
        database: acl.database,
        raw: acl.raw,
        entries: acl.entries.filter((e) => e.privilege === "CONNECT"),
      })
  )
    fail("review_preparation_original_connect");
}

// Only stable approval fields belong here. Recovery, fence, operation IDs,
// provider effects, times, gate revisions and permit coordinates remain bound
// by the execution/custody validators, never by baseline approval. catalogDigest
// here hashes the source-verified stable projection; admission.catalogDigest and
// the permit's terminalCatalogDigest continue to hash the exact raw observations.
const reviewedIdentityFields = Object.freeze([
  "providerDatabaseResourceId",
  "systemIdentifier",
  "databaseOid",
  "databaseName",
  "handoffSourceCommit",
  "cutoverSourceCommit",
  "sourceTree",
  "pendingEntriesSha256",
  "authorizedBinaryArtifactDigest",
  "baselineManifest",
  "targetManifest",
  "originalLedgerDigest",
  "catalogDigest",
  "topologyDigest",
  "ownershipDigest",
  "aclDigest",
  "membershipDigest",
]);
const contractShape = shapeOf([
  "kind",
  "version",
  "comparisonPoint",
  "identity",
  "creatorEvidence",
  "terminalCatalog",
  "terminalCatalogDigest",
]);

// Compare AFTER accepted preparation and admission restriction, BEFORE migration.
// The stable projection retains preparation's catalog/authority changes, while
// operation-bound routine definitions are first proved against source and the
// actual binding above. It is NOT the original pre-preparation capture. Review
// of that original capture and authentication of its transition to this point
// remain a preparation integration prerequisite; this comparison proves no past
// custody. The terminal uses the same representation, while permits retain the
// exact unmodified terminal catalog digest for this operation.
function assertReviewedHistorical89Contract(contract) {
  if (
    keysOf(contract) !== contractShape ||
    contract.kind !== phase.kind ||
    contract.version !== 2 ||
    contract.comparisonPoint !== "post-preparation-source-verified/v2" ||
    keysOf(contract.identity) !== shapeOf(reviewedIdentityFields)
  )
    fail("review_shape");
  const identity = contract.identity;
  if (
    identity.providerDatabaseResourceId !==
      expectedProviderDatabaseResourceId ||
    identity.databaseName !== expectedDatabaseName ||
    !name(identity.systemIdentifier) ||
    !positive(identity.systemIdentifier) ||
    !name(identity.databaseOid) ||
    !positive(identity.databaseOid) ||
    identity.handoffSourceCommit !== phase.handoffSourceCommit ||
    identity.cutoverSourceCommit !== phase.cutoverSourceCommit ||
    !/^[a-f0-9]{40}$/u.test(identity.sourceTree) ||
    identity.baselineManifest !== phase.baselineManifest ||
    identity.targetManifest !== phase.targetManifest
  )
    fail("review_identity");
  for (const key of reviewedIdentityFields.filter(
    (key) => key.endsWith("Digest") || key.endsWith("Sha256"),
  ))
    if (!digest(identity[key])) fail("review_identity");
  assertHistorical89Creators(contract.creatorEvidence);
  assertRenderManagedCatalogMatches(
    contract.terminalCatalog,
    contract.terminalCatalogDigest,
  );
  if (contract.terminalCatalog.database !== identity.databaseName)
    fail("review_terminal_database");
}

/** Pure comparison, NOT source qualification or authorization. Synthetic tests
 * may supply a contract here; production uses only readReviewed... above.
 * Catalog comparison covers the complete catalog/authority projection, including
 * topology and ownership facts. Their domain-separated digests are recomputed
 * from that same complete stable observation, then compared to reviewed pins.
 */
export function compareHistorical89ReviewedContract(
  contract,
  {
    admission,
    ledger,
    originalMembership,
    baselineCatalog,
    defaultAcl,
    creatorEvidence,
    reviewedTerminalCatalog,
    reviewedTerminalCatalogDigest,
  },
) {
  assertReviewedHistorical89Contract(contract);
  assertHistorical89AdmissionIdentity(admission);
  const creators = assertHistorical89Creators(creatorEvidence);
  assertHistorical89ProviderDefaultAcl(defaultAcl, creators);
  for (const key of reviewedIdentityFields)
    if (key !== "catalogDigest" && admission[key] !== contract.identity[key])
      fail(`review_mismatch_${key}`);
  const history = inspectRenderManagedLedgerRows(
    readRenderHistorical96CheckoutInventory(),
    ledger,
    phase,
  );
  if (
    history.count !== phase.baselineCount ||
    history.ledgerDigest !== contract.identity.originalLedgerDigest
  )
    fail("review_observation_originalLedgerDigest");
  // Hash actual observations against independent expectations, not against
  // their own newly asserted hashes. Complete rows are retained; the ledger
  // uses the existing migration-name ordering.
  for (const [key, observation, expected] of [
    [
      "membershipDigest",
      originalMembership && [originalMembership],
      contract.identity.membershipDigest,
    ],
    ["aclDigest", defaultAcl, contract.identity.aclDigest],
    [
      "creatorEvidence",
      creatorEvidence,
      renderManagedEvidenceDigest(contract.creatorEvidence),
    ],
  ]) {
    if (
      observation === undefined ||
      observation === null ||
      renderManagedEvidenceDigest(observation) !== expected
    )
      fail(`review_observation_${key}`);
  }
  assertRenderManagedCatalogMatches(baselineCatalog, admission.catalogDigest);
  const stableCatalog = historical89StableReviewedCatalog(
    baselineCatalog,
    admission,
  );
  assertRenderManagedCatalogMatches(
    stableCatalog,
    contract.identity.catalogDigest,
  );
  for (const [key, observed] of Object.entries(
    historical89CatalogPins(stableCatalog),
  ))
    if (observed !== contract.identity[key]) fail(`review_observation_${key}`);
  if (baselineCatalog.database !== admission.databaseName)
    fail("review_baseline_database");
  // A provenance label alone is never terminal evidence. Both bytes (canonical
  // projection) and digest must match this SAME independently loaded contract.
  assertRenderManagedCatalogMatches(
    reviewedTerminalCatalog,
    reviewedTerminalCatalogDigest,
  );
  if (
    renderManagedEvidenceDigest(
      historical89StableReviewedCatalog(reviewedTerminalCatalog, admission),
    ) !== renderManagedEvidenceDigest(contract.terminalCatalog)
  )
    fail("review_terminal_mismatch");
  return true;
}

/**
 * Qualify the current historical 89 baseline for one in-place operation.
 *
 * Returns a frozen qualification record. That record is evidence that this
 * operation independently qualified the observed baseline. It is explicitly NOT
 * custody, NOT a permit, and NOT authorization to mutate: `custodyEstablished`
 * is always false here, because a pure validator cannot create custody.
 *
 * The resulting object ACLs cannot be observed before the operation runs, so
 * they are deliberately NOT part of this record; `resultingObjectAclVerified`
 * stays false and the composed caller must still run
 * assertHistorical89CreatedObjectAcl against the terminal projection.
 */
export function qualifyHistorical89Admission({
  admission,
  defaultAcl,
  creatorEvidence,
  reviewedExpectations,
  ledger,
  originalMembership,
  baselineCatalog,
  reviewedTerminalCatalog,
  reviewedTerminalCatalogDigest,
  ...unsupported
}) {
  // Refuse a caller-supplied expectation set outright rather than quietly
  // preferring source: accepting it at all would make the client the root.
  if (reviewedExpectations !== undefined || Object.keys(unsupported).length)
    fail("caller_supplied_expectations");
  const identityDigest = assertHistorical89AdmissionIdentity(admission);
  const creators = assertHistorical89Creators(creatorEvidence);
  assertHistorical89ProviderDefaultAcl(defaultAcl, creators);
  // Fails closed today: no independently qualified registry exists yet.
  const contract = readReviewedHistorical89Contract();
  compareHistorical89ReviewedContract(contract, {
    admission,
    ledger,
    originalMembership,
    baselineCatalog,
    defaultAcl,
    creatorEvidence,
    reviewedTerminalCatalog,
    reviewedTerminalCatalogDigest,
  });
  return Object.freeze({
    kind: phase.kind,
    version: 1,
    operationId: admission.operationId,
    identityDigest,
    creators: Object.freeze([...creators]),
    contract,
    custodyEstablished: false,
    resultingObjectAclVerified: false,
    authorizesMutation: false,
  });
}
