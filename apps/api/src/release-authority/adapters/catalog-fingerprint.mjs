// One catalog serialization is used by the installer and runtime observer.
// It deliberately records complete object shape, routine source, triggers,
// ownership, and effective ACL rows instead of a hand-picked object list.
export const releaseAuthorityAclFingerprintSql = String.raw`CREATE OR REPLACE FUNCTION pg_temp.release_authority_acl_fingerprint(p_acl aclitem[])
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog AS $acl$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'grantor',CASE WHEN acl.grantor=0 THEN 'PUBLIC'
      ELSE pg_catalog.pg_get_userbyid(acl.grantor) END,
    'grantee',CASE WHEN acl.grantee=0 THEN 'PUBLIC'
      ELSE pg_catalog.pg_get_userbyid(acl.grantee) END,
    'privilege_type',acl.privilege_type,
    'is_grantable',acl.is_grantable
  ) ORDER BY
    CASE WHEN acl.grantor=0 THEN 'PUBLIC'
      ELSE pg_catalog.pg_get_userbyid(acl.grantor) END,
    CASE WHEN acl.grantee=0 THEN 'PUBLIC'
      ELSE pg_catalog.pg_get_userbyid(acl.grantee) END,
    acl.privilege_type,acl.is_grantable),'[]'::jsonb)
  FROM pg_catalog.aclexplode(CASE
    WHEN pg_catalog.cardinality(p_acl)>0 THEN p_acl
    ELSE NULL::aclitem[]
  END) acl
$acl$;`;

export const releaseAuthorityCatalogFunctionSql = String.raw`CREATE OR REPLACE FUNCTION pg_temp.release_authority_catalog_fingerprint(p_schema text)
RETURNS text LANGUAGE sql STABLE SET search_path = pg_catalog AS $fingerprint$
  WITH target AS (
    SELECT oid, nspowner, nspacl FROM pg_catalog.pg_namespace WHERE nspname=p_schema
  ), records(kind, identity, definition) AS (
    SELECT 'schema', p_schema,
      jsonb_build_object(
        'owner', pg_catalog.pg_get_userbyid(nspowner),
        'acl',pg_temp.release_authority_acl_fingerprint(
          coalesce(nspacl,pg_catalog.acldefault('n',nspowner))))
    FROM target
    UNION ALL
    SELECT 'relation', relation.relname,
      jsonb_build_object(
        'kind',relation.relkind,'persistence',relation.relpersistence,
        'owner',pg_catalog.pg_get_userbyid(relation.relowner),
        'replicaIdentity',relation.relreplident,'rowSecurity',relation.relrowsecurity,
        'forceRowSecurity',relation.relforcerowsecurity,
        'options',coalesce(to_jsonb(relation.reloptions),'[]'::jsonb),
        'accessMethod',coalesce(access_method.amname,''),
        'tablespace',CASE WHEN relation.reltablespace=0 THEN ''
          ELSE pg_catalog.pg_tablespace_location(relation.reltablespace) END,
        'acl',pg_temp.release_authority_acl_fingerprint(
          coalesce(relation.relacl,pg_catalog.acldefault(
            CASE WHEN relation.relkind='S' THEN 'S'::"char" ELSE 'r'::"char" END,
            relation.relowner))),
        'columns',(SELECT coalesce(jsonb_agg(jsonb_build_object(
          'position',attribute.attnum,'name',attribute.attname,
          'type',replace(pg_catalog.format_type(attribute.atttypid,attribute.atttypmod),p_schema,'release_authority'),
          'notNull',attribute.attnotnull,'identity',attribute.attidentity,
          'generated',attribute.attgenerated,'compression',attribute.attcompression,
          'collation',CASE WHEN attribute.attcollation=0 THEN ''
            ELSE attribute.attcollation::regcollation::text END,
          'storage',attribute.attstorage,'statistics',attribute.attstattarget,
          'default',replace(coalesce(pg_catalog.pg_get_expr(default_record.adbin,default_record.adrelid),''),p_schema,'release_authority')
          ,'acl',pg_temp.release_authority_acl_fingerprint(attribute.attacl)
        ) ORDER BY attribute.attnum),'[]'::jsonb)
          FROM pg_catalog.pg_attribute attribute
          LEFT JOIN pg_catalog.pg_attrdef default_record
            ON default_record.adrelid=attribute.attrelid AND default_record.adnum=attribute.attnum
          WHERE attribute.attrelid=relation.oid AND attribute.attnum>0 AND NOT attribute.attisdropped),
        'constraints',(SELECT coalesce(jsonb_agg(jsonb_build_array(constraint_record.conname,
          constraint_record.contype,constraint_record.condeferrable,constraint_record.condeferred,
          constraint_record.convalidated,replace(pg_catalog.pg_get_constraintdef(constraint_record.oid,true),p_schema,'release_authority'))
          ORDER BY constraint_record.conname),'[]'::jsonb)
          FROM pg_catalog.pg_constraint constraint_record WHERE constraint_record.conrelid=relation.oid),
        'indexes',(SELECT coalesce(jsonb_agg(replace(pg_catalog.pg_get_indexdef(index_record.indexrelid),p_schema,'release_authority')
          ORDER BY index_record.indexrelid::regclass::text),'[]'::jsonb)
          FROM pg_catalog.pg_index index_record WHERE index_record.indrelid=relation.oid),
        'sequence',(SELECT jsonb_build_array(sequence_record.seqtypid::regtype::text,
          sequence_record.seqstart,sequence_record.seqincrement,sequence_record.seqmax,
          sequence_record.seqmin,sequence_record.seqcache,sequence_record.seqcycle)
          FROM pg_catalog.pg_sequence sequence_record WHERE sequence_record.seqrelid=relation.oid)
      )
    FROM pg_catalog.pg_class relation JOIN target ON target.oid=relation.relnamespace
    LEFT JOIN pg_catalog.pg_am access_method ON access_method.oid=relation.relam
    UNION ALL
    SELECT 'function', procedure.oid::regprocedure::text,
      jsonb_build_object(
        'identityArgs',replace(pg_catalog.pg_get_function_identity_arguments(procedure.oid),p_schema,'release_authority'),
        'arguments',replace(pg_catalog.pg_get_function_arguments(procedure.oid),p_schema,'release_authority'),
        'result',replace(pg_catalog.pg_get_function_result(procedure.oid),p_schema,'release_authority'),
        'kind',procedure.prokind,'language',language.lanname,'volatility',procedure.provolatile,
        'strict',procedure.proisstrict,'securityDefiner',procedure.prosecdef,
        'leakproof',procedure.proleakproof,'parallel',procedure.proparallel,
        'cost',procedure.procost,'rows',procedure.prorows,
        'config',coalesce(to_jsonb(procedure.proconfig),'[]'::jsonb),
        'owner',pg_catalog.pg_get_userbyid(procedure.proowner),
        'source',replace(procedure.prosrc,p_schema,'release_authority'),
        'acl',pg_temp.release_authority_acl_fingerprint(
          coalesce(procedure.proacl,pg_catalog.acldefault('f',procedure.proowner)))
      )
    FROM pg_catalog.pg_proc procedure
    JOIN target ON target.oid=procedure.pronamespace
    JOIN pg_catalog.pg_language language ON language.oid=procedure.prolang
    UNION ALL
    SELECT 'trigger', relation.relname||'.'||trigger.tgname,
      jsonb_build_object('enabled',trigger.tgenabled,
        'definition',replace(pg_catalog.pg_get_triggerdef(trigger.oid,true),p_schema,'release_authority'))
    FROM pg_catalog.pg_trigger trigger
    JOIN pg_catalog.pg_class relation ON relation.oid=trigger.tgrelid
    JOIN target ON target.oid=relation.relnamespace WHERE NOT trigger.tgisinternal
    UNION ALL
    SELECT 'type', type_record.typname,
      jsonb_build_object(
        'kind',type_record.typtype,'category',type_record.typcategory,
        'owner',pg_catalog.pg_get_userbyid(type_record.typowner),
        'notNull',type_record.typnotnull,'byValue',type_record.typbyval,
        'alignment',type_record.typalign,'storage',type_record.typstorage,
        'base',replace(CASE WHEN type_record.typbasetype=0 THEN '' ELSE type_record.typbasetype::regtype::text END,p_schema,'release_authority'),
        'element',replace(CASE WHEN type_record.typelem=0 THEN '' ELSE type_record.typelem::regtype::text END,p_schema,'release_authority'),
        'default',coalesce(type_record.typdefault,''),
        'acl',pg_temp.release_authority_acl_fingerprint(
          coalesce(type_record.typacl,pg_catalog.acldefault('T',type_record.typowner))),
        'enum',(SELECT coalesce(jsonb_agg(enum_record.enumlabel ORDER BY enum_record.enumsortorder),'[]'::jsonb)
          FROM pg_catalog.pg_enum enum_record WHERE enum_record.enumtypid=type_record.oid)
      )
    FROM pg_catalog.pg_type type_record JOIN target ON target.oid=type_record.typnamespace
  )
  SELECT coalesce(jsonb_agg(jsonb_build_array(kind,
    replace(identity,p_schema,'release_authority'),definition)
    ORDER BY kind,replace(identity,p_schema,'release_authority')),'[]'::jsonb)::text
  FROM records
$fingerprint$;`;

export const releaseAuthorityCatalogFingerprintSql = String.raw`
${releaseAuthorityAclFingerprintSql}

${releaseAuthorityCatalogFunctionSql}`;

export const releaseAuthorityCatalogDigestExpression = (schema) =>
  `encode(pg_catalog.sha256(pg_catalog.convert_to(pg_temp.release_authority_catalog_fingerprint('${schema}'),'UTF8')),'hex')`;
