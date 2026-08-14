/** Canonical PostgreSQL projection for the effective-principal domain contract. */
export const effectivePrincipalInventorySql = `WITH
roles AS (
  SELECT rolname AS name, rolcanlogin AS "canLogin", rolinherit AS inherit,
    rolsuper AS superuser, rolbypassrls AS "bypassRls",
    rolreplication AS replication, rolcreatedb AS "createDatabase",
    rolcreaterole AS "createRole", rolconnlimit AS "connectionLimit",
    CASE WHEN rolvaliduntil IS NULL THEN NULL
      WHEN rolvaliduntil='infinity'::timestamptz THEN 'infinity'
      ELSE to_char(rolvaliduntil AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    END AS "validUntil", oid
  FROM pg_catalog.pg_roles
), memberships AS (
  SELECT member.rolname AS member, parent.rolname AS role,
    membership.set_option AS "setOption",
    membership.inherit_option AS "inheritOption"
    , membership.admin_option AS "adminOption", grantor.rolname AS grantor
  FROM pg_catalog.pg_auth_members membership
  JOIN pg_catalog.pg_roles member ON member.oid=membership.member
  JOIN pg_catalog.pg_roles parent ON parent.oid=membership.roleid
  JOIN pg_catalog.pg_roles grantor ON grantor.oid=membership.grantor
), objects AS (
  SELECT relation.oid, namespace.nspname AS schema_name, relation.relname AS object_name,
    relation.relkind, relation.relowner
  FROM pg_catalog.pg_class relation
  JOIN pg_catalog.pg_namespace namespace ON namespace.oid=relation.relnamespace
  WHERE namespace.nspname NOT IN ('pg_catalog','information_schema')
    AND namespace.nspname !~ '^pg_toast'
), grants(principal, capability, resource, source, grantable, grantor) AS (
  SELECT role.name, capability, resource, 'attribute', true, role.name
  FROM roles role CROSS JOIN LATERAL (VALUES
    ('admin:superuser',role.superuser), ('admin:bypassrls',role."bypassRls"),
    ('admin:replication',role.replication), ('admin:createdb',role."createDatabase"),
    ('admin:createrole',role."createRole")
  ) attribute(capability, enabled)
  CROSS JOIN LATERAL (VALUES ('cluster')) target(resource)
  WHERE enabled
  UNION ALL
  SELECT membership.member, 'admin:role-membership', 'role:'||membership.role,
    'attribute', true, membership.grantor
  FROM memberships membership WHERE membership."adminOption"
  UNION ALL
  SELECT pg_get_userbyid(database.datdba), 'owner:database', 'database:'||database.datname,
    'ownership', true, pg_get_userbyid(database.datdba)
  FROM pg_catalog.pg_database database WHERE database.datname=current_database()
  UNION ALL
  SELECT pg_get_userbyid(namespace.nspowner), 'owner:schema', 'schema:'||namespace.nspname,
    'ownership', true, pg_get_userbyid(namespace.nspowner)
  FROM pg_catalog.pg_namespace namespace
  WHERE namespace.nspname NOT IN ('pg_catalog','information_schema') AND namespace.nspname !~ '^pg_toast'
  UNION ALL
  SELECT pg_get_userbyid(object.relowner), 'owner:object',
    CASE WHEN object.relkind='S' THEN 'sequence:' ELSE 'relation:' END||
      quote_ident(object.schema_name)||'.'||quote_ident(object.object_name),
    'ownership', true, pg_get_userbyid(object.relowner)
  FROM objects object
  UNION ALL
  SELECT pg_get_userbyid(routine.proowner), 'owner:object',
    'routine:'||routine.oid::regprocedure::text, 'ownership', true,
    pg_get_userbyid(routine.proowner)
  FROM pg_catalog.pg_proc routine JOIN pg_catalog.pg_namespace namespace ON namespace.oid=routine.pronamespace
  WHERE namespace.nspname NOT IN ('pg_catalog','information_schema') AND namespace.nspname !~ '^pg_toast'
  UNION ALL
  SELECT pg_get_userbyid(type.typowner), 'owner:object',
    'type:'||quote_ident(namespace.nspname)||'.'||quote_ident(type.typname),
    'ownership', true, pg_get_userbyid(type.typowner)
  FROM pg_catalog.pg_type type JOIN pg_catalog.pg_namespace namespace ON namespace.oid=type.typnamespace
  WHERE namespace.nspname NOT IN ('pg_catalog','information_schema') AND namespace.nspname !~ '^pg_toast'
    AND type.typtype IN ('d','e','m','r','c')
  UNION ALL
  SELECT coalesce(grantee.rolname,'PUBLIC'),
    CASE acl.privilege_type WHEN 'CONNECT' THEN 'database:connect'
      WHEN 'CREATE' THEN 'database:create' WHEN 'TEMPORARY' THEN 'database:temporary' END,
    'database:'||database.datname, CASE WHEN acl.grantee=0 THEN 'public' ELSE 'privilege' END,
    acl.is_grantable, pg_get_userbyid(acl.grantor)
  FROM pg_catalog.pg_database database
  CROSS JOIN LATERAL aclexplode(coalesce(database.datacl,acldefault('d',database.datdba))) acl
  LEFT JOIN pg_catalog.pg_roles grantee ON grantee.oid=acl.grantee
  WHERE database.datname=current_database()
  UNION ALL
  SELECT coalesce(grantee.rolname,'PUBLIC'),
    CASE acl.privilege_type WHEN 'CREATE' THEN 'schema:create' ELSE 'schema:usage' END,
    'schema:'||namespace.nspname, CASE WHEN acl.grantee=0 THEN 'public' ELSE 'privilege' END,
    acl.is_grantable, pg_get_userbyid(acl.grantor)
  FROM pg_catalog.pg_namespace namespace
  CROSS JOIN LATERAL aclexplode(coalesce(namespace.nspacl,acldefault('n',namespace.nspowner))) acl
  LEFT JOIN pg_catalog.pg_roles grantee ON grantee.oid=acl.grantee
  WHERE namespace.nspname NOT IN ('pg_catalog','information_schema') AND namespace.nspname !~ '^pg_toast'
  UNION ALL
  SELECT coalesce(grantee.rolname,'PUBLIC'),
    CASE defaults.defaclobjtype
      WHEN 'r' THEN CASE acl.privilege_type WHEN 'INSERT' THEN 'table:insert'
        WHEN 'UPDATE' THEN 'table:update' WHEN 'DELETE' THEN 'table:delete'
        WHEN 'TRUNCATE' THEN 'table:truncate' WHEN 'TRIGGER' THEN 'table:trigger'
        WHEN 'REFERENCES' THEN 'table:references' ELSE 'table:read' END
      WHEN 'S' THEN CASE acl.privilege_type WHEN 'USAGE' THEN 'sequence:usage'
        WHEN 'UPDATE' THEN 'sequence:update' ELSE 'sequence:read' END
      WHEN 'f' THEN 'routine:execute'
      WHEN 'n' THEN CASE acl.privilege_type WHEN 'CREATE' THEN 'schema:create' ELSE 'schema:usage' END
      WHEN 'T' THEN 'type:usage'
    END,
    'default:'||pg_get_userbyid(defaults.defaclrole)||':'||
      defaults.defaclobjtype||':'||coalesce(namespace.nspname,'*'),
    CASE WHEN acl.grantee=0 THEN 'public' ELSE 'privilege' END,
    acl.is_grantable, pg_get_userbyid(acl.grantor)
  FROM pg_catalog.pg_default_acl defaults
  CROSS JOIN LATERAL aclexplode(defaults.defaclacl) acl
  LEFT JOIN pg_catalog.pg_roles grantee ON grantee.oid=acl.grantee
  LEFT JOIN pg_catalog.pg_namespace namespace ON namespace.oid=defaults.defaclnamespace
  UNION ALL
  SELECT coalesce(grantee.rolname,'PUBLIC'), 'type:usage',
    'type:'||quote_ident(namespace.nspname)||'.'||quote_ident(type.typname),
    CASE WHEN acl.grantee=0 THEN 'public' ELSE 'privilege' END,
    acl.is_grantable, pg_get_userbyid(acl.grantor)
  FROM pg_catalog.pg_type type JOIN pg_catalog.pg_namespace namespace ON namespace.oid=type.typnamespace
  CROSS JOIN LATERAL aclexplode(coalesce(type.typacl,acldefault('T',type.typowner))) acl
  LEFT JOIN pg_catalog.pg_roles grantee ON grantee.oid=acl.grantee
  WHERE namespace.nspname NOT IN ('pg_catalog','information_schema') AND namespace.nspname !~ '^pg_toast'
    AND type.typtype IN ('d','e','m','r','c')
  UNION ALL
  SELECT coalesce(grantee.rolname,'PUBLIC'),
    CASE acl.privilege_type WHEN 'INSERT' THEN 'table:insert' WHEN 'UPDATE' THEN 'table:update'
      WHEN 'DELETE' THEN 'table:delete' WHEN 'TRUNCATE' THEN 'table:truncate'
      WHEN 'TRIGGER' THEN 'table:trigger' WHEN 'REFERENCES' THEN 'table:references'
      ELSE 'table:read' END,
    'relation:'||quote_ident(object.schema_name)||'.'||quote_ident(object.object_name),
    CASE WHEN acl.grantee=0 THEN 'public' ELSE 'privilege' END,
    acl.is_grantable, pg_get_userbyid(acl.grantor)
  FROM objects object
  CROSS JOIN LATERAL aclexplode(coalesce((SELECT relacl FROM pg_catalog.pg_class WHERE oid=object.oid),acldefault('r',object.relowner))) acl
  LEFT JOIN pg_catalog.pg_roles grantee ON grantee.oid=acl.grantee
  WHERE object.relkind IN ('r','p','v','m','f')
  UNION ALL
  SELECT coalesce(grantee.rolname,'PUBLIC'),
    CASE acl.privilege_type WHEN 'INSERT' THEN 'column:insert' WHEN 'UPDATE' THEN 'column:update'
      WHEN 'REFERENCES' THEN 'column:references' ELSE 'column:read' END,
    'column:'||quote_ident(namespace.nspname)||'.'||quote_ident(relation.relname)||'.'||quote_ident(attribute.attname),
    CASE WHEN acl.grantee=0 THEN 'public' ELSE 'privilege' END,
    acl.is_grantable, pg_get_userbyid(acl.grantor)
  FROM pg_catalog.pg_attribute attribute
  JOIN pg_catalog.pg_class relation ON relation.oid=attribute.attrelid
  JOIN pg_catalog.pg_namespace namespace ON namespace.oid=relation.relnamespace
  CROSS JOIN LATERAL aclexplode(attribute.attacl) acl
  LEFT JOIN pg_catalog.pg_roles grantee ON grantee.oid=acl.grantee
  WHERE attribute.attnum>0 AND NOT attribute.attisdropped
    AND namespace.nspname NOT IN ('pg_catalog','information_schema') AND namespace.nspname !~ '^pg_toast'
  UNION ALL
  SELECT coalesce(grantee.rolname,'PUBLIC'),
    CASE acl.privilege_type WHEN 'USAGE' THEN 'sequence:usage' WHEN 'UPDATE' THEN 'sequence:update' ELSE 'sequence:read' END,
    'sequence:'||quote_ident(object.schema_name)||'.'||quote_ident(object.object_name),
    CASE WHEN acl.grantee=0 THEN 'public' ELSE 'privilege' END,
    acl.is_grantable, pg_get_userbyid(acl.grantor)
  FROM objects object JOIN pg_catalog.pg_class sequence ON sequence.oid=object.oid
  CROSS JOIN LATERAL aclexplode(coalesce(sequence.relacl,acldefault('S',sequence.relowner))) acl
  LEFT JOIN pg_catalog.pg_roles grantee ON grantee.oid=acl.grantee WHERE object.relkind='S'
  UNION ALL
  SELECT coalesce(grantee.rolname,'PUBLIC'), 'routine:execute',
    'routine:'||routine.oid::regprocedure::text,
    CASE WHEN acl.grantee=0 THEN 'public' ELSE 'privilege' END,
    acl.is_grantable, pg_get_userbyid(acl.grantor)
  FROM pg_catalog.pg_proc routine JOIN pg_catalog.pg_namespace namespace ON namespace.oid=routine.pronamespace
  CROSS JOIN LATERAL aclexplode(coalesce(routine.proacl,acldefault('f',routine.proowner))) acl
  LEFT JOIN pg_catalog.pg_roles grantee ON grantee.oid=acl.grantee
  WHERE namespace.nspname NOT IN ('pg_catalog','information_schema') AND namespace.nspname !~ '^pg_toast'
)
SELECT json_build_object('version',1,'database',current_database(),
  'sessionPrincipal',session_user,
  'roles',(SELECT coalesce(json_agg(to_jsonb(roles)-'oid' ORDER BY name),'[]'::json) FROM roles),
  'memberships',(SELECT coalesce(json_agg(memberships ORDER BY member,role),'[]'::json) FROM memberships),
  'roleReachability',(SELECT coalesce(json_agg(json_build_object(
    'principal',principal.name,'role',effective.name,
    'usage',principal.oid=effective.oid OR pg_has_role(principal.oid,effective.oid,'USAGE'),
    'set',principal.oid=effective.oid OR pg_has_role(principal.oid,effective.oid,'SET'))
    ORDER BY principal.name,effective.name),'[]'::json)
    FROM roles principal CROSS JOIN roles effective
    WHERE principal."canLogin" AND (principal.oid=effective.oid
      OR pg_has_role(principal.oid,effective.oid,'USAGE')
      OR pg_has_role(principal.oid,effective.oid,'SET'))),
  'rowSecurity',(SELECT coalesce(json_agg(json_build_object(
    'relation',quote_ident(namespace.nspname)||'.'||quote_ident(relation.relname),
    'owner',pg_get_userbyid(relation.relowner),'enabled',relation.relrowsecurity,
    'forced',relation.relforcerowsecurity,'policies',(SELECT coalesce(json_agg(
      json_build_object('name',policy.polname,'command',policy.polcmd,
        'permissive',policy.polpermissive,'roles',(SELECT coalesce(json_agg(
          CASE WHEN policy_role=0 THEN 'PUBLIC' ELSE pg_get_userbyid(policy_role) END
          ORDER BY CASE WHEN policy_role=0 THEN 'PUBLIC' ELSE pg_get_userbyid(policy_role) END),
          '[]'::json) FROM unnest(policy.polroles) policy_role))
      ORDER BY policy.polname),'[]'::json) FROM pg_policy policy
      WHERE policy.polrelid=relation.oid)) ORDER BY namespace.nspname,relation.relname),
      '[]'::json) FROM pg_class relation JOIN pg_namespace namespace
      ON namespace.oid=relation.relnamespace WHERE relation.relkind IN ('r','p')
        AND namespace.nspname NOT IN ('pg_catalog','information_schema')
        AND namespace.nspname !~ '^pg_toast'),
  'grants',(SELECT coalesce(json_agg(json_build_object('principal',principal,'capability',capability,
    'resource',resource,'source',source,'grantable',grantable,'grantor',grantor)
    ORDER BY principal,capability,resource,source,grantable,grantor),'[]'::json)
    FROM grants WHERE capability IS NOT NULL))`;
