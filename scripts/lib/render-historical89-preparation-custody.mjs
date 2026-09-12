import {
  assertManagedOperationCustodyBinding,
  renderManagedOperationCustodyFinalObjectsSql,
  renderManagedOperationCustodyVerifySql,
} from "./render-managed-operation-custody.mjs";

// Bounded, owner-operated staging in the SAME database. References are custody
// coordinates, not independently approved evidence. These renderers neither
// perform provider effects nor authorize production mutation. The database owner
// can undo its own ACL boundary; this is explicitly not independent approval.
const schema = "release_operation_custody";
const owner = "reviewrouter_operation_custody_owner";
const reader = "reviewrouter_operation_custody_reader";
const coordinator = "reviewrouter";
const table = `${schema}.historical89_preparation`;
const q = (v) => `'${String(v).replaceAll("'", "''")}'`;
const json = (v) => `${q(JSON.stringify(v))}::jsonb`;
const fail = (s) => {
  throw new Error(`historical89_preparation_rejected:${s}`);
};
const digest = (v) => typeof v === "string" && /^sha256:[a-f0-9]{64}$/u.test(v);
const shape = (v, keys) =>
  v &&
  Object.getPrototypeOf(v) === Object.prototype &&
  Object.keys(v).sort().join() === [...keys].sort().join();
const identityKeys = [
  "operationId",
  "systemIdentifier",
  "databaseOid",
  "databaseName",
  "sourceCommit",
  "artifactReference",
  "approvalReference",
  "baselineReference",
  "fleetReference",
  "serviceIds",
];

export function assertHistorical89PreparationIdentity(value) {
  if (!shape(value, identityKeys)) fail("identity_shape");
  // Validate the common identity without inventing future recovery/fence values.
  if (
    typeof value.operationId !== "string" ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value.operationId) ||
    typeof value.systemIdentifier !== "string" ||
    !/^[1-9][0-9]*$/u.test(value.systemIdentifier) ||
    typeof value.databaseOid !== "string" ||
    !/^[1-9][0-9]*$/u.test(value.databaseOid) ||
    typeof value.databaseName !== "string" ||
    !/^[a-z_][a-z0-9_]{0,62}$/u.test(value.databaseName)
  )
    fail("database_identity");
  if (
    typeof value.sourceCommit !== "string" ||
    !/^[a-f0-9]{40}$/u.test(value.sourceCommit)
  )
    fail("source_commit");
  for (const key of [
    "artifactReference",
    "approvalReference",
    "baselineReference",
    "fleetReference",
  ])
    if (!digest(value[key])) fail(key);
  if (
    !Array.isArray(value.serviceIds) ||
    value.serviceIds.length < 1 ||
    value.serviceIds.length > 64 ||
    value.serviceIds.some(
      (v) => typeof v !== "string" || !/^srv-[a-z0-9]{1,64}$/u.test(v),
    ) ||
    new Set(value.serviceIds).size !== value.serviceIds.length
  )
    fail("service_ids");
  return Object.freeze({
    ...value,
    serviceIds: Object.freeze([...value.serviceIds]),
  });
}
const revision = (n) => {
  if (!Number.isSafeInteger(n) || n < 1) fail("revision");
  return n;
};
const dbGuard = (
  b,
) => `IF session_user <> '${coordinator}' OR current_user <> '${coordinator}'
  OR current_database() <> ${q(b.databaseName)}
  OR (SELECT system_identifier::text FROM pg_catalog.pg_control_system()) <> ${q(b.systemIdentifier)}
  OR (SELECT oid::text FROM pg_catalog.pg_database WHERE datname=current_database()) <> ${q(b.databaseOid)}
  OR (SELECT datdba FROM pg_catalog.pg_database WHERE datname=current_database()) <> (SELECT oid FROM pg_catalog.pg_roles WHERE rolname='${coordinator}')
  OR (SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname=session_user) THEN
  RAISE EXCEPTION 'preparation_database_identity'; END IF;`;

// No defaults, indexes, generated expressions, policies or constraints to hide
// behavior: the single ALWAYS trigger below is the complete transition policy.
// Access is owner-only for writes; restricted recovery reads use SELECT only.
const columns = [
  ["identity", "jsonb", true],
  ["original_connect", "jsonb", true],
  ["revision", "bigint", true],
  ["services", "jsonb", true],
  ["evidence", "jsonb", true],
  ["finalization", "jsonb", false],
  ["last_request", "jsonb", true],
];
const triggerBody = `
DECLARE item record;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'preparation_delete_forbidden'; END IF;
  IF TG_OP='INSERT' THEN
    IF EXISTS (SELECT 1 FROM ${table}) OR NEW.revision<>1 OR NEW.services<>'{}'::jsonb
       OR NEW.evidence<>'{}'::jsonb OR NEW.last_request<>'{}'::jsonb OR NEW.finalization IS NOT NULL THEN
      RAISE EXCEPTION 'preparation_single_operation'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.identity IS DISTINCT FROM OLD.identity OR NEW.original_connect IS DISTINCT FROM OLD.original_connect THEN
    RAISE EXCEPTION 'preparation_identity_immutable'; END IF;
  IF OLD.finalization IS NOT NULL THEN RAISE EXCEPTION 'preparation_finalized'; END IF;
  IF NEW.revision IS DISTINCT FROM OLD.revision+1 THEN RAISE EXCEPTION 'preparation_revision'; END IF;
  IF jsonb_typeof(NEW.services) IS DISTINCT FROM 'object' OR jsonb_typeof(NEW.evidence) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'preparation_state_shape'; END IF;
  FOR item IN SELECT key,value FROM jsonb_each(OLD.services) LOOP
    IF NOT NEW.services ? item.key OR NEW.services->item.key->'intentSha256' IS DISTINCT FROM item.value->'intentSha256'
       OR (item.value->>'resultSha256' IS NOT NULL AND NEW.services->item.key IS DISTINCT FROM item.value) THEN
      RAISE EXCEPTION 'preparation_service_immutable'; END IF;
  END LOOP;
  FOR item IN SELECT key,value FROM jsonb_each(NEW.services) LOOP
    IF NOT (NEW.identity->'serviceIds' ? item.key)
       OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(item.value) key) IS DISTINCT FROM ARRAY['intentSha256','resultSha256']::text[]
       OR COALESCE(item.value->>'intentSha256','') !~ '^sha256:[a-f0-9]{64}$'
       OR (item.value->>'resultSha256' IS NOT NULL AND (COALESCE(item.value->>'resultSha256','') !~ '^sha256:[a-f0-9]{64}$'
         OR NOT OLD.services ? item.key)) THEN
      RAISE EXCEPTION 'preparation_intent_before_result'; END IF;
  END LOOP;
  FOR item IN SELECT key,value FROM jsonb_each(OLD.evidence) LOOP
    IF NEW.evidence->item.key IS DISTINCT FROM item.value THEN RAISE EXCEPTION 'preparation_evidence_immutable'; END IF;
  END LOOP;
  FOR item IN SELECT key,value FROM jsonb_each_text(NEW.evidence) LOOP
    IF item.key NOT IN ('recoveryIdentitySha256','externalFenceSha256') OR item.value IS NULL OR item.value !~ '^sha256:[a-f0-9]{64}$' THEN
      RAISE EXCEPTION 'preparation_evidence_shape'; END IF;
  END LOOP;
  IF NEW.finalization IS NOT NULL THEN
    IF NEW.services IS DISTINCT FROM OLD.services OR NEW.evidence IS DISTINCT FROM OLD.evidence
       OR NEW.finalization IS DISTINCT FROM jsonb_build_object('binding',OLD.evidence,'expectedRevision',OLD.revision)
       OR (SELECT count(*) FROM jsonb_object_keys(OLD.evidence))<>2
       OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(OLD.identity->'serviceIds') id
          WHERE OLD.services->id->>'resultSha256' IS NULL) THEN
      RAISE EXCEPTION 'preparation_finalization_binding'; END IF;
  END IF;
  RETURN NEW;
END`;
const triggerSql = `CREATE FUNCTION ${schema}.historical89_preparation_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $preparation_trigger$${triggerBody}$preparation_trigger$;
REVOKE ALL ON FUNCTION ${schema}.historical89_preparation_immutable() FROM PUBLIC;
CREATE TRIGGER historical89_preparation_immutable BEFORE INSERT OR UPDATE OR DELETE ON ${table}
FOR EACH ROW EXECUTE FUNCTION ${schema}.historical89_preparation_immutable();
ALTER TABLE ${table} ENABLE ALWAYS TRIGGER historical89_preparation_immutable;`;
const oid = (r) => `(SELECT oid FROM pg_catalog.pg_roles WHERE rolname='${r}')`;
const externalNamespace = `n.nspname NOT IN ('${schema}','pg_catalog','information_schema','pg_toast')
  AND n.nspname !~ '^pg_(toast_)?temp_'`;

/** PL/pgSQL guard shared with final attestation. It compares definitions to
 * reviewed source, never to a digest stored in the schema being authenticated.
 * No catalog normalization, self-approved snapshot, or name-only adoption. */
export function renderHistorical89PreparationCatalogGuard(
  binding,
  finalized = false,
) {
  const attributes = columns
    .map(
      ([name, type, required], i) =>
        `(${i + 1},${q(name)},${q(type)},${required})`,
    )
    .join(",");
  return `
  IF current_database()<>${q(binding.databaseName)}
    OR (SELECT oid::text FROM pg_catalog.pg_database WHERE datname=current_database())<>${q(binding.databaseOid)}
    OR (SELECT system_identifier::text FROM pg_catalog.pg_control_system())<>${q(binding.systemIdentifier)} THEN
    RAISE EXCEPTION 'preparation_database_identity'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname='${schema}' AND n.nspowner=${oid(owner)}
    AND n.nspacl IS NOT NULL
    AND (SELECT count(*) FROM pg_catalog.aclexplode(n.nspacl))=4
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.aclexplode(n.nspacl) a WHERE a.grantor<>n.nspowner OR a.is_grantable
      OR NOT ((a.grantee=n.nspowner AND a.privilege_type IN ('USAGE','CREATE')) OR (a.grantee IN (${oid(reader)},${oid(coordinator)}) AND a.privilege_type='USAGE'))))
  OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='${schema}' AND c.relname='historical89_preparation' AND c.relkind='r' AND c.relpersistence='p'
      AND c.relowner=${oid(owner)} AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity AND NOT c.relispartition
      AND c.reloptions IS NULL AND c.relam=(SELECT oid FROM pg_catalog.pg_am WHERE amname='heap')
      AND c.relnatts=7 AND c.relchecks=0
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a FULL JOIN (VALUES ${attributes}) expected(num,name,type,required)
        ON a.attnum=expected.num WHERE (a.attrelid=c.oid OR a.attrelid IS NULL) AND (a.attnum>0 OR a.attnum IS NULL)
        AND (a.attnum IS NULL OR expected.num IS NULL OR a.attname<>expected.name OR pg_catalog.format_type(a.atttypid,a.atttypmod)<>expected.type
          OR a.attnotnull<>expected.required OR a.attisdropped OR a.atthasdef OR a.attidentity<>'' OR a.attgenerated<>''
          OR a.attcollation<>0 OR a.attcompression<>'' OR a.attstattarget<>-1
          OR a.attstorage<>(SELECT typstorage FROM pg_catalog.pg_type WHERE oid=a.atttypid)
          OR a.atthasmissing OR a.attacl IS NOT NULL OR a.attoptions IS NOT NULL OR a.attfdwoptions IS NOT NULL OR a.attinhcount<>0 OR NOT a.attislocal))
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid=c.oid)
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_index WHERE indrelid=c.oid)
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_rewrite WHERE ev_class=c.oid)
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid=c.oid)
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_inherits WHERE inhrelid=c.oid OR inhparent=c.oid)
      AND c.relacl IS NOT NULL
      AND (SELECT count(*) FROM pg_catalog.aclexplode(c.relacl))=(SELECT count(*)+2 FROM pg_catalog.aclexplode(pg_catalog.acldefault('r',c.relowner)))
      AND (SELECT count(*) FROM pg_catalog.aclexplode(c.relacl) a WHERE a.grantee<>c.relowner)=2
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.aclexplode(c.relacl) a WHERE a.grantor<>c.relowner OR a.is_grantable
        OR (a.grantee<>c.relowner AND (a.grantee NOT IN (${oid(reader)},${oid(coordinator)}) OR a.privilege_type<>'SELECT'))))
  OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='${schema}' AND p.proname='historical89_preparation_immutable' AND p.pronargs=0 AND p.proargtypes=''::oidvector
      AND p.proargnames IS NULL AND p.proallargtypes IS NULL AND p.proargmodes IS NULL AND p.pronargdefaults=0 AND p.prosupport=0
      AND p.prorettype='pg_catalog.trigger'::regtype AND p.proowner=${oid(owner)} AND NOT p.prosecdef AND NOT p.proleakproof
      AND NOT p.proretset AND NOT p.proisstrict AND p.prokind='f' AND p.provolatile='v' AND p.proparallel='u'
      AND p.prolang=(SELECT oid FROM pg_catalog.pg_language WHERE lanname='plpgsql')
      AND p.proconfig=ARRAY['search_path=pg_catalog, public']::text[] AND p.prosrc=${q(triggerBody)}
      AND p.procost=100 AND p.prorows=0 AND p.proacl IS NOT NULL
      AND (SELECT count(*) FROM pg_catalog.aclexplode(p.proacl))=1 AND NOT EXISTS (SELECT 1 FROM pg_catalog.aclexplode(p.proacl) a
        WHERE a.grantee<>p.proowner OR a.grantor<>p.proowner OR a.is_grantable))
  OR (SELECT count(*) FROM pg_catalog.pg_trigger t WHERE t.tgrelid=to_regclass('${table}'))<>1
  OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgrelid=to_regclass('${table}')
    AND t.tgname='historical89_preparation_immutable' AND t.tgenabled='A' AND t.tgtype=31
    AND t.tgattr=''::int2vector AND t.tgconstraint=0 AND t.tgconstrrelid=0 AND t.tgconstrindid=0
    AND t.tgfoid=to_regprocedure('${schema}.historical89_preparation_immutable()') AND t.tgnargs=0
    AND t.tgqual IS NULL AND NOT t.tgisinternal AND NOT t.tgdeferrable AND NOT t.tginitdeferred
    AND t.tgoldtable IS NULL AND t.tgnewtable IS NULL)
  OR (SELECT count(*) FROM pg_catalog.pg_roles WHERE rolname IN ('${owner}','${reader}') AND NOT rolsuper AND NOT rolinherit
      AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls
      AND rolcanlogin=(rolname='${reader}') AND rolconfig IS NULL AND rolconnlimit=-1 AND rolvaliduntil IS NULL)<>2
  OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m WHERE (m.roleid IN (${oid(owner)},${oid(reader)})
      OR m.member IN (${oid(owner)},${oid(reader)})) AND NOT (m.roleid IN (${oid(owner)},${oid(reader)}) AND m.member=${oid(coordinator)}
      AND m.admin_option AND NOT m.inherit_option AND NOT m.set_option))
  OR EXISTS (SELECT 1 FROM pg_catalog.pg_db_role_setting WHERE setrole IN (${oid(owner)},${oid(reader)}))
  OR EXISTS (SELECT 1 FROM pg_catalog.pg_depend d WHERE d.refclassid='pg_catalog.pg_namespace'::regclass
    AND d.refobjid=(SELECT oid FROM pg_catalog.pg_namespace WHERE nspname='${schema}')
    AND d.classid NOT IN ('pg_catalog.pg_class'::regclass,'pg_catalog.pg_type'::regclass,'pg_catalog.pg_proc'::regclass,'pg_catalog.pg_constraint'::regclass))
  OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE c.relowner IN (${oid(owner)},${oid(reader)}) AND n.nspname NOT IN ('${schema}','pg_toast'))
  OR EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a CROSS JOIN LATERAL pg_catalog.aclexplode(a.attacl) acl
    WHERE acl.grantee IN (${oid(owner)},${oid(reader)}))
  OR EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n CROSS JOIN LATERAL pg_catalog.aclexplode(n.nspacl) a
    WHERE a.grantee IN (${oid(owner)},${oid(reader)}) AND n.nspname<>'${schema}')
  OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a WHERE a.grantee=${oid(reader)} AND (n.nspname<>'${schema}' OR c.relname<>'historical89_preparation'))
  OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(p.proacl) a WHERE a.grantee IN (${oid(owner)},${oid(reader)}) AND n.nspname<>'${schema}')
  OR EXISTS (SELECT 1 FROM pg_catalog.pg_database d CROSS JOIN LATERAL pg_catalog.aclexplode(d.datacl) a
    WHERE a.grantee IN (${oid(owner)},${oid(reader)}) AND (a.grantee<>${oid(reader)} OR d.datname<>current_database() OR a.privilege_type<>'CONNECT' OR a.is_grantable))
  OR EXISTS (SELECT 1 FROM pg_catalog.pg_default_acl WHERE defaclnamespace=(SELECT oid FROM pg_catalog.pg_namespace WHERE nspname='${schema}')
      OR defaclrole IN (${oid(owner)},${oid(reader)}))
  -- Effective privileges include PUBLIC and implicit ownership privileges.
  OR EXISTS (SELECT 1 FROM pg_catalog.pg_database d
    WHERE pg_catalog.has_database_privilege(${oid(reader)},d.oid,'CREATE'))
  OR EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n WHERE ${externalNamespace}
    AND pg_catalog.has_schema_privilege(${oid(reader)},n.oid,'CREATE'))
  OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE ${externalNamespace} AND c.relkind IN ('r','p','v','m','f')
    AND (pg_catalog.has_table_privilege(${oid(reader)},c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
      OR pg_catalog.has_any_column_privilege(${oid(reader)},c.oid,'INSERT,UPDATE,REFERENCES')))
  OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE ${externalNamespace} AND c.relkind='S'
    AND CASE WHEN c.relkind='S' THEN pg_catalog.has_sequence_privilege(${oid(reader)},c.oid,'USAGE,UPDATE') ELSE false END)
  OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    WHERE ${externalNamespace} AND p.prosecdef AND p.prokind IN ('f','p')
    AND p.prorettype<>'pg_catalog.event_trigger'::regtype
    AND pg_catalog.has_function_privilege(${oid(reader)},p.oid,'EXECUTE')) THEN
    RAISE EXCEPTION 'preparation_catalog_attestation';
  END IF;
  IF (SELECT count(*) FROM ${table})<>1 OR NOT EXISTS (SELECT 1 FROM ${table} p WHERE
      p.identity->>'operationId'=${q(binding.operationId)} AND p.identity->>'systemIdentifier'=${q(binding.systemIdentifier)}
      AND p.identity->>'databaseOid'=${q(binding.databaseOid)} AND p.identity->>'databaseName'=${q(binding.databaseName)}
      ${finalized ? `AND p.finalization->'binding'=${json({ recoveryIdentitySha256: binding.recoveryIdentitySha256, externalFenceSha256: binding.externalFenceSha256 })}` : ""}) THEN
    RAISE EXCEPTION 'preparation_identity_conflict';
  END IF;`;
}

const preparedGuard = (b) => `${renderHistorical89PreparationCatalogGuard(b)}
  IF (SELECT identity FROM ${table}) IS DISTINCT FROM ${json(b)} THEN RAISE EXCEPTION 'preparation_identity_conflict'; END IF;
  IF (SELECT finalization FROM ${table}) IS NULL THEN
    IF (SELECT count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='${schema}')<>1
      OR (SELECT count(*) FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='${schema}')<>1
      OR (SELECT count(*) FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='${schema}')<>2
      OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a
        WHERE a.grantee=${oid(owner)} AND c.relowner<>a.grantee) THEN
      RAISE EXCEPTION 'preparation_catalog_attestation'; END IF;
  ELSE
    RAISE EXCEPTION 'preparation_use_final_binding';
  END IF;`;
const begin = (b) => `BEGIN ISOLATION LEVEL READ COMMITTED;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL lock_timeout = '5000ms';
-- Serialize creation and all staged transitions, including exact replays.
SELECT pg_catalog.pg_advisory_xact_lock(1783285769,89);
DO $preparation_identity$ BEGIN ${dbGuard(b)} END $preparation_identity$;`;
const assumeOwner = `GRANT ${owner} TO ${coordinator} WITH INHERIT TRUE, SET TRUE;
SET LOCAL ROLE ${owner};`;
const releaseOwner = `RESET ROLE;
REVOKE ${owner} FROM ${coordinator} GRANTED BY ${coordinator} RESTRICT;`;
const readRow = `SELECT jsonb_build_object('identity',identity,'originalConnect',original_connect,'revision',revision::text,
  'services',services,'evidence',evidence,'finalization',finalization,'independentlyApproved',false) FROM ${table};`;
const product = (b, sql) =>
  Object.freeze({
    operationId: b.operationId,
    sql,
    authorizesMutation: false,
    independentlyApproved: false,
    runnerVerdict: "NO_GO",
  });

/** Creates only the protected staging table and roles. Captures original CONNECT
 * entries directly from pg_database, preserving BOTH grantor name and OID. */
export function renderHistorical89PreparationPrepareParts(identity) {
  const b = assertHistorical89PreparationIdentity(identity);
  const create = `SET LOCAL createrole_self_grant = 'set, inherit';
CREATE ROLE ${owner} NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
SET LOCAL createrole_self_grant = '';
CREATE ROLE ${reader} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE SCHEMA ${schema} AUTHORIZATION ${owner};
SET LOCAL ROLE ${owner};
REVOKE ALL ON SCHEMA ${schema} FROM PUBLIC;
GRANT USAGE ON SCHEMA ${schema} TO ${coordinator}, ${reader};
CREATE TABLE ${table} (${columns.map(([name, type, required]) => `${name} ${type}${required ? " NOT NULL" : ""}`).join(",")});
REVOKE ALL ON ${table} FROM PUBLIC;
GRANT SELECT ON ${table} TO ${coordinator}, ${reader};
${triggerSql}
INSERT INTO ${table} SELECT ${json(b)},jsonb_build_object('database',d.datname,'raw',d.datacl::text,'entries',
  (SELECT COALESCE(jsonb_agg(jsonb_build_object('grantee',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,
    'granteeOid',a.grantee::text,'grantor',pg_get_userbyid(a.grantor),'grantorOid',a.grantor::text,
    'privilege',a.privilege_type,'grantable',a.is_grantable) ORDER BY a.grantee,a.grantor),'[]'::jsonb)
   FROM aclexplode(COALESCE(d.datacl,acldefault('d',d.datdba))) a WHERE a.privilege_type='CONNECT')),
  1,'{}'::jsonb,'{}'::jsonb,NULL,'{}'::jsonb FROM pg_database d WHERE d.datname=current_database();
${releaseOwner}`;
  // Dynamic DDL only on the absent-schema path. Existing objects MUST pass the
  // source-derived verifier before any role grant or effect occurs.
  return Object.freeze({
    beginSql: begin(b),
    bodySql: `DO $prepare$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname='${schema}') THEN
   IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('${owner}','${reader}')) THEN RAISE EXCEPTION 'preparation_roles_present'; END IF;
   EXECUTE ${q(create)};
 END IF;
 ${preparedGuard(b)}
END $prepare$;`,
    readSql: readRow,
    commitSql: "COMMIT;",
  });
}

const joinParts = (parts) =>
  [parts.beginSql, parts.bodySql, parts.readSql, parts.commitSql].join("\n");

export function renderHistorical89PreparationPrepare(identity) {
  return product(
    identity,
    joinParts(renderHistorical89PreparationPrepareParts(identity)),
  );
}

/** Read across a fresh reader connection; all catalog checks precede the data.
 * After finalization the caller supplies the actual final binding for attestation. */
export function renderHistorical89PreparationReadSql(identity, finalBinding) {
  const b = assertHistorical89PreparationIdentity(identity);
  const verify = finalBinding
    ? finalVerify(b, finalBinding)
    : `DO $verify$ BEGIN ${preparedGuard(b)} END $verify$;`;
  return `BEGIN; SET LOCAL search_path = pg_catalog, public;
SELECT pg_catalog.pg_advisory_xact_lock_shared(1783285769,89);
${verify}
${readRow}
COMMIT;`;
}

const change = (b, request, body) =>
  product(
    b,
    `${begin(b)}
DO $verify$ BEGIN ${preparedGuard(b)} END $verify$;
${assumeOwner}
LOCK TABLE ${table} IN EXCLUSIVE MODE;
DO $change$ DECLARE p ${table}; BEGIN
 SELECT * INTO STRICT p FROM ${table};
 IF p.last_request=${json(request)} AND p.revision=${revision(request.expectedRevision)}+1 THEN
   NULL; -- Exact replay of the last committed transition after a lost ACK.
 ELSE
   IF p.revision<>${request.expectedRevision} THEN RAISE EXCEPTION 'preparation_stale_revision'; END IF;
   ${body.replaceAll("SET revision=revision+1,", `SET revision=revision+1,last_request=${json(request)},`)}
 END IF;
END $change$;
${releaseOwner}
DO $verify$ BEGIN ${preparedGuard(b)} END $verify$;
${readRow}
COMMIT;`,
  );

/** Persist and COMMIT intent before invoking an external effect. An observation
 * is a digest reference, not a claim that this renderer witnessed the provider. */
export function renderHistorical89PreparationService(identity, request) {
  const b = assertHistorical89PreparationIdentity(identity);
  if (
    !shape(request, ["expectedRevision", "serviceId", "phase", "digest"]) ||
    !b.serviceIds.includes(request.serviceId) ||
    !["intent", "result"].includes(request.phase) ||
    !digest(request.digest)
  )
    fail("service_request");
  const id = q(request.serviceId);
  const field = request.phase === "intent" ? "intentSha256" : "resultSha256";
  return change(
    b,
    request,
    `
 IF p.services->${id}->>${q(field)} IS NOT NULL THEN
   IF p.services->${id}->>${q(field)}<>${q(request.digest)} THEN RAISE EXCEPTION 'preparation_service_conflict'; END IF;
 ELSE
   ${request.phase === "result" ? `IF NOT p.services ? ${id} THEN RAISE EXCEPTION 'preparation_intent_before_result'; END IF;` : ""}
   UPDATE ${table} SET revision=revision+1,services=jsonb_set(services,ARRAY[${id}],
     ${request.phase === "intent" ? `jsonb_build_object('intentSha256',${q(request.digest)},'resultSha256',NULL)` : `jsonb_set(services->${id},'{resultSha256}',to_jsonb(${q(request.digest)}::text))`});
 END IF;`,
  );
}

/** Bind each later observation once, with CAS. No future digest is required to
 * create the reader or capture the original admission grants. */
export function renderHistorical89PreparationObserve(identity, request) {
  const b = assertHistorical89PreparationIdentity(identity);
  if (
    !shape(request, ["expectedRevision", "kind", "digest"]) ||
    !["recoveryIdentitySha256", "externalFenceSha256"].includes(request.kind) ||
    !digest(request.digest)
  )
    fail("observation_request");
  return change(
    b,
    request,
    `
 IF p.evidence ? ${q(request.kind)} THEN
   IF p.evidence->>${q(request.kind)} IS DISTINCT FROM ${q(request.digest)} THEN RAISE EXCEPTION 'preparation_evidence_conflict'; END IF;
 ELSE
   UPDATE ${table} SET revision=revision+1,evidence=evidence||jsonb_build_object(${q(request.kind)},${q(request.digest)});
 END IF;`,
  );
}
const finalVerify = (b, binding) => {
  const bound = assertManagedOperationCustodyBinding(binding);
  for (const key of [
    "operationId",
    "systemIdentifier",
    "databaseOid",
    "databaseName",
  ])
    if (bound[key] !== b[key]) fail("final_identity");
  return `${renderManagedOperationCustodyVerifySql(bound)}
DO $final_identity$ BEGIN
 IF (SELECT identity FROM ${table}) IS DISTINCT FROM ${json(b)} THEN RAISE EXCEPTION 'preparation_identity_conflict'; END IF;
END $final_identity$;`;
};

/** Irreversible once-only installation of the SAME accepted permit/receipt
 * routines. A finalization retry must carry the exact binding and original CAS
 * coordinate. No permit is opened and no independent approval is asserted. */
export function renderHistorical89PreparationFinalizeParts(
  identity,
  binding,
  expectedRevision,
) {
  const b = assertHistorical89PreparationIdentity(identity);
  const verify = finalVerify(b, binding);
  const expected = {
    binding: {
      recoveryIdentitySha256: binding.recoveryIdentitySha256,
      externalFenceSha256: binding.externalFenceSha256,
    },
    expectedRevision: revision(expectedRevision),
  };
  const install = `${assumeOwner}
LOCK TABLE ${table} IN EXCLUSIVE MODE;
UPDATE ${table} SET revision=revision+1,finalization=${json(expected)};
${renderManagedOperationCustodyFinalObjectsSql(binding)}
RESET ROLE;
GRANT SELECT ON public._prisma_migrations TO ${owner};
GRANT SELECT ON public."HostedCodexRuntimeGate" TO ${owner};
REVOKE ${owner} FROM ${coordinator} GRANTED BY ${coordinator} RESTRICT;`;
  return Object.freeze({
    beginSql: begin(b),
    bodySql: `DO $finalize$ BEGIN
 ${renderHistorical89PreparationCatalogGuard(b)}
 IF (SELECT identity FROM ${table}) IS DISTINCT FROM ${json(b)} THEN RAISE EXCEPTION 'preparation_identity_conflict'; END IF;
 IF (SELECT finalization FROM ${table}) IS NOT NULL THEN
   IF (SELECT finalization FROM ${table}) IS DISTINCT FROM ${json(expected)} THEN RAISE EXCEPTION 'preparation_finalization_conflict'; END IF;
 ELSE
   ${preparedGuard(b)}
   IF (SELECT revision FROM ${table})<>${expectedRevision} THEN RAISE EXCEPTION 'preparation_stale_revision'; END IF;
   EXECUTE ${q(install)};
 END IF;
END $finalize$;
${verify}`,
    readSql: readRow,
    commitSql: "COMMIT;",
  });
}

export function renderHistorical89PreparationFinalize(
  identity,
  binding,
  expectedRevision,
) {
  return product(
    identity,
    joinParts(
      renderHistorical89PreparationFinalizeParts(
        identity,
        binding,
        expectedRevision,
      ),
    ),
  );
}

/** Probe used before original admission. Abandoned prepare is the schema
 * without the later permit objects; finalized custody must not be dropped. */
export const renderHistorical89PreparationPresenceSql = `SELECT jsonb_build_object(
  'present',to_regnamespace('${schema}') IS NOT NULL,
  'permit',to_regclass('${schema}.operation_permit') IS NOT NULL,
  'owner',to_regrole('${owner}') IS NOT NULL,
  'reader',to_regrole('${reader}') IS NOT NULL)`;

/** Roll back a committed prepare that never reached identity-bound resume.
 * Only valid on the historical89 ledger with no permit installed. */
export function renderHistorical89PreparationUndoAbandonedSql() {
  return `BEGIN ISOLATION LEVEL READ COMMITTED;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL lock_timeout = '5000ms';
SELECT pg_catalog.pg_advisory_xact_lock(1783285769,89);
DO $undo_identity$ BEGIN
  IF session_user <> '${coordinator}' OR current_user <> '${coordinator}'
    OR (SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname=session_user) THEN
    RAISE EXCEPTION 'preparation_undo_identity'; END IF;
  IF (SELECT count(*) FROM public._prisma_migrations) IS DISTINCT FROM 89 THEN
    RAISE EXCEPTION 'preparation_undo_ledger'; END IF;
  IF to_regclass('${schema}.operation_permit') IS NOT NULL THEN
    RAISE EXCEPTION 'preparation_undo_finalized'; END IF;
  IF to_regnamespace('${schema}') IS NULL
    OR to_regrole('${owner}') IS NULL
    OR to_regrole('${reader}') IS NULL THEN
    RAISE EXCEPTION 'preparation_undo_incomplete'; END IF;
END $undo_identity$;
GRANT ${owner} TO ${coordinator} WITH INHERIT TRUE, SET TRUE;
SET LOCAL ROLE ${owner};
DROP SCHEMA ${schema} CASCADE;
RESET ROLE;
REVOKE ${owner} FROM ${coordinator} GRANTED BY ${coordinator} RESTRICT;
REVOKE ${reader} FROM ${coordinator} GRANTED BY ${coordinator} RESTRICT;
DROP ROLE ${reader};
DROP ROLE ${owner};
COMMIT;`;
}
