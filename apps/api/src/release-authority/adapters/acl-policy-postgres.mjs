import {
  releaseAuthorityDefaultAclPolicy,
  releaseAuthorityFinalAclPolicy,
} from "../domain/acl-policy.mjs";

const literal = (value) => `'${value.replaceAll("'", "''")}'`;
const textArray = (values) => `ARRAY[${values.map(literal).join(",")}]::text[]`;

const objectKindCodes = Object.freeze({
  tables: "r",
  sequences: "S",
  routines: "f",
  types: "T",
});

const defaultAclObjectCodes = releaseAuthorityDefaultAclPolicy.objectKinds.map(
  (kind) => objectKindCodes[kind],
);
const defaultAclObjectCodeArray = `ARRAY[${defaultAclObjectCodes
  .map((code) => `${literal(code)}::"char"`)
  .join(",")}]`;

export const releaseAuthorityDefaultAclRowsExpression = (schema) => {
  if (!/^[a-z][a-z0-9_]{0,62}$/u.test(schema))
    throw new Error("release_authority_acl_schema_invalid");
  return String.raw`(
    SELECT coalesce(jsonb_agg(jsonb_build_object(
      'owner',pg_catalog.pg_get_userbyid(default_acl.defaclrole),
      'scope',CASE WHEN default_acl.defaclnamespace=0 THEN 'global'
        ELSE namespace.nspname END,
      'object_type',default_acl.defaclobjtype,
      'acl',${aclRows("default_acl.defaclacl")}
    ) ORDER BY pg_catalog.pg_get_userbyid(default_acl.defaclrole),
      default_acl.defaclnamespace,default_acl.defaclobjtype),'[]'::jsonb)
    FROM pg_catalog.pg_default_acl default_acl
    LEFT JOIN pg_catalog.pg_namespace namespace
      ON namespace.oid=default_acl.defaclnamespace
    WHERE default_acl.defaclrole IN (
      SELECT owner_oid FROM (
        SELECT target.nspowner AS owner_oid
        FROM pg_catalog.pg_namespace target WHERE target.nspname='${schema}'
        UNION SELECT relation.relowner FROM pg_catalog.pg_class relation
          JOIN pg_catalog.pg_namespace target ON target.oid=relation.relnamespace
          WHERE target.nspname='${schema}'
        UNION SELECT procedure.proowner FROM pg_catalog.pg_proc procedure
          JOIN pg_catalog.pg_namespace target ON target.oid=procedure.pronamespace
          WHERE target.nspname='${schema}'
        UNION SELECT type_record.typowner FROM pg_catalog.pg_type type_record
          JOIN pg_catalog.pg_namespace target ON target.oid=type_record.typnamespace
          WHERE target.nspname='${schema}'
      ) relevant_owners
    )
    AND default_acl.defaclnamespace IN (
      0,coalesce(pg_catalog.to_regnamespace('${schema}')::oid,0))
    AND default_acl.defaclobjtype=ANY(${defaultAclObjectCodeArray})
  )`;
};

export const releaseAuthorityDefaultAclExactExpression = (schema) =>
  `${releaseAuthorityDefaultAclRowsExpression(schema)} = '[]'::jsonb`;

export const releaseAuthorityDefaultAclPreflightSql = (schema) => {
  if (!/^[a-z][a-z0-9_]{0,62}$/u.test(schema))
    throw new Error("release_authority_acl_schema_invalid");
  return String.raw`DO $default_acl_gate$
BEGIN
  IF EXISTS (
    WITH relevant_owners(owner_oid) AS (
      SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user
      UNION SELECT namespace.nspowner FROM pg_catalog.pg_namespace namespace
        WHERE namespace.nspname='${schema}'
      UNION SELECT relation.relowner FROM pg_catalog.pg_class relation
        WHERE relation.relnamespace=pg_catalog.to_regnamespace('${schema}')
      UNION SELECT procedure.proowner FROM pg_catalog.pg_proc procedure
        WHERE procedure.pronamespace=pg_catalog.to_regnamespace('${schema}')
      UNION SELECT type_record.typowner FROM pg_catalog.pg_type type_record
        WHERE type_record.typnamespace=pg_catalog.to_regnamespace('${schema}')
    )
    SELECT 1 FROM pg_catalog.pg_default_acl default_acl
    WHERE default_acl.defaclrole IN (SELECT owner_oid FROM relevant_owners)
      AND default_acl.defaclnamespace IN
        (0,coalesce(pg_catalog.to_regnamespace('${schema}')::oid,0))
      AND default_acl.defaclobjtype=ANY(${defaultAclObjectCodeArray})
  ) THEN
    RAISE EXCEPTION 'release authority creating owner default ACL is noncanonical';
  END IF;
END
$default_acl_gate$;`;
};

const aclRows = (expression) => String.raw`(
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'grantor',CASE WHEN acl.grantor=0 THEN 'PUBLIC'
      ELSE pg_catalog.pg_get_userbyid(acl.grantor) END,
    'grantee',CASE WHEN acl.grantee=0 THEN 'PUBLIC'
      ELSE pg_catalog.pg_get_userbyid(acl.grantee) END,
    'privilege_type',acl.privilege_type,
    'is_grantable',acl.is_grantable
  ) ORDER BY acl.grantor,acl.grantee,acl.privilege_type,acl.is_grantable),
    '[]'::jsonb)
  FROM pg_catalog.aclexplode(CASE WHEN pg_catalog.cardinality(${expression})>0
    THEN ${expression} ELSE NULL::aclitem[] END) acl
)`;

const executeRoleValues = Object.entries(
  releaseAuthorityFinalAclPolicy.routineExecuteRoles,
).flatMap(([role, routines]) =>
  routines.map((routine) => `(${literal(routine)},${literal(role)})`),
);

/** PostgreSQL-adapter fact shared by runtime readiness and runtime ACL gates. */
export const releaseAuthorityProviderTerminalTopologyExactExpression = () =>
  String.raw`coalesce(
    reviewrouter_migration_credential.provider_terminal_topology_is_exact(),
    false)`;

export const releaseAuthorityRuntimeAclExactExpression = (schema) =>
  `(${releaseAuthorityFinalAclExactExpression(schema)}) AND (${releaseAuthorityProviderTerminalTopologyExactExpression()})`;

export const releaseAuthorityFinalAclExactExpression = (schema) => {
  if (!/^[a-z][a-z0-9_]{0,62}$/u.test(schema))
    throw new Error("release_authority_acl_schema_invalid");
  const relations = textArray(releaseAuthorityFinalAclPolicy.relations);
  const sequences = textArray(releaseAuthorityFinalAclPolicy.sequences);
  const relationOwnerPrivileges = textArray(
    releaseAuthorityFinalAclPolicy.relationOwnerPrivileges,
  );
  const sequenceOwnerPrivileges = textArray(
    releaseAuthorityFinalAclPolicy.sequenceOwnerPrivileges,
  );
  const schemaOwnerPrivileges = textArray(
    releaseAuthorityFinalAclPolicy.schema.ownerPrivileges,
  );
  const schemaUsagePrivileges = textArray(
    releaseAuthorityFinalAclPolicy.schema.usagePrivileges,
  );
  const routineOwnerPrivileges = textArray(
    releaseAuthorityFinalAclPolicy.routineOwnerPrivileges,
  );
  const routineExecutePrivileges = textArray(
    releaseAuthorityFinalAclPolicy.routineExecutePrivileges,
  );
  const typeOwnerPrivileges = textArray(
    releaseAuthorityFinalAclPolicy.typeOwnerPrivileges,
  );
  const routines = textArray(releaseAuthorityFinalAclPolicy.routines);
  const schemaRoles = textArray(
    releaseAuthorityFinalAclPolicy.schema.usageRoles,
  );
  const executeRoles = executeRoleValues.join(",\n        ");
  return String.raw`coalesce((
    WITH target AS (
      SELECT oid,nspowner,nspacl,
        CASE WHEN pg_catalog.pg_input_is_valid(pg_catalog.obj_description(
            pg_catalog.to_regnamespace('reviewrouter_migration_credential'),
            'pg_namespace'),'jsonb')
          THEN pg_catalog.obj_description(
            pg_catalog.to_regnamespace('reviewrouter_migration_credential'),
            'pg_namespace')::jsonb->>'brokerGrantorRole'
          ELSE NULL END AS broker_grantor_role,
        (SELECT root_oid FROM reviewrouter_migration_credential.provider_root_pin
          WHERE singleton) AS provider_root_oid
      FROM pg_catalog.pg_namespace
      WHERE nspname='${schema}'
    ), expected_execute(routine_name,role_name) AS (VALUES
        ${executeRoles}
    )
    SELECT
      (SELECT count(*)=cardinality(${schemaOwnerPrivileges})
            +cardinality(${schemaRoles})*cardinality(${schemaUsagePrivileges})
          AND bool_and(
          acl.grantor=target.nspowner AND (
            acl.grantee=target.nspowner
              AND acl.privilege_type=ANY(${schemaOwnerPrivileges})
              AND NOT acl.is_grantable
            OR NOT acl.is_grantable
              AND acl.privilege_type=ANY(${schemaUsagePrivileges})
              AND EXISTS (SELECT 1 FROM pg_catalog.pg_roles role
                WHERE role.oid=acl.grantee AND role.rolname=ANY(${schemaRoles}))))
        FROM target CROSS JOIN LATERAL pg_catalog.aclexplode(
          coalesce(target.nspacl,pg_catalog.acldefault('n',target.nspowner))) acl)
      AND (SELECT count(*)=cardinality(${relations}) AND bool_and(
        relation.relname=ANY(${relations}) AND relation.relkind='r'
        AND relation.relowner=target.nspowner
        AND NOT EXISTS (
          SELECT 1 FROM pg_catalog.aclexplode(
            coalesce(relation.relacl,pg_catalog.acldefault('r',relation.relowner))) acl
          WHERE acl.grantor<>target.nspowner OR acl.grantee<>target.nspowner
            OR acl.privilege_type<>ALL(${relationOwnerPrivileges})
            OR acl.is_grantable)
        AND (SELECT count(*) FROM pg_catalog.aclexplode(
          coalesce(relation.relacl,pg_catalog.acldefault('r',relation.relowner))))
            =cardinality(${relationOwnerPrivileges}))
        FROM pg_catalog.pg_class relation CROSS JOIN target
        WHERE relation.relnamespace=target.oid AND relation.relkind IN ('r','p','v','m','f'))
      AND (SELECT count(*)=cardinality(${sequences}) AND bool_and(
        sequence.relname=ANY(${sequences}) AND sequence.relowner=target.nspowner
        AND NOT EXISTS (
          SELECT 1 FROM pg_catalog.aclexplode(
            coalesce(sequence.relacl,pg_catalog.acldefault('S',sequence.relowner))) acl
          WHERE acl.grantor<>target.nspowner OR acl.grantee<>target.nspowner
            OR acl.privilege_type<>ALL(${sequenceOwnerPrivileges})
            OR acl.is_grantable)
        AND (SELECT count(*) FROM pg_catalog.aclexplode(
          coalesce(sequence.relacl,pg_catalog.acldefault('S',sequence.relowner))))
            =cardinality(${sequenceOwnerPrivileges}))
        FROM pg_catalog.pg_class sequence CROSS JOIN target
        WHERE sequence.relnamespace=target.oid AND sequence.relkind='S')
      AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_class relation CROSS JOIN target
        WHERE relation.relnamespace=target.oid AND relation.relacl IS NOT NULL
          AND NOT (relation.relname=ANY(${relations})
            OR relation.relname=ANY(${sequences})))
      AND (SELECT count(*)=cardinality(${routines}) AND bool_and(
        procedure.proname=ANY(${routines}) AND procedure.proowner=target.nspowner
        AND NOT EXISTS (
          SELECT 1 FROM pg_catalog.aclexplode(
            coalesce(procedure.proacl,pg_catalog.acldefault('f',procedure.proowner))) acl
          LEFT JOIN pg_catalog.pg_roles grantee ON grantee.oid=acl.grantee
          WHERE acl.grantor<>target.nspowner
            OR acl.privilege_type<>ALL(${routineOwnerPrivileges})
            OR (acl.grantee=target.nspowner AND acl.is_grantable)
            OR (acl.grantee<>target.nspowner AND (acl.is_grantable OR NOT EXISTS (
              SELECT 1 FROM expected_execute expected
              WHERE expected.routine_name=procedure.proname
                AND expected.role_name=grantee.rolname)))
        )
        AND (SELECT count(*) FROM pg_catalog.aclexplode(
          coalesce(procedure.proacl,pg_catalog.acldefault('f',procedure.proowner))))
          = 1+(SELECT count(*) FROM expected_execute expected
            WHERE expected.routine_name=procedure.proname))
        FROM pg_catalog.pg_proc procedure CROSS JOIN target
        WHERE procedure.pronamespace=target.oid)
      AND NOT EXISTS (
        SELECT 1 FROM expected_execute expected
        WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc procedure
          CROSS JOIN target JOIN pg_catalog.pg_roles role
            ON role.rolname=expected.role_name
          WHERE procedure.pronamespace=target.oid
            AND procedure.proname=expected.routine_name
            AND EXISTS (SELECT 1 FROM unnest(${routineExecutePrivileges}) privilege
              WHERE pg_catalog.has_function_privilege(
                role.oid,procedure.oid,privilege))))
      AND EXISTS (
        SELECT 1 FROM pg_catalog.pg_auth_members membership
        JOIN pg_catalog.pg_roles granted ON granted.oid=membership.roleid
        JOIN pg_catalog.pg_roles member ON member.oid=membership.member
        JOIN pg_catalog.pg_roles grantor ON grantor.oid=membership.grantor
        CROSS JOIN target
        WHERE membership.roleid=target.nspowner
          AND granted.rolname='reviewrouter_authority_owner'
          AND member.rolname='reviewrouter_migration_broker'
          AND grantor.rolname=target.broker_grantor_role
          AND membership.admin_option
          AND NOT membership.inherit_option
          AND NOT membership.set_option)
      AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_auth_members membership
        JOIN pg_catalog.pg_roles granted ON granted.oid=membership.roleid
        JOIN pg_catalog.pg_roles member ON member.oid=membership.member
        JOIN pg_catalog.pg_roles grantor ON grantor.oid=membership.grantor
        CROSS JOIN target
        WHERE (membership.roleid=target.nspowner
          OR membership.member=target.nspowner
          OR granted.rolname=ANY(${schemaRoles})
          OR member.rolname=ANY(${schemaRoles}))
          AND NOT (
            membership.roleid=target.nspowner
            AND granted.rolname='reviewrouter_authority_owner'
            AND member.rolname='reviewrouter_migration_broker'
            AND grantor.rolname=target.broker_grantor_role
            AND membership.admin_option
            AND NOT membership.inherit_option
            AND NOT membership.set_option)
          AND NOT (
            granted.rolname IN ('reviewrouter_authority_owner',
              'reviewrouter_migration_broker')
            AND member.rolname='reviewrouter_bootstrap_administrator'
            AND grantor.oid=target.provider_root_oid
            AND membership.admin_option
            AND NOT membership.inherit_option
            AND NOT membership.set_option)
          AND NOT (
            membership.roleid=target.nspowner
            AND member.rolname=session_user
            AND grantor.rolname='reviewrouter_migration_broker'
            AND NOT membership.admin_option
            AND NOT membership.inherit_option
            AND membership.set_option
            AND reviewrouter_migration_credential.membership_is_active(
              member.rolname,granted.rolname)))
      AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_attribute attribute
        JOIN pg_catalog.pg_class relation ON relation.oid=attribute.attrelid
        CROSS JOIN target WHERE relation.relnamespace=target.oid
          AND attribute.attnum>0 AND NOT attribute.attisdropped
          AND attribute.attacl IS NOT NULL)
      AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_type type_record CROSS JOIN target
        WHERE type_record.typnamespace=target.oid
          AND type_record.typowner<>target.nspowner)
      AND (SELECT count(*)=cardinality(${textArray(releaseAuthorityFinalAclPolicy.declaredTypes)})
          AND bool_and(type_record.typname=ANY(${textArray(releaseAuthorityFinalAclPolicy.declaredTypes)})
            AND (SELECT count(*)=cardinality(${typeOwnerPrivileges})
              AND bool_and(acl.grantor=target.nspowner
              AND acl.grantee=target.nspowner
              AND acl.privilege_type=ANY(${typeOwnerPrivileges})
              AND NOT acl.is_grantable)
              FROM pg_catalog.aclexplode(type_record.typacl) acl))
        FROM pg_catalog.pg_type type_record CROSS JOIN target
        WHERE type_record.typnamespace=target.oid AND type_record.typacl IS NOT NULL)
  ),false)`;
};
