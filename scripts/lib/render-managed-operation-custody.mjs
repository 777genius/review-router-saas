import { createHash } from "node:crypto";
import {
  renderManagedCanonicalLockPredicate,
  renderManagedPrismaLockPredicate,
} from "./render-retained-exclusion.mjs";
import { renderHistorical89AdmissionPhase } from "./render-historical89-admission.mjs";

// ---------------------------------------------------------------------------
// Fresh current-operation custody, inside the SAME qualified database.
// ---------------------------------------------------------------------------
//
// The observed production database has no application-local release_authority
// schema, and the workspace has exactly one database. There is therefore no
// existing custody to authenticate and no second resource to place it on. This
// module renders the minimum durable custody THIS operation needs:
//
//   * one protected permit row carrying the operation's immutable identity plus
//     a monotonic epoch/nonce compare-and-set, and
//   * at most one protected, operation-bound effect receipt, written by a
//     routine that re-verifies the postconditions itself.
//
// It is deliberately not a release platform: there is no rollout graph, no
// provider effect ledger, no second phase and no generic claim table.
//
// What this custody DOES establish: an operation identity that survives a lost
// COMMIT, single-effect (replay-impossible) semantics, a compare-and-set that
// makes a stale epoch/generation fail closed, an effect receipt whose contents
// the caller cannot dictate, and tamper-EVIDENT catalog attestation.
//
// What it explicitly does NOT establish: protection against the database owner
// itself. `reviewrouter` bootstraps this custody, holds ADMIN on the custody
// role and can re-grant itself SET. Owner access is not independent approval
// evidence, so the approval root stays where 1A put it - the reviewed source
// registry - and every renderer here reports `authorizesProductionMutation`
// through its caller rather than claiming authorization on its own.

const contractKind = renderHistorical89AdmissionPhase.kind;
const custodySchema = "release_operation_custody";
const custodyOwner = "reviewrouter_operation_custody_owner";
const custodyReader = "reviewrouter_operation_custody_reader";
const coordinator = "reviewrouter";

export const renderManagedOperationCustodyContract = Object.freeze({
  kind: contractKind,
  schema: custodySchema,
  ownerRole: custodyOwner,
  readerRole: custodyReader,
  coordinatorRole: coordinator,
  permitTable: `${custodySchema}.operation_permit`,
  receiptTable: `${custodySchema}.operation_effect_receipt`,
  routines: Object.freeze([
    "custody_open_operation(jsonb)",
    "custody_current_permit(uuid,boolean)",
    "custody_advance_epoch(uuid,bigint,text,text)",
    "custody_record_effect(jsonb)",
    "custody_read_effect(uuid)",
  ]),
  // Exactly the two read grants the protected writer needs to re-verify its own
  // postconditions without the caller supplying them. Both are SELECT only, to
  // a NOLOGIN role, and both are removed by the teardown renderer.
  ownerReadGrants: Object.freeze([
    "public._prisma_migrations",
    'public."HostedCodexRuntimeGate"',
  ]),
});

const fail = (reason) => {
  throw new Error(`render_managed_operation_custody_rejected:${reason}`);
};
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const digest = (value) =>
  typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);
const uuid = (value) =>
  typeof value === "string" &&
  /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value);
const nonceValue = (value) =>
  typeof value === "string" && /^[a-f0-9]{32}$/u.test(value);
const positive = (value) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
const shapeOf = (keys) => [...keys].sort().join();
const keysOf = (value) =>
  value &&
  typeof value === "object" &&
  Object.getPrototypeOf(value) === Object.prototype
    ? Object.keys(value).sort().join()
    : null;

// Only ever used on values this module has already pattern-validated.
const literal = (value) => `'${String(value).replaceAll("'", "''")}'`;
// Attestation must report "this custody is not the reviewed one" even when the
// schema, routine or role is simply absent. A regprocedure/regrole cast would
// raise its own error for a missing object instead, so every attestation lookup
// resolves by name through the catalog.
const roleOid = (name) =>
  `(SELECT oid FROM pg_catalog.pg_roles WHERE rolname='${name}')`;

const bindingShape = shapeOf([
  "operationId",
  "systemIdentifier",
  "databaseOid",
  "databaseName",
  "recoveryIdentitySha256",
  "externalFenceSha256",
]);

/**
 * Validate the immutable identity this operation's custody is bound to.
 *
 * Every field is a catalog-independent identity the operation cannot change
 * halfway through. The qualified admission digest and the reviewed terminal
 * catalog digest are deliberately NOT here: both are observations OF a database
 * that already carries this custody, so pinning them into the routine bodies
 * would be circular. They are fixed once instead, in immutable permit columns,
 * and every later step compares against the permit rather than against itself.
 */
export function assertManagedOperationCustodyBinding(binding) {
  if (keysOf(binding) !== bindingShape) fail("binding_shape");
  if (!uuid(binding.operationId)) fail("operation_identity");
  if (
    !digest(binding.recoveryIdentitySha256) ||
    !digest(binding.externalFenceSha256)
  )
    fail("binding_digest");
  if (
    typeof binding.systemIdentifier !== "string" ||
    !/^[1-9][0-9]*$/u.test(binding.systemIdentifier) ||
    typeof binding.databaseOid !== "string" ||
    !/^[1-9][0-9]*$/u.test(binding.databaseOid) ||
    typeof binding.databaseName !== "string" ||
    !/^[a-z_][a-z0-9_]{0,62}$/u.test(binding.databaseName)
  )
    fail("binding_database_identity");
  return Object.freeze({ ...binding });
}

// ---------------------------------------------------------------------------
// Protected routine bodies
// ---------------------------------------------------------------------------

// The target manifest is derived exactly as the accepted policy derives it:
// sha256 over `name:checksum` joined by "," in ascending migration-name order.
// C collation over these ASCII names is the same order the JavaScript
// comparison uses, so the two derivations cannot disagree.
const ledgerManifestExpression = `encode(sha256(convert_to(
  (SELECT string_agg(migration_name||':'||checksum,',' ORDER BY migration_name COLLATE "C")
   FROM public._prisma_migrations),'UTF8')),'hex')`;

const permitColumns = `operation_id,kind,admission_identity_digest,system_identifier,
  database_oid,database_name,recovery_identity_sha256,external_fence_sha256,
  terminal_catalog_digest,generation,epoch,nonce,state,issued_at,updated_at`;

const permitJson = (alias) => `jsonb_build_object(
    'operationId',${alias}.operation_id::text,'kind',${alias}.kind,
    'admissionIdentityDigest',${alias}.admission_identity_digest,
    'systemIdentifier',${alias}.system_identifier,'databaseOid',${alias}.database_oid,
    'databaseName',${alias}.database_name,
    'recoveryIdentitySha256',${alias}.recovery_identity_sha256,
    'externalFenceSha256',${alias}.external_fence_sha256,
    'terminalCatalogDigest',${alias}.terminal_catalog_digest,
    'generation',${alias}.generation::text,'epoch',${alias}.epoch::text,
    'nonce',${alias}.nonce,'state',${alias}.state)`;

const routineBodies = (binding) => {
  const targetManifest = renderHistorical89AdmissionPhase.targetManifest.slice(
    "sha256:".length,
  );
  const targetCount = renderHistorical89AdmissionPhase.targetCount;
  const identityGuard = `IF session_user <> ${literal(coordinator)}
     OR current_user <> ${literal(custodyOwner)}
     OR current_database() <> ${literal(binding.databaseName)}
     OR (SELECT system_identifier::text FROM pg_control_system()) <> ${literal(binding.systemIdentifier)}
     OR (SELECT oid::text FROM pg_database WHERE datname=current_database()) <> ${literal(binding.databaseOid)}
     OR (SELECT rolsuper FROM pg_roles WHERE rolname=session_user) THEN
    RAISE EXCEPTION 'custody_session_identity';
  END IF;`;
  return Object.freeze({
    // Idempotent open. A second call with the same identity returns the same
    // permit; a call with a different identity for the same operation, or the
    // same identity for a second operation, fails closed.
    custody_open_operation: `
DECLARE request jsonb := $1; existing ${custodySchema}.operation_permit; result jsonb;
BEGIN
  ${identityGuard}
  IF request->>'kind' <> ${literal(contractKind)}
     OR request->>'operationId' <> ${literal(binding.operationId)}
     OR (request->>'admissionIdentityDigest') !~ '^sha256:[a-f0-9]{64}$'
     OR request->>'recoveryIdentitySha256' <> ${literal(binding.recoveryIdentitySha256)}
     OR request->>'externalFenceSha256' <> ${literal(binding.externalFenceSha256)}
     OR (request->>'terminalCatalogDigest') !~ '^sha256:[a-f0-9]{64}$'
     OR (request->>'generation') !~ '^[1-9][0-9]*$'
     OR (request->>'nonce') !~ '^[a-f0-9]{32}$' THEN
    RAISE EXCEPTION 'custody_open_request';
  END IF;
  SELECT * INTO existing FROM ${custodySchema}.operation_permit
    WHERE operation_id=(request->>'operationId')::uuid FOR UPDATE;
  IF FOUND THEN
    IF existing.admission_identity_digest <> request->>'admissionIdentityDigest'
       OR existing.terminal_catalog_digest <> request->>'terminalCatalogDigest'
       OR existing.generation::text <> request->>'generation'
       OR existing.kind <> request->>'kind' THEN
      RAISE EXCEPTION 'custody_operation_identity_conflict';
    END IF;
    SELECT ${permitJson("p")} INTO result FROM ${custodySchema}.operation_permit p
      WHERE p.operation_id=(request->>'operationId')::uuid;
    RETURN result;
  END IF;
  IF EXISTS (SELECT 1 FROM ${custodySchema}.operation_permit) THEN
    RAISE EXCEPTION 'custody_single_operation_only';
  END IF;
  INSERT INTO ${custodySchema}.operation_permit (${permitColumns})
  VALUES ((request->>'operationId')::uuid,request->>'kind',
    request->>'admissionIdentityDigest',${literal(binding.systemIdentifier)},
    ${literal(binding.databaseOid)},${literal(binding.databaseName)},
    request->>'recoveryIdentitySha256',request->>'externalFenceSha256',
    request->>'terminalCatalogDigest',
    (request->>'generation')::bigint,1,request->>'nonce','open',
    clock_timestamp(),clock_timestamp());
  SELECT ${permitJson("p")} INTO result FROM ${custodySchema}.operation_permit p
    WHERE p.operation_id=(request->>'operationId')::uuid;
  RETURN result;
END`,
    // Reads the single current permit, optionally taking the row lock the
    // coordinator's transaction holds for its whole duration.
    custody_current_permit: `
DECLARE result jsonb;
BEGIN
  ${identityGuard}
  IF $2 THEN
    PERFORM 1 FROM ${custodySchema}.operation_permit WHERE operation_id=$1 FOR NO KEY UPDATE;
  END IF;
  SELECT ${permitJson("p")} INTO result FROM ${custodySchema}.operation_permit p
    WHERE p.operation_id=$1;
  IF result IS NULL THEN RAISE EXCEPTION 'custody_permit_absent'; END IF;
  RETURN result;
END`,
    // Compare-and-set. A stale epoch or nonce advances nothing and raises.
    custody_advance_epoch: `
DECLARE result jsonb;
BEGIN
  ${identityGuard}
  IF $4 !~ '^[a-f0-9]{32}$' OR $4 = $3 THEN
    RAISE EXCEPTION 'custody_advance_request';
  END IF;
  UPDATE ${custodySchema}.operation_permit
    SET epoch=epoch+1,nonce=$4,updated_at=clock_timestamp()
    WHERE operation_id=$1 AND epoch=$2 AND nonce=$3 AND state='open';
  IF NOT FOUND THEN RAISE EXCEPTION 'custody_permit_cas_conflict'; END IF;
  SELECT ${permitJson("p")} INTO result FROM ${custodySchema}.operation_permit p
    WHERE p.operation_id=$1;
  RETURN result;
END`,
    // The protected, operation-bound effect writer. It re-derives every fact it
    // records; the caller supplies only the permit coordinates it must match.
    custody_record_effect: `
DECLARE request jsonb := $1; permit ${custodySchema}.operation_permit;
  observed_manifest text; observed_count bigint; observed_catalog text;
  fingerprint text; receipt jsonb;
BEGIN
  ${identityGuard}
  -- Proof that this runs inside the coordinator's own exclusive transaction:
  -- both advisory locks are held by THIS backend right now. A receipt can
  -- therefore not be written from an ordinary connection.
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_locks WHERE ${renderManagedCanonicalLockPredicate})
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_locks WHERE ${renderManagedPrismaLockPredicate}) THEN
    RAISE EXCEPTION 'custody_effect_outside_exclusive_transaction';
  END IF;
  SELECT * INTO permit FROM ${custodySchema}.operation_permit
    WHERE operation_id=(request->>'operationId')::uuid FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'custody_permit_absent'; END IF;
  IF permit.state <> 'open'
     OR permit.kind <> ${literal(contractKind)}
     OR permit.operation_id::text <> ${literal(binding.operationId)}
     OR permit.admission_identity_digest IS DISTINCT FROM request->>'admissionIdentityDigest'
     OR permit.external_fence_sha256 <> ${literal(binding.externalFenceSha256)}
     OR permit.recovery_identity_sha256 <> ${literal(binding.recoveryIdentitySha256)}
     OR permit.epoch::text IS DISTINCT FROM request->>'epoch'
     OR permit.nonce IS DISTINCT FROM request->>'nonce'
     OR permit.generation::text IS DISTINCT FROM request->>'generation' THEN
    RAISE EXCEPTION 'custody_permit_stale';
  END IF;
  IF EXISTS (SELECT 1 FROM ${custodySchema}.operation_effect_receipt
             WHERE operation_id=permit.operation_id) THEN
    RAISE EXCEPTION 'custody_effect_already_recorded';
  END IF;
  -- Postconditions re-derived here, not accepted from the caller.
  SELECT count(*) INTO observed_count FROM public._prisma_migrations;
  SELECT ${ledgerManifestExpression} INTO observed_manifest;
  IF observed_count <> ${targetCount} OR observed_manifest <> ${literal(targetManifest)}
     OR EXISTS (SELECT 1 FROM public._prisma_migrations
       WHERE finished_at IS NULL OR started_at IS NULL OR finished_at<started_at
         OR rolled_back_at IS NOT NULL OR applied_steps_count<>1 OR COALESCE(logs,'')<>'')
     OR EXISTS (SELECT 1 FROM public._prisma_migrations
       GROUP BY migration_name HAVING count(*)<>1) THEN
    RAISE EXCEPTION 'custody_effect_postcondition_ledger';
  END IF;
  -- The operation begins closed and ends closed. Applying schema never opens it.
  IF NOT EXISTS (SELECT 1 FROM public."HostedCodexRuntimeGate"
                 WHERE id='global' AND status='closed') THEN
    RAISE EXCEPTION 'custody_effect_postcondition_gate';
  END IF;
  observed_catalog := request->>'terminalCatalogDigest';
  IF observed_catalog IS DISTINCT FROM permit.terminal_catalog_digest THEN
    RAISE EXCEPTION 'custody_effect_postcondition_catalog';
  END IF;
  -- A newline-joined field list, not a serialized object: PostgreSQL's jsonb
  -- text form is not the same bytes as any JSON serializer this repository
  -- uses, and a fingerprint nobody can recompute is not evidence.
  fingerprint := 'sha256:'||encode(sha256(convert_to(concat_ws(chr(10),
    permit.kind,permit.operation_id::text,permit.admission_identity_digest,
    permit.system_identifier,permit.database_oid,permit.database_name,
    permit.recovery_identity_sha256,permit.external_fence_sha256,
    permit.generation::text,permit.epoch::text,permit.nonce,
    'sha256:'||observed_manifest,observed_catalog),'UTF8')),'hex');
  INSERT INTO ${custodySchema}.operation_effect_receipt
    (operation_id,kind,generation,epoch,nonce,ledger_manifest,
     terminal_catalog_digest,effect_fingerprint,backend_pid,transaction_id,recorded_at)
  VALUES (permit.operation_id,permit.kind,permit.generation,permit.epoch,permit.nonce,
    'sha256:'||observed_manifest,observed_catalog,fingerprint,
    pg_backend_pid(),pg_current_xact_id()::text,clock_timestamp());
  UPDATE ${custodySchema}.operation_permit SET state='terminal',updated_at=clock_timestamp()
    WHERE operation_id=permit.operation_id;
  SELECT ${custodySchema}.custody_read_effect(permit.operation_id) INTO receipt;
  RETURN receipt;
END`,
    // Restricted read, granted to a login role that can do nothing else. The
    // post-COMMIT reconciliation reads the receipt through this role on a fresh
    // connection rather than trusting the coordinator's own report.
    custody_read_effect: `
DECLARE result jsonb;
BEGIN
  SELECT jsonb_build_object(
    'kind',r.kind,'operationId',r.operation_id::text,
    'generation',r.generation::text,'epoch',r.epoch::text,'nonce',r.nonce,
    'ledgerManifest',r.ledger_manifest,'terminalCatalogDigest',r.terminal_catalog_digest,
    'effectFingerprint',r.effect_fingerprint,'backendPid',r.backend_pid,
    'transactionId',r.transaction_id,
    'recordedAt',to_char(r.recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'permitState',p.state)
  INTO result FROM ${custodySchema}.operation_effect_receipt r
  JOIN ${custodySchema}.operation_permit p ON p.operation_id=r.operation_id
  WHERE r.operation_id=$1;
  RETURN result;
END`,
  });
};

const routineSignature = Object.freeze({
  custody_open_operation: { args: "p_request jsonb", identity: "jsonb" },
  custody_current_permit: {
    args: "p_operation uuid, p_lock boolean",
    identity: "uuid, boolean",
  },
  custody_advance_epoch: {
    args: "p_operation uuid, p_expected_epoch bigint, p_expected_nonce text, p_next_nonce text",
    identity: "uuid, bigint, text, text",
  },
  custody_record_effect: { args: "p_request jsonb", identity: "jsonb" },
  custody_read_effect: { args: "p_operation uuid", identity: "uuid" },
});

// Only the coordinator may call the mutating routines; only the restricted
// reader may call the read routine. Nothing is executable by PUBLIC.
const routineGrantee = Object.freeze({
  custody_open_operation: coordinator,
  custody_current_permit: coordinator,
  custody_advance_epoch: coordinator,
  custody_record_effect: coordinator,
  custody_read_effect: custodyReader,
});

// ---------------------------------------------------------------------------
// Bootstrap, attestation and teardown
// ---------------------------------------------------------------------------

/**
 * Read-only projection of the complete custody topology: roles, schema, tables,
 * routines, ownership and every ACL entry. Comparison against it is
 * attestation, never approval.
 */
export const renderManagedOperationCustodyProjectionSql = `SET search_path = pg_catalog, public;
SELECT jsonb_build_object(
  'version',1,
  'roles',COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'name',r.rolname,'canLogin',r.rolcanlogin,'superuser',r.rolsuper,
    'inherit',r.rolinherit,'createRole',r.rolcreaterole,'createDatabase',r.rolcreatedb,
    'replication',r.rolreplication,'bypassRls',r.rolbypassrls
  ) ORDER BY r.rolname COLLATE "C") FROM pg_catalog.pg_roles r
    WHERE r.rolname IN ('${custodyOwner}','${custodyReader}')),'[]'::jsonb),
  'memberships',COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'role',parent.rolname,'member',member.rolname,'grantor',grantor.rolname,
    'adminOption',m.admin_option,'inheritOption',m.inherit_option,'setOption',m.set_option
  ) ORDER BY parent.rolname COLLATE "C",member.rolname COLLATE "C",grantor.rolname COLLATE "C")
   FROM pg_catalog.pg_auth_members m
   LEFT JOIN pg_catalog.pg_roles parent ON parent.oid=m.roleid
   LEFT JOIN pg_catalog.pg_roles member ON member.oid=m.member
   LEFT JOIN pg_catalog.pg_roles grantor ON grantor.oid=m.grantor
   WHERE parent.rolname IN ('${custodyOwner}','${custodyReader}')),'[]'::jsonb),
  'schemas',COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'name',n.nspname,'owner',owner.rolname,
    'acl',CASE WHEN n.nspacl IS NULL THEN NULL ELSE n.nspacl::text END
  ) ORDER BY n.nspname COLLATE "C") FROM pg_catalog.pg_namespace n
   LEFT JOIN pg_catalog.pg_roles owner ON owner.oid=n.nspowner
   WHERE n.nspname='${custodySchema}'),'[]'::jsonb),
  'relations',COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'identity',format('%I.%I',n.nspname,c.relname),'kind',c.relkind,
    'owner',owner.rolname,'rowSecurity',c.relrowsecurity,
    'acl',CASE WHEN c.relacl IS NULL THEN NULL ELSE c.relacl::text END
  ) ORDER BY c.relname COLLATE "C") FROM pg_catalog.pg_class c
   JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
   LEFT JOIN pg_catalog.pg_roles owner ON owner.oid=c.relowner
   WHERE n.nspname='${custodySchema}'),'[]'::jsonb),
  'routines',COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'identity',format('%I.%I(%s)',n.nspname,p.proname,pg_catalog.pg_get_function_identity_arguments(p.oid)),
    'owner',owner.rolname,'securityDefiner',p.prosecdef,'volatility',p.provolatile,
    'language',l.lanname,'configuration',p.proconfig::text,
    'bodyDigest','sha256:'||encode(sha256(convert_to(p.prosrc,'UTF8')),'hex'),
    'acl',CASE WHEN p.proacl IS NULL THEN NULL ELSE p.proacl::text END
  ) ORDER BY p.proname COLLATE "C") FROM pg_catalog.pg_proc p
   JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
   JOIN pg_catalog.pg_language l ON l.oid=p.prolang
   LEFT JOIN pg_catalog.pg_roles owner ON owner.oid=p.proowner
   WHERE n.nspname='${custodySchema}'),'[]'::jsonb),
  'triggers',COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'identity',format('%I.%I.%I',n.nspname,c.relname,t.tgname),'enabled',t.tgenabled,
    'definition',pg_catalog.pg_get_triggerdef(t.oid)
  ) ORDER BY t.tgname COLLATE "C") FROM pg_catalog.pg_trigger t
   JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
   JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='${custodySchema}' AND NOT t.tgisinternal),'[]'::jsonb),
  'ownerReadGrants',COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'identity',format('%I.%I',n.nspname,c.relname),'privilege',a.privilege_type,
    'grantor',grantor.rolname,'grantable',a.is_grantable
  ) ORDER BY c.relname COLLATE "C",a.privilege_type COLLATE "C")
   FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
   CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a
   LEFT JOIN pg_catalog.pg_roles grantor ON grantor.oid=a.grantor
   WHERE c.relacl IS NOT NULL
     AND a.grantee=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname='${custodyOwner}')
     AND a.grantee<>c.relowner),'[]'::jsonb)
);`;

const custodyRoleOptions =
  "NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS";
const readerRoleOptions =
  "LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS";

const immutabilityTriggerBody = `
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'custody_row_delete_forbidden';
  END IF;
  IF TG_TABLE_NAME='operation_effect_receipt' THEN
    RAISE EXCEPTION 'custody_receipt_immutable';
  END IF;
  IF NEW.operation_id IS DISTINCT FROM OLD.operation_id
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.admission_identity_digest IS DISTINCT FROM OLD.admission_identity_digest
     OR NEW.system_identifier IS DISTINCT FROM OLD.system_identifier
     OR NEW.database_oid IS DISTINCT FROM OLD.database_oid
     OR NEW.database_name IS DISTINCT FROM OLD.database_name
     OR NEW.recovery_identity_sha256 IS DISTINCT FROM OLD.recovery_identity_sha256
     OR NEW.external_fence_sha256 IS DISTINCT FROM OLD.external_fence_sha256
     OR NEW.terminal_catalog_digest IS DISTINCT FROM OLD.terminal_catalog_digest
     OR NEW.generation IS DISTINCT FROM OLD.generation
     OR NEW.issued_at IS DISTINCT FROM OLD.issued_at THEN
    RAISE EXCEPTION 'custody_permit_identity_immutable';
  END IF;
  IF OLD.state='terminal' AND NEW.state<>'terminal' THEN
    RAISE EXCEPTION 'custody_permit_terminal';
  END IF;
  IF NEW.epoch NOT IN (OLD.epoch,OLD.epoch+1)
     OR (NEW.epoch=OLD.epoch AND NEW.nonce IS DISTINCT FROM OLD.nonce)
     OR (NEW.epoch=OLD.epoch+1 AND NEW.nonce IS NOT DISTINCT FROM OLD.nonce) THEN
    RAISE EXCEPTION 'custody_permit_epoch_monotonic';
  END IF;
  RETURN NEW;
END`;

const schemaSql =
  () => `CREATE SCHEMA ${custodySchema} AUTHORIZATION ${custodyOwner};
SET LOCAL ROLE ${custodyOwner};
REVOKE ALL ON SCHEMA ${custodySchema} FROM PUBLIC;
GRANT USAGE ON SCHEMA ${custodySchema} TO ${coordinator}, ${custodyReader};
CREATE TABLE ${custodySchema}.operation_permit (
  operation_id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind=${literal(contractKind)}),
  admission_identity_digest text NOT NULL CHECK (admission_identity_digest ~ '^sha256:[a-f0-9]{64}$'),
  system_identifier text NOT NULL CHECK (system_identifier ~ '^[1-9][0-9]*$'),
  database_oid text NOT NULL CHECK (database_oid ~ '^[1-9][0-9]*$'),
  database_name text NOT NULL,
  recovery_identity_sha256 text NOT NULL CHECK (recovery_identity_sha256 ~ '^sha256:[a-f0-9]{64}$'),
  external_fence_sha256 text NOT NULL CHECK (external_fence_sha256 ~ '^sha256:[a-f0-9]{64}$'),
  terminal_catalog_digest text NOT NULL CHECK (terminal_catalog_digest ~ '^sha256:[a-f0-9]{64}$'),
  generation bigint NOT NULL CHECK (generation>=1),
  epoch bigint NOT NULL CHECK (epoch>=1),
  nonce text NOT NULL CHECK (nonce ~ '^[a-f0-9]{32}$'),
  state text NOT NULL CHECK (state IN ('open','terminal')),
  issued_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE TABLE ${custodySchema}.operation_effect_receipt (
  operation_id uuid PRIMARY KEY
    REFERENCES ${custodySchema}.operation_permit(operation_id),
  kind text NOT NULL CHECK (kind=${literal(contractKind)}),
  generation bigint NOT NULL,
  epoch bigint NOT NULL,
  nonce text NOT NULL,
  ledger_manifest text NOT NULL CHECK (ledger_manifest ~ '^sha256:[a-f0-9]{64}$'),
  terminal_catalog_digest text NOT NULL CHECK (terminal_catalog_digest ~ '^sha256:[a-f0-9]{64}$'),
  effect_fingerprint text NOT NULL CHECK (effect_fingerprint ~ '^sha256:[a-f0-9]{64}$'),
  backend_pid integer NOT NULL,
  transaction_id text NOT NULL,
  recorded_at timestamptz NOT NULL
);
CREATE FUNCTION ${custodySchema}.custody_immutable() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $custody_immutable$${immutabilityTriggerBody}$custody_immutable$;
CREATE TRIGGER custody_permit_immutable BEFORE UPDATE OR DELETE
  ON ${custodySchema}.operation_permit
  FOR EACH ROW EXECUTE FUNCTION ${custodySchema}.custody_immutable();
ALTER TABLE ${custodySchema}.operation_permit ENABLE ALWAYS TRIGGER custody_permit_immutable;
CREATE TRIGGER custody_receipt_immutable BEFORE UPDATE OR DELETE
  ON ${custodySchema}.operation_effect_receipt
  FOR EACH ROW EXECUTE FUNCTION ${custodySchema}.custody_immutable();
ALTER TABLE ${custodySchema}.operation_effect_receipt ENABLE ALWAYS TRIGGER custody_receipt_immutable;`;

const routineSql = (bodies) =>
  Object.entries(bodies)
    .map(([routine, body]) => {
      const signature = routineSignature[routine];
      return `CREATE FUNCTION ${custodySchema}.${routine}(${signature.args}) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
  AS $${routine}$${body}$${routine}$;
REVOKE ALL ON FUNCTION ${custodySchema}.${routine}(${signature.identity}) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ${custodySchema}.${routine}(${signature.identity}) TO ${routineGrantee[routine]};`;
    })
    .join("\n");

/**
 * Exact catalog attestation of this operation's custody.
 *
 * Missing custody and forged custody are the same check from two directions: a
 * routine with a different body, a different owner, a wider ACL, a missing
 * immutability trigger or a look-alike schema all raise here. Reading this SQL
 * requires no privileges beyond catalog access, so it is also the projection a
 * restricted reconciliation connection runs.
 */
export function renderManagedOperationCustodyVerifySql(binding) {
  const bound = assertManagedOperationCustodyBinding(binding);
  const bodies = routineBodies(bound);
  const routineChecks = Object.entries(bodies)
    .map(([routine, body]) => {
      const signature = routineSignature[routine];
      return `     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
       JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
       JOIN pg_catalog.pg_language l ON l.oid=p.prolang
       WHERE n.nspname='${custodySchema}' AND p.proname='${routine}'
         AND pg_catalog.pg_get_function_identity_arguments(p.oid)='${signature.args}'
         AND l.lanname='plpgsql' AND p.prosecdef AND p.prokind='f'
         AND p.proowner=${roleOid(custodyOwner)} AND p.provolatile='v'
         AND p.proconfig=ARRAY['search_path=pg_catalog, public']::text[]
         AND p.prosrc=$${routine}_expected$${body}$${routine}_expected$
         AND p.proacl IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM pg_catalog.aclexplode(p.proacl) a
           WHERE a.is_grantable
             OR a.grantee NOT IN (SELECT oid FROM pg_catalog.pg_roles
               WHERE rolname IN ('${custodyOwner}','${routineGrantee[routine]}'))
             OR a.grantor<>${roleOid(custodyOwner)}))`;
    })
    .join("\n");
  return `DO $custody_attestation$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n
       JOIN pg_catalog.pg_roles owner ON owner.oid=n.nspowner
       WHERE n.nspname='${custodySchema}' AND owner.rolname='${custodyOwner}'
         AND n.nspacl IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM pg_catalog.aclexplode(n.nspacl) a
           WHERE a.grantor<>n.nspowner OR a.is_grantable
             OR (a.grantee<>n.nspowner AND (a.privilege_type<>'USAGE'
               OR a.grantee NOT IN (SELECT oid FROM pg_catalog.pg_roles
                 WHERE rolname IN ('${coordinator}','${custodyReader}'))))))
     OR (SELECT count(*) FROM pg_catalog.pg_proc p
         JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
         WHERE n.nspname='${custodySchema}') <> ${Object.keys(bodies).length + 1}
     OR (SELECT count(*) FROM pg_catalog.pg_class c
         JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
         WHERE n.nspname='${custodySchema}' AND c.relkind='r') <> 2
${routineChecks}
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
       JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='${custodySchema}' AND p.proname='custody_immutable'
         AND p.proowner=${roleOid(custodyOwner)} AND NOT p.prosecdef
         AND p.prosrc=$custody_immutable_expected$${immutabilityTriggerBody}$custody_immutable_expected$)
     OR (SELECT count(*) FROM pg_catalog.pg_trigger t
         JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
         JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
         WHERE n.nspname='${custodySchema}' AND NOT t.tgisinternal
           AND t.tgenabled='A' AND t.tgfoid=(SELECT p.oid FROM pg_catalog.pg_proc p
             JOIN pg_catalog.pg_namespace pn ON pn.oid=p.pronamespace
             WHERE pn.nspname='${custodySchema}' AND p.proname='custody_immutable')) <> 2
     -- Both custody tables are reachable only through the protected routines.
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
       CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
       WHERE n.nspname='${custodySchema}' AND c.relkind='r'
         AND (a.grantee<>c.relowner OR a.grantor<>c.relowner OR a.is_grantable))
     -- The custody owner cannot log in and the coordinator cannot become it.
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles
       WHERE rolname='${custodyOwner}' AND NOT rolcanlogin AND NOT rolsuper
         AND NOT rolinherit AND NOT rolcreatedb AND NOT rolcreaterole
         AND NOT rolreplication AND NOT rolbypassrls)
     OR pg_catalog.pg_has_role('${coordinator}','${custodyOwner}','USAGE')
     OR pg_catalog.pg_has_role('${coordinator}','${custodyOwner}','SET')
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles
       WHERE rolname='${custodyReader}' AND rolcanlogin AND NOT rolsuper
         AND NOT rolinherit AND NOT rolcreatedb AND NOT rolcreaterole
         AND NOT rolreplication AND NOT rolbypassrls)
     OR pg_catalog.pg_has_role('${custodyReader}','${custodyOwner}','USAGE')
     OR pg_catalog.pg_has_role('${custodyReader}','${custodyOwner}','SET')
     -- Exactly the two declared read grants the protected writer needs.
     OR (SELECT count(*) FROM pg_catalog.pg_class c
         JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
         CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a
         WHERE c.relacl IS NOT NULL AND a.grantee=${roleOid(custodyOwner)}
           AND a.grantee<>c.relowner
           AND (a.privilege_type<>'SELECT' OR a.is_grantable
             OR format('%I.%I',n.nspname,c.relname) NOT IN (${renderManagedOperationCustodyContract.ownerReadGrants
               .map((identity) => literal(identity))
               .join(",")}))) <> 0
     OR (SELECT count(*) FROM pg_catalog.pg_class c
         CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a
         WHERE c.relacl IS NOT NULL AND a.grantee=${roleOid(custodyOwner)}
           AND a.grantee<>c.relowner) <> ${renderManagedOperationCustodyContract.ownerReadGrants.length} THEN
    RAISE EXCEPTION 'custody_attestation_failed';
  END IF;
END $custody_attestation$;`;
}

/**
 * Bootstrap this operation's custody in the qualified database, as the
 * non-superuser owner. No superuser, second database or second service is
 * required. The returned `bootstrapSql` is a complete transaction; it refuses
 * to run when custody, either role or the schema already exists, so an existing
 * custody is never silently adopted.
 */
export function renderManagedOperationCustodyBootstrap(binding) {
  const bound = assertManagedOperationCustodyBinding(binding);
  const bodies = routineBodies(bound);
  const verifySql = renderManagedOperationCustodyVerifySql(bound);
  const bootstrapSql = `BEGIN ISOLATION LEVEL READ COMMITTED;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL lock_timeout = '5000ms';
DO $custody_precondition$ BEGIN
  IF session_user <> '${coordinator}' OR current_user <> '${coordinator}'
     OR current_database() <> ${literal(bound.databaseName)}
     OR (SELECT system_identifier::text FROM pg_control_system()) <> ${literal(bound.systemIdentifier)}
     OR (SELECT oid::text FROM pg_database WHERE datname=current_database()) <> ${literal(bound.databaseOid)}
     OR (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) THEN
    RAISE EXCEPTION 'custody_bootstrap_identity';
  END IF;
  -- Existing custody is authenticated by attestation, never adopted by name.
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname='${custodySchema}')
     OR EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('${custodyOwner}','${custodyReader}')) THEN
    RAISE EXCEPTION 'custody_already_present';
  END IF;
END $custody_precondition$;
-- A temporary SET/INHERIT self-grant is the only way a non-superuser owner can
-- create objects owned by a role it must not be able to become afterwards.
-- PostgreSQL 16+ records that self-grant at CREATE ROLE time; it is narrowed
-- back to ADMIN-only below, and the attestation proves the narrowing happened.
SET LOCAL createrole_self_grant = 'set, inherit';
CREATE ROLE ${custodyOwner} ${custodyRoleOptions};
SET LOCAL createrole_self_grant = '';
CREATE ROLE ${custodyReader} ${readerRoleOptions};
${schemaSql()}
${routineSql(bodies)}
RESET ROLE;
${renderManagedOperationCustodyContract.ownerReadGrants
  .map((identity) => `GRANT SELECT ON ${identity} TO ${custodyOwner};`)
  .join("\n")}
REVOKE ${custodyOwner} FROM ${coordinator} GRANTED BY ${coordinator} RESTRICT;
${verifySql}
COMMIT;`;
  return Object.freeze({
    kind: contractKind,
    operationId: bound.operationId,
    schema: custodySchema,
    ownerRole: custodyOwner,
    readerRole: custodyReader,
    bootstrapSql,
    verifySql,
    // Bootstrapping custody is not authorization to mutate anything. It creates
    // the boundary the reviewed operation must pass through; the approval root
    // stays in reviewed source.
    custodyEstablished: true,
    authorizesMutation: false,
  });
}

/**
 * Remove this operation's custody after its receipts have been read out. The
 * two declared read grants are revoked with the operation, so the qualified
 * database returns to its original ACLs.
 */
export function renderManagedOperationCustodyTeardownSql(binding) {
  const bound = assertManagedOperationCustodyBinding(binding);
  return `BEGIN ISOLATION LEVEL READ COMMITTED;
SET LOCAL search_path = pg_catalog, public;
DO $custody_teardown_identity$ BEGIN
  IF session_user <> '${coordinator}' OR current_user <> '${coordinator}' THEN
    RAISE EXCEPTION 'custody_teardown_identity';
  END IF;
END $custody_teardown_identity$;
${renderManagedOperationCustodyContract.ownerReadGrants
  .map((identity) => `REVOKE SELECT ON ${identity} FROM ${custodyOwner};`)
  .join("\n")}
GRANT ${custodyOwner} TO ${coordinator} WITH INHERIT TRUE, SET TRUE;
DO $custody_teardown$ BEGIN
  -- Custody is removed only after this operation reached a resolved state. An
  -- operation still open without an effect receipt keeps its custody.
  IF NOT EXISTS (SELECT 1 FROM ${custodySchema}.operation_effect_receipt
                 WHERE operation_id=${literal(bound.operationId)}::uuid)
     AND EXISTS (SELECT 1 FROM ${custodySchema}.operation_permit
                 WHERE operation_id=${literal(bound.operationId)}::uuid AND state='open') THEN
    RAISE EXCEPTION 'custody_teardown_operation_unresolved';
  END IF;
END $custody_teardown$;
DROP SCHEMA ${custodySchema} CASCADE;
DROP ROLE ${custodyReader};
DROP ROLE ${custodyOwner};
COMMIT;`;
}

// ---------------------------------------------------------------------------
// Protected routine calls
// ---------------------------------------------------------------------------

const jsonArgument = (value) => literal(JSON.stringify(value));

/** Open (or idempotently re-open) this operation's permit. */
export function renderManagedOperationOpenPermitSql(
  binding,
  { generation, nonce, terminalCatalogDigest, admissionIdentityDigest },
) {
  const bound = assertManagedOperationCustodyBinding(binding);
  if (!positive(generation)) fail("generation");
  if (!nonceValue(nonce)) fail("nonce");
  if (!digest(terminalCatalogDigest)) fail("terminal_catalog_digest");
  if (!digest(admissionIdentityDigest)) fail("admission_identity_digest");
  return `SELECT ${custodySchema}.custody_open_operation(${jsonArgument({
    kind: contractKind,
    operationId: bound.operationId,
    admissionIdentityDigest,
    recoveryIdentitySha256: bound.recoveryIdentitySha256,
    externalFenceSha256: bound.externalFenceSha256,
    terminalCatalogDigest,
    generation: String(generation),
    nonce,
  })}::jsonb);`;
}

/** Read the current permit; `lock` takes the row lock inside a transaction. */
export function renderManagedOperationCurrentPermitSql(binding, lock = false) {
  const bound = assertManagedOperationCustodyBinding(binding);
  if (typeof lock !== "boolean") fail("permit_lock");
  return `SELECT ${custodySchema}.custody_current_permit(${literal(bound.operationId)}::uuid,${lock});`;
}

/** Compare-and-set the permit epoch. A stale epoch or nonce advances nothing. */
export function renderManagedOperationAdvanceEpochSql(
  binding,
  { expectedEpoch, expectedNonce, nextNonce },
) {
  const bound = assertManagedOperationCustodyBinding(binding);
  if (!positive(expectedEpoch)) fail("expected_epoch");
  if (!nonceValue(expectedNonce) || !nonceValue(nextNonce))
    fail("advance_nonce");
  return `SELECT ${custodySchema}.custody_advance_epoch(${literal(bound.operationId)}::uuid,${expectedEpoch}::bigint,${literal(expectedNonce)},${literal(nextNonce)});`;
}

/**
 * The protected effect-receipt call. It belongs INSIDE the coordinator's DDL
 * transaction, after the seven bodies and the reviewed terminal catalog check,
 * and before COMMIT: the routine refuses to run outside that exclusive
 * transaction and re-derives the ledger, manifest and gate itself.
 */
export function renderManagedOperationRecordEffectSql(
  binding,
  { epoch, nonce, generation, terminalCatalogDigest, admissionIdentityDigest },
) {
  const bound = assertManagedOperationCustodyBinding(binding);
  if (!positive(epoch) || !positive(generation)) fail("effect_coordinates");
  if (!nonceValue(nonce)) fail("effect_nonce");
  if (!digest(terminalCatalogDigest)) fail("effect_terminal_catalog");
  if (!digest(admissionIdentityDigest)) fail("effect_admission_identity");
  return `SELECT ${custodySchema}.custody_record_effect(${jsonArgument({
    operationId: bound.operationId,
    admissionIdentityDigest,
    epoch: String(epoch),
    nonce,
    generation: String(generation),
    terminalCatalogDigest,
  })}::jsonb);`;
}

/** Restricted read of the operation-bound effect receipt. */
export function renderManagedOperationEffectReadSql(binding) {
  const bound = assertManagedOperationCustodyBinding(binding);
  return `SELECT COALESCE(${custodySchema}.custody_read_effect(${literal(bound.operationId)}::uuid),'null'::jsonb);`;
}

const receiptShape = shapeOf([
  "kind",
  "operationId",
  "generation",
  "epoch",
  "nonce",
  "ledgerManifest",
  "terminalCatalogDigest",
  "effectFingerprint",
  "backendPid",
  "transactionId",
  "recordedAt",
  "permitState",
]);

/**
 * Validate an observed effect receipt against this operation's binding and the
 * permit coordinates the coordinator believed it was using.
 *
 * The fingerprint is recomputed from the receipt's own fields, so a receipt
 * whose contents were edited after the fact no longer verifies. A receipt for
 * another operation, epoch, nonce or generation is rejected outright.
 */
export function assertManagedOperationEffectReceipt(
  receipt,
  {
    binding,
    epoch,
    nonce,
    generation,
    terminalCatalogDigest,
    admissionIdentityDigest,
  },
) {
  const bound = assertManagedOperationCustodyBinding(binding);
  if (keysOf(receipt) !== receiptShape) fail("receipt_shape");
  if (!positive(epoch) || !positive(generation)) fail("receipt_coordinates");
  if (!nonceValue(nonce)) fail("receipt_nonce");
  if (!digest(terminalCatalogDigest)) fail("receipt_terminal_catalog");
  if (!digest(admissionIdentityDigest)) fail("receipt_admission_identity");
  if (
    receipt.kind !== contractKind ||
    receipt.operationId !== bound.operationId ||
    receipt.epoch !== String(epoch) ||
    receipt.nonce !== nonce ||
    receipt.generation !== String(generation) ||
    receipt.permitState !== "terminal"
  )
    fail("receipt_binding");
  if (
    receipt.ledgerManifest !== renderHistorical89AdmissionPhase.targetManifest
  )
    fail("receipt_manifest");
  if (receipt.terminalCatalogDigest !== terminalCatalogDigest)
    fail("receipt_catalog");
  if (
    !Number.isSafeInteger(receipt.backendPid) ||
    receipt.backendPid < 1 ||
    typeof receipt.transactionId !== "string" ||
    !/^[1-9][0-9]*$/u.test(receipt.transactionId) ||
    typeof receipt.recordedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(receipt.recordedAt)
  )
    fail("receipt_execution_facts");
  // Recomputed from the receipt's own fields, joined exactly as the protected
  // routine joined them. An edited receipt no longer verifies.
  const fingerprint = `sha256:${sha256(
    [
      receipt.kind,
      receipt.operationId,
      admissionIdentityDigest,
      bound.systemIdentifier,
      bound.databaseOid,
      bound.databaseName,
      bound.recoveryIdentitySha256,
      bound.externalFenceSha256,
      receipt.generation,
      receipt.epoch,
      receipt.nonce,
      receipt.ledgerManifest,
      receipt.terminalCatalogDigest,
    ].join("\n"),
  )}`;
  if (receipt.effectFingerprint !== fingerprint) fail("receipt_fingerprint");
  return Object.freeze({ ...receipt, effectFingerprint: fingerprint });
}

/**
 * In-transaction re-verification of the current permit.
 *
 * This belongs inside the coordinator's DDL transaction, before any body runs.
 * It takes the permit row lock for the whole transaction and rejects a stale
 * epoch, a rotated nonce, a different generation, a terminal permit or any
 * drifted identity field. A concurrent coordinator that advanced the epoch
 * therefore stops this one rather than racing it.
 */
export function renderManagedOperationPermitAssertionSql(
  binding,
  { epoch, nonce, generation, terminalCatalogDigest, admissionIdentityDigest },
) {
  const bound = assertManagedOperationCustodyBinding(binding);
  if (!positive(epoch) || !positive(generation)) fail("permit_coordinates");
  if (!nonceValue(nonce)) fail("permit_nonce");
  if (!digest(terminalCatalogDigest)) fail("permit_terminal_catalog");
  if (!digest(admissionIdentityDigest)) fail("permit_admission_identity");
  const expected = {
    kind: contractKind,
    operationId: bound.operationId,
    admissionIdentityDigest,
    systemIdentifier: bound.systemIdentifier,
    databaseOid: bound.databaseOid,
    databaseName: bound.databaseName,
    recoveryIdentitySha256: bound.recoveryIdentitySha256,
    externalFenceSha256: bound.externalFenceSha256,
    terminalCatalogDigest,
    generation: String(generation),
    epoch: String(epoch),
    nonce,
    state: "open",
  };
  const comparisons = Object.entries(expected)
    .map(
      ([key, value]) => `current->>'${key}' IS DISTINCT FROM ${literal(value)}`,
    )
    .join("\n     OR ");
  return `DO $current_permit$
DECLARE current jsonb;
BEGIN
  current := ${custodySchema}.custody_current_permit(${literal(bound.operationId)}::uuid,true);
  IF ${comparisons} THEN
    RAISE EXCEPTION 'historical89_permit_stale';
  END IF;
END $current_permit$;`;
}
