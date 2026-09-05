import { effectivePrincipalInventorySql } from "../../packages/features/release-rollout/src/adapters/effective-principal-postgres.mjs";
import {
  assertRenderManagedRoleBranch,
  renderManagedEvidenceDigest,
} from "./render-schema-handoff-policy.mjs";

// Catalog observations only. Runtime table contents, credentials, ACL mutation,
// and approval-by-capture are deliberately absent. The canonical effective
// principal projection is supplemented with raw identities/ACLs, default-ACL
// overrides, routine definitions, role settings, and dependency/DDL facts.
export const renderManagedCatalogSql = `SET search_path = pg_catalog, public;
WITH authority(inventory) AS (
${effectivePrincipalInventorySql}
), namespaces AS (
  SELECT * FROM pg_catalog.pg_namespace
  WHERE nspname NOT IN ('pg_catalog','information_schema')
    AND nspname !~ '^pg_(toast|temp_)'
), relations AS (
  SELECT c.*, n.nspname FROM pg_catalog.pg_class c
  JOIN namespaces n ON n.oid=c.relnamespace
), routines AS (
  SELECT p.*, n.nspname FROM pg_catalog.pg_proc p
  JOIN namespaces n ON n.oid=p.pronamespace
), triggers AS (
  -- PostgreSQL fires triggers in name order. Preserve that order separately
  -- when a generated name's physical suffix is represented by its owner.
  SELECT t.*, r.nspname, r.relname,
    row_number() OVER (PARTITION BY t.tgrelid ORDER BY t.tgname COLLATE "C") AS name_order,
    CASE WHEN t.tgisinternal AND c.contype='f'
      AND t.tgname IN ('RI_ConstraintTrigger_a_'||t.oid,'RI_ConstraintTrigger_c_'||t.oid)
      AND p.pronamespace='pg_catalog'::regnamespace
      AND p.proname IN ('RI_FKey_check_ins','RI_FKey_check_upd',
        'RI_FKey_noaction_del','RI_FKey_noaction_upd','RI_FKey_restrict_del','RI_FKey_restrict_upd',
        'RI_FKey_cascade_del','RI_FKey_cascade_upd','RI_FKey_setnull_del','RI_FKey_setnull_upd',
        'RI_FKey_setdefault_del','RI_FKey_setdefault_upd')
      AND starts_with(pg_catalog.pg_get_triggerdef(t.oid),format('CREATE CONSTRAINT TRIGGER %I ',t.tgname))
    THEN format('%s for %s using %s',
      left(t.tgname,length(t.tgname)-length(t.oid::text)),
      pg_catalog.pg_describe_object('pg_constraint'::regclass,c.oid,0),t.tgfoid::regprocedure)
    ELSE t.tgname::text END AS catalog_name
  FROM pg_catalog.pg_trigger t JOIN relations r ON r.oid=t.tgrelid
  LEFT JOIN pg_catalog.pg_constraint c ON c.oid=t.tgconstraint
  JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid
), generated_names AS (
  -- Only names proven to encode their own physical OID are represented by
  -- their owning catalog identity. Renames and all dependency edges survive.
  SELECT 'pg_trigger'::regclass AS classid,oid,
    format('trigger %I on table %I.%I',catalog_name,nspname,relname) AS description
  FROM triggers WHERE catalog_name<>tgname
  UNION ALL SELECT 'pg_class'::regclass,t.oid,
    format('toast table for %I.%I',r.nspname,r.relname)
  FROM relations r JOIN pg_catalog.pg_class t ON t.oid=r.reltoastrelid
  WHERE t.relkind='t' AND t.relnamespace='pg_toast'::regnamespace
    AND t.relname='pg_toast_'||r.oid
), acl_sources AS (
  SELECT 'database:'||datname AS identity, datdba AS owner, datacl AS acl
  FROM pg_catalog.pg_database WHERE datname=current_database()
  UNION ALL SELECT 'schema:'||nspname,nspowner,nspacl FROM namespaces
  UNION ALL SELECT 'relation:'||format('%I.%I',nspname,relname),relowner,relacl FROM relations
  UNION ALL SELECT 'column:'||format('%I.%I.%I',r.nspname,r.relname,a.attname),r.relowner,a.attacl
  FROM relations r JOIN pg_catalog.pg_attribute a ON a.attrelid=r.oid
  WHERE a.attnum>0 AND NOT a.attisdropped
  UNION ALL SELECT 'routine:'||format('%I.%I(%s)',nspname,proname,pg_catalog.pg_get_function_identity_arguments(oid)),proowner,proacl FROM routines
  UNION ALL SELECT 'type:'||format('%I.%I',n.nspname,t.typname),t.typowner,t.typacl
  FROM pg_catalog.pg_type t JOIN namespaces n ON n.oid=t.typnamespace
), application_objects AS (
  SELECT 'pg_class'::regclass AS classid,oid FROM relations
  UNION ALL SELECT 'pg_proc'::regclass,oid FROM routines
  UNION ALL SELECT 'pg_namespace'::regclass,oid FROM namespaces
  UNION ALL SELECT 'pg_type'::regclass,t.oid FROM pg_catalog.pg_type t
    JOIN namespaces n ON n.oid=t.typnamespace
  UNION ALL SELECT 'pg_trigger'::regclass,t.oid FROM pg_catalog.pg_trigger t
    JOIN relations r ON r.oid=t.tgrelid
  UNION ALL SELECT 'pg_constraint'::regclass,c.oid FROM pg_catalog.pg_constraint c
    JOIN namespaces n ON n.oid=c.connamespace
), facts AS (
  SELECT 'authority' AS family, a.inventory::jsonb AS fact FROM authority a
  -- Enum membership and comparison order are schema, even for unused types.
  -- Array siblings refer to this semantic identity; no physical enum/type OID
  -- or incidental gaps in enumsortorder enter the observation.
  UNION ALL SELECT 'enum',jsonb_build_object('identity',format('%I.%I',n.nspname,t.typname),
    'labels',COALESCE((SELECT jsonb_agg(e.enumlabel ORDER BY e.enumsortorder)
      FROM pg_catalog.pg_enum e WHERE e.enumtypid=t.oid),'[]'::jsonb))
  FROM pg_catalog.pg_type t JOIN namespaces n ON n.oid=t.typnamespace
  WHERE t.typtype='e'
  UNION ALL SELECT 'membership',jsonb_build_object(
    'role',r.rolname,'member',u.rolname,'grantor',g.rolname,
    'adminOption',m.admin_option,'inheritOption',m.inherit_option,'setOption',m.set_option)
  FROM pg_catalog.pg_auth_members m
  LEFT JOIN pg_catalog.pg_roles r ON r.oid=m.roleid
  LEFT JOIN pg_catalog.pg_roles u ON u.oid=m.member
  LEFT JOIN pg_catalog.pg_roles g ON g.oid=m.grantor
  UNION ALL SELECT 'acl',jsonb_build_object('identity',s.identity,'owner',owner.rolname,
    'entries',CASE WHEN s.acl IS NULL THEN NULL ELSE (SELECT COALESCE(jsonb_agg(
      jsonb_build_object('grantee',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE u.rolname END,
      'grantor',g.rolname,'privilege',a.privilege_type,'grantable',a.is_grantable)
      ORDER BY u.rolname COLLATE "C",g.rolname COLLATE "C",a.privilege_type COLLATE "C"),'[]'::jsonb)
      FROM pg_catalog.aclexplode(s.acl) a
      LEFT JOIN pg_catalog.pg_roles u ON u.oid=a.grantee
      LEFT JOIN pg_catalog.pg_roles g ON g.oid=a.grantor) END)
  FROM acl_sources s LEFT JOIN pg_catalog.pg_roles owner ON owner.oid=s.owner
  UNION ALL SELECT 'defaultAcl',jsonb_build_object('owner',owner.rolname,
    'schema',CASE WHEN d.defaclnamespace=0 THEN '*' ELSE n.nspname END,'type',d.defaclobjtype,
    'entries',CASE WHEN d.defaclacl IS NULL THEN NULL ELSE (SELECT COALESCE(jsonb_agg(
      jsonb_build_object('grantee',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE u.rolname END,
      'grantor',g.rolname,'privilege',a.privilege_type,'grantable',a.is_grantable)
      ORDER BY u.rolname COLLATE "C",g.rolname COLLATE "C",a.privilege_type COLLATE "C"),'[]'::jsonb)
      FROM pg_catalog.aclexplode(d.defaclacl) a
      LEFT JOIN pg_catalog.pg_roles u ON u.oid=a.grantee
      LEFT JOIN pg_catalog.pg_roles g ON g.oid=a.grantor) END)
  FROM pg_catalog.pg_default_acl d
  LEFT JOIN pg_catalog.pg_roles owner ON owner.oid=d.defaclrole
  LEFT JOIN pg_catalog.pg_namespace n ON n.oid=d.defaclnamespace
  UNION ALL SELECT 'roleSetting',jsonb_build_object('role',CASE WHEN s.setrole=0 THEN '*' ELSE r.rolname END,
    'database',CASE WHEN s.setdatabase=0 THEN '*' ELSE d.datname END,
    'digest',encode(sha256(convert_to(s.setconfig::text,'UTF8')),'hex'))
  FROM pg_catalog.pg_db_role_setting s
  LEFT JOIN pg_catalog.pg_roles r ON r.oid=s.setrole
  LEFT JOIN pg_catalog.pg_database d ON d.oid=s.setdatabase
  UNION ALL SELECT 'routine',jsonb_build_object(
    'identity',format('%I.%I(%s)',p.nspname,p.proname,pg_catalog.pg_get_function_identity_arguments(p.oid)),
    'owner',owner.rolname,'kind',p.prokind,'securityDefiner',p.prosecdef,
    'configurationDigest',CASE WHEN p.proconfig IS NULL THEN NULL ELSE
      encode(sha256(convert_to(p.proconfig::text,'UTF8')),'hex') END,
    'definitionDigest',CASE WHEN p.prokind IN ('f','p') THEN
      encode(sha256(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8')),'hex') ELSE NULL END)
  FROM routines p LEFT JOIN pg_catalog.pg_roles owner ON owner.oid=p.proowner
  UNION ALL SELECT 'relation',jsonb_build_object('identity',format('%I.%I',nspname,relname),
    'kind',relkind,'persistence',relpersistence,'replicaIdentity',relreplident,
    'options',reloptions,'partition',relispartition,'partitionBound',pg_catalog.pg_get_expr(relpartbound,oid))
  FROM relations
  UNION ALL SELECT 'column',jsonb_build_object('identity',format('%I.%I.%I',r.nspname,r.relname,a.attname),
    'position',a.attnum,'type',pg_catalog.format_type(a.atttypid,a.atttypmod),
    'notNull',a.attnotnull,'identityKind',a.attidentity,'generated',a.attgenerated,
    'default',pg_catalog.pg_get_expr(d.adbin,d.adrelid),'collation',a.attcollation::regcollation::text)
  FROM relations r JOIN pg_catalog.pg_attribute a ON a.attrelid=r.oid
  LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=r.oid AND d.adnum=a.attnum
  WHERE a.attnum>0 AND NOT a.attisdropped
  UNION ALL SELECT 'constraint',jsonb_build_object('identity',format('%I.%I.%I',r.nspname,r.relname,c.conname),
    'validated',c.convalidated,'definition',pg_catalog.pg_get_constraintdef(c.oid))
  FROM pg_catalog.pg_constraint c JOIN relations r ON r.oid=c.conrelid
  UNION ALL SELECT 'index',jsonb_build_object('identity',format('%I.%I',r.nspname,r.relname),
    'valid',i.indisvalid,'ready',i.indisready,'live',i.indislive,'definition',pg_catalog.pg_get_indexdef(i.indexrelid))
  FROM pg_catalog.pg_index i JOIN relations r ON r.oid=i.indexrelid
  UNION ALL SELECT 'trigger',jsonb_build_object('identity',format('%I.%I.%I',t.nspname,t.relname,t.catalog_name),
    'internal',t.tgisinternal,'generatedName',t.catalog_name<>t.tgname,'nameOrder',t.name_order,
    'enabled',t.tgenabled,'definition',CASE WHEN t.catalog_name<>t.tgname THEN
      format('CREATE CONSTRAINT TRIGGER %I',t.catalog_name)||substr(pg_catalog.pg_get_triggerdef(t.oid),
        length(format('CREATE CONSTRAINT TRIGGER %I',t.tgname))+1)
      ELSE pg_catalog.pg_get_triggerdef(t.oid) END)
  FROM triggers t
  UNION ALL SELECT 'dependency',jsonb_build_object('type',d.deptype,
    'object',COALESCE(obj.description,pg_catalog.pg_describe_object(d.classid,d.objid,d.objsubid)),
    'reference',COALESCE(ref.description,pg_catalog.pg_describe_object(d.refclassid,d.refobjid,d.refobjsubid)))
  FROM pg_catalog.pg_depend d
  LEFT JOIN generated_names obj ON obj.classid=d.classid AND obj.oid=d.objid AND d.objsubid=0
  LEFT JOIN generated_names ref ON ref.classid=d.refclassid AND ref.oid=d.refobjid AND d.refobjsubid=0
  -- Two independent membership tests can use hashed subplans. Combining both
  -- addresses inside one correlated OR rescans the object inventory per edge.
  -- Keep every matching pg_depend row, including multiplicity and either end.
  WHERE (d.classid,d.objid) IN (SELECT classid,oid FROM application_objects)
     OR (d.refclassid,d.refobjid) IN (SELECT classid,oid FROM application_objects)
)
SELECT jsonb_build_object('version',1,'serverVersionNum',current_setting('server_version_num')::integer,
  'database',current_database(),'sessionUser',session_user,'currentUser',current_user,
  'facts',COALESCE(jsonb_agg(jsonb_build_object('family',family,'fact',fact)
    ORDER BY family COLLATE "C",fact::text COLLATE "C"),'[]'::jsonb)) FROM facts;`;

// Pure comparison, not approval. Production callers must obtain expectations
// from readReviewedRenderManagedContract; no result of this function grants
// mutation authority or promotes an observed/fixture hash into a review root.
export function assertRenderManagedCatalogMatches(observed, reviewedDigest) {
  if (
    !observed ||
    observed.version !== 1 ||
    observed.serverVersionNum !== 170010 ||
    observed.sessionUser !== "reviewrouter" ||
    observed.currentUser !== "reviewrouter" ||
    typeof observed.database !== "string" ||
    !observed.database ||
    !Array.isArray(observed.facts) ||
    !/^sha256:[a-f0-9]{64}$/u.test(reviewedDigest)
  )
    throw new Error("render_managed_catalog_rejected:observation");
  const authorities = observed.facts.filter(
    (row) => row.family === "authority",
  );
  if (authorities.length !== 1)
    throw new Error("render_managed_catalog_rejected:authority");
  assertRenderManagedRoleBranch(authorities[0].fact?.roles);
  if (renderManagedEvidenceDigest(observed) !== reviewedDigest)
    throw new Error("render_managed_catalog_rejected:drift");
}
