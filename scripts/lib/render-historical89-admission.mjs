import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  readRenderManagedCheckoutInventory,
  renderManagedEvidenceDigest,
  renderSchemaHandoffMigrationContract,
} from "./render-schema-handoff-policy.mjs";
import { renderManagedWorkflowCutoverPhase } from "./render-managed-workflow-cutover.mjs";

// Qualification evidence only. Nothing in this module creates custody, opens a
// gate, authorizes a mutation, connects to a database or registers a production
// root. Every exported SQL string is a read-only projection. It states one
// narrow fact: whether the CURRENT historical 89 baseline was independently
// qualified for THIS operation. It makes no claim about who executed migrations
// 1-89, about the predecessor retained phase, or about past custody. It does
// not install, adopt or weaken the retained ledger guard, which legitimately
// keeps requiring the original custody this database never had.
export const renderHistorical89AdmissionPhase = Object.freeze({
  kind: "managed-historical89-in-place/v1",
  // The seven bodies come from two separately reviewed lanes. Both identities
  // are bound: restating only one would leave half the applied SQL unattributed.
  handoffSourceCommit: renderSchemaHandoffMigrationContract.sourceCommit,
  cutoverSourceCommit: renderManagedWorkflowCutoverPhase.sourceCommit,
  baselineCount: 89,
  interimCount: 92,
  targetCount: 96,
  atomic: true,
  // 89 and 96 are the only durable endpoints. 92 is verified inside the same
  // backend and transaction; it never becomes a durable checkpoint here.
  baselineManifest: renderSchemaHandoffMigrationContract.baselineManifest,
  interimManifest: renderSchemaHandoffMigrationContract.targetManifest,
  targetManifest: renderManagedWorkflowCutoverPhase.targetManifest,
});
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
  const inventory = readRenderManagedCheckoutInventory();
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
const reviewedHistorical89Contracts = Object.freeze({
  "managed-historical89-in-place/v1": null,
});

export function readReviewedHistorical89Contract(kind = phase.kind) {
  if (!Object.hasOwn(reviewedHistorical89Contracts, kind))
    fail("admission_kind");
  const review = reviewedHistorical89Contracts[kind];
  if (!review) fail("independent_review_missing");
  const bytes = readFileSync(new URL(review.path, import.meta.url));
  if (`sha256:${sha256(bytes)}` !== review.digest) fail("review_bytes");
  const contract = JSON.parse(bytes.toString("utf8"));
  if (
    contract.kind !== kind ||
    contract.version !== 1 ||
    contract.handoffSourceCommit !== phase.handoffSourceCommit ||
    contract.cutoverSourceCommit !== phase.cutoverSourceCommit
  )
    fail("review_identity");
  return contract;
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
}) {
  // Refuse a caller-supplied expectation set outright rather than quietly
  // preferring source: accepting it at all would make the client the root.
  if (reviewedExpectations !== undefined) fail("caller_supplied_expectations");
  const identityDigest = assertHistorical89AdmissionIdentity(admission);
  const creators = assertHistorical89Creators(creatorEvidence);
  assertHistorical89ProviderDefaultAcl(defaultAcl, creators);
  // Fails closed today: no independently qualified registry exists yet.
  const contract = readReviewedHistorical89Contract();
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
