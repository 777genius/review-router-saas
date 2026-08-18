BEGIN;

-- This is the only transition that uses the original database-owner login.
-- It moves authority ownership to a NOLOGIN role and installs a NOLOGIN
-- credential broker. Future migrations receive a short-lived login whose
-- owner membership is granted only after an atomic database-side consume.
DO $bootstrap_roles$
DECLARE bootstrap_role name := current_user;
DECLARE target_database name := current_database();
DECLARE provider_root_oid oid;
DECLARE provider_root_name name;
DECLARE provider_oid oid;
BEGIN
  IF session_user IS DISTINCT FROM current_user THEN
    RAISE EXCEPTION 'migration credential bootstrap requires a direct owner session';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles role
                  JOIN pg_catalog.pg_database database
                    ON database.datname=target_database AND database.datdba=role.oid
                  WHERE role.rolname=current_user AND role.rolcanlogin
                    AND role.rolcreaterole AND NOT role.rolsuper
                    AND NOT role.rolcreatedb AND NOT role.rolreplication
                    AND NOT role.rolbypassrls AND role.rolconnlimit=1
                    AND (role.rolvaliduntil IS NULL
                      OR role.rolvaliduntil='infinity'::timestamptz)
                    AND coalesce(array_length(role.rolconfig,1),0)=0) THEN
    RAISE EXCEPTION 'migration credential bootstrap role is noncanonical';
  END IF;
  IF (EXISTS (SELECT 1 FROM pg_catalog.pg_roles
       WHERE rolname='reviewrouter_authority_owner')) IS DISTINCT FROM
     (EXISTS (SELECT 1 FROM pg_catalog.pg_roles
       WHERE rolname='reviewrouter_migration_broker'))
  THEN RAISE EXCEPTION 'migration credential global role set is partial'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles
                  WHERE rolname='reviewrouter_authority_owner') THEN
    RAISE EXCEPTION 'migration credential authority roles must be provisioned before bootstrap';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles role
      WHERE role.rolname='reviewrouter_authority_owner' AND NOT role.rolcanlogin
        AND NOT role.rolsuper AND NOT role.rolcreatedb AND NOT role.rolcreaterole
        AND NOT role.rolreplication AND NOT role.rolbypassrls
        AND role.rolconnlimit=(-1) AND role.rolvaliduntil IS NULL
        AND coalesce(array_length(role.rolconfig,1),0)=0)
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles role
      WHERE role.rolname='reviewrouter_migration_broker' AND NOT role.rolcanlogin
        AND NOT role.rolsuper AND NOT role.rolcreatedb AND role.rolcreaterole
        AND NOT role.rolreplication AND NOT role.rolbypassrls
        AND role.rolconnlimit=(-1) AND role.rolvaliduntil IS NULL
        AND coalesce(array_length(role.rolconfig,1),0)=0)
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_shdepend dependency
      JOIN pg_catalog.pg_roles role ON role.oid=dependency.refobjid
      WHERE role.rolname IN ('reviewrouter_authority_owner',
          'reviewrouter_migration_broker') AND dependency.deptype='o')
  THEN RAISE EXCEPTION 'migration credential authority roles are noncanonical'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members membership
      JOIN pg_catalog.pg_roles granted ON granted.oid=membership.roleid
      JOIN pg_catalog.pg_roles member ON member.oid=membership.member
      JOIN pg_catalog.pg_roles grantor ON grantor.oid=membership.grantor
      WHERE granted.rolname='reviewrouter_authority_owner'
        AND member.rolname=bootstrap_role
        AND grantor.oid IN (SELECT stable.grantor
          FROM pg_catalog.pg_auth_members stable
          WHERE stable.roleid='reviewrouter_authority_owner'::pg_catalog.regrole
            AND stable.member='reviewrouter_migration_broker'::pg_catalog.regrole
            AND stable.admin_option AND NOT stable.inherit_option
            AND NOT stable.set_option)
        AND NOT membership.admin_option AND membership.inherit_option
        AND membership.set_option)
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members membership
      JOIN pg_catalog.pg_roles granted ON granted.oid=membership.roleid
      JOIN pg_catalog.pg_roles member ON member.oid=membership.member
      JOIN pg_catalog.pg_roles grantor ON grantor.oid=membership.grantor
      WHERE granted.rolname='reviewrouter_migration_broker'
        AND member.rolname=bootstrap_role
        AND grantor.oid IN (SELECT stable.grantor
          FROM pg_catalog.pg_auth_members stable
          WHERE stable.roleid='reviewrouter_authority_owner'::pg_catalog.regrole
            AND stable.member='reviewrouter_migration_broker'::pg_catalog.regrole
            AND stable.admin_option AND NOT stable.inherit_option
            AND NOT stable.set_option)
        AND NOT membership.admin_option AND NOT membership.inherit_option
        AND membership.set_option)
  THEN RAISE EXCEPTION 'migration credential bootstrap administration is noncanonical'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members membership
      JOIN pg_catalog.pg_roles granted ON granted.oid=membership.roleid
      JOIN pg_catalog.pg_roles member ON member.oid=membership.member
      JOIN pg_catalog.pg_roles grantor ON grantor.oid=membership.grantor
      WHERE granted.rolname='reviewrouter_authority_owner'
        AND member.rolname='reviewrouter_migration_broker'
        AND grantor.rolname='reviewrouter_bootstrap_administrator'
        AND membership.admin_option AND NOT membership.inherit_option
        AND NOT membership.set_option)
  THEN
    RAISE EXCEPTION 'migration credential broker authority is not provisioned by P';
  END IF;
  SELECT provider.oid,membership.grantor,grantor.rolname
    INTO STRICT provider_oid,provider_root_oid,provider_root_name
  FROM pg_catalog.pg_auth_members membership
  JOIN pg_catalog.pg_roles granted ON granted.oid=membership.roleid
  JOIN pg_catalog.pg_roles provider ON provider.oid=membership.member
  JOIN pg_catalog.pg_roles grantor ON grantor.oid=membership.grantor
  WHERE granted.rolname=bootstrap_role
    AND provider.rolname='reviewrouter_bootstrap_administrator'
    AND membership.admin_option AND NOT membership.inherit_option
    AND NOT membership.set_option
    AND grantor.oid<>provider.oid
    AND grantor.rolname NOT IN (bootstrap_role,'reviewrouter_authority_owner',
      'reviewrouter_migration_broker','reviewrouter_migration_issuer');
  IF (SELECT count(*) FROM pg_catalog.pg_auth_members membership
      JOIN pg_catalog.pg_roles granted ON granted.oid=membership.roleid
      WHERE granted.rolname IN (bootstrap_role,'reviewrouter_authority_owner',
          'reviewrouter_migration_broker')
        AND membership.member=provider_oid)<>3
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members membership
      JOIN pg_catalog.pg_roles granted ON granted.oid=membership.roleid
      WHERE granted.rolname IN (bootstrap_role,'reviewrouter_authority_owner',
          'reviewrouter_migration_broker')
        AND membership.member=provider_oid
        AND (membership.grantor<>provider_root_oid
          OR NOT membership.admin_option OR membership.inherit_option
          OR membership.set_option)) THEN
    RAISE EXCEPTION 'migration credential provider trust root is noncanonical';
  END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_proc procedure
      JOIN pg_catalog.pg_namespace namespace ON namespace.oid=procedure.pronamespace
      WHERE namespace.nspname='reviewrouter_migration_bootstrap') <> 1
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class object
      WHERE object.relnamespace='reviewrouter_migration_bootstrap'::pg_catalog.regnamespace)
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_type object
      WHERE object.typnamespace='reviewrouter_migration_bootstrap'::pg_catalog.regnamespace
        AND object.typtype<>'p')
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_operator object
      WHERE object.oprnamespace='reviewrouter_migration_bootstrap'::pg_catalog.regnamespace)
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_collation object
      WHERE object.collnamespace='reviewrouter_migration_bootstrap'::pg_catalog.regnamespace)
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_conversion object
      WHERE object.connamespace='reviewrouter_migration_bootstrap'::pg_catalog.regnamespace)
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_opclass object
      WHERE object.opcnamespace='reviewrouter_migration_bootstrap'::pg_catalog.regnamespace)
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_opfamily object
      WHERE object.opfnamespace='reviewrouter_migration_bootstrap'::pg_catalog.regnamespace)
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_ts_config object
      WHERE object.cfgnamespace='reviewrouter_migration_bootstrap'::pg_catalog.regnamespace)
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_ts_dict object
      WHERE object.dictnamespace='reviewrouter_migration_bootstrap'::pg_catalog.regnamespace)
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_ts_parser object
      WHERE object.prsnamespace='reviewrouter_migration_bootstrap'::pg_catalog.regnamespace)
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_ts_template object
      WHERE object.tmplnamespace='reviewrouter_migration_bootstrap'::pg_catalog.regnamespace)
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_extension object
      WHERE object.extnamespace='reviewrouter_migration_bootstrap'::pg_catalog.regnamespace)
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_statistic_ext object
      WHERE object.stxnamespace='reviewrouter_migration_bootstrap'::pg_catalog.regnamespace)
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_default_acl object
      WHERE object.defaclnamespace='reviewrouter_migration_bootstrap'::pg_catalog.regnamespace)
    OR NOT EXISTS (SELECT 1
      FROM pg_catalog.pg_proc procedure
      JOIN pg_catalog.pg_namespace namespace ON namespace.oid=procedure.pronamespace
      JOIN pg_catalog.pg_roles function_owner ON function_owner.oid=procedure.proowner
      JOIN pg_catalog.pg_roles schema_owner ON schema_owner.oid=namespace.nspowner
      JOIN pg_catalog.pg_language language ON language.oid=procedure.prolang
      JOIN pg_catalog.pg_auth_members membership
        ON membership.grantor=function_owner.oid
      JOIN pg_catalog.pg_roles granted ON granted.oid=membership.roleid
      JOIN pg_catalog.pg_roles member ON member.oid=membership.member
      WHERE namespace.nspname='reviewrouter_migration_bootstrap'
        AND procedure.proname='quiesce'
        AND procedure.prokind='f' AND procedure.prosecdef
        AND language.lanname='plpgsql' AND NOT procedure.proretset
        AND procedure.prorettype='pg_catalog.void'::pg_catalog.regtype
        AND procedure.proargtypes='19 19'::pg_catalog.oidvector
        AND procedure.pronargs=2 AND procedure.pronargdefaults=0
        AND procedure.proallargtypes IS NULL AND procedure.proargmodes IS NULL
        AND procedure.proargnames=ARRAY['p_bootstrap','p_database']
        AND procedure.proconfig=ARRAY['search_path=pg_catalog']
        AND procedure.provolatile='v' AND NOT procedure.proisstrict
        AND NOT procedure.proleakproof AND procedure.proparallel='u'
        AND procedure.prosupport=0 AND procedure.procost=100
        AND procedure.prorows=0
        AND procedure.probin IS NULL AND procedure.prosqlbody IS NULL
        AND pg_catalog.encode(pg_catalog.sha256(
          pg_catalog.convert_to(procedure.prosrc,'UTF8')),'hex')=
          '37ede41e54d75bc6c8fc4f5b27516c45864b7f99d3a68a21c170e5dbfbcfb9a2'
        AND function_owner.rolname='reviewrouter_bootstrap_administrator'
        AND function_owner.rolcanlogin AND NOT function_owner.rolsuper
        AND NOT function_owner.rolcreatedb AND function_owner.rolcreaterole
        AND NOT function_owner.rolreplication AND NOT function_owner.rolbypassrls
        AND function_owner.rolconnlimit=1 AND function_owner.rolvaliduntil IS NULL
        AND coalesce(array_length(function_owner.rolconfig,1),0)=0
        AND NOT pg_catalog.has_database_privilege(
          function_owner.oid,current_database(),'CREATE')
        AND (SELECT count(*)=4 AND bool_and(
            (provider_granted.rolname='pg_signal_backend'
              AND NOT provider_membership.admin_option
              AND provider_membership.inherit_option
              AND provider_membership.set_option)
            OR (provider_granted.rolname IN ('reviewrouter_authority_owner',
                  'reviewrouter_migration_broker',bootstrap_role)
              AND provider_membership.admin_option
              AND NOT provider_membership.inherit_option
              AND NOT provider_membership.set_option))
          FROM pg_catalog.pg_auth_members provider_membership
          JOIN pg_catalog.pg_roles provider_granted
            ON provider_granted.oid=provider_membership.roleid
          WHERE provider_membership.member=function_owner.oid)
        AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members outgoing
          WHERE outgoing.roleid=function_owner.oid)
        AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_shdepend dependency
          WHERE dependency.refobjid=function_owner.oid AND dependency.deptype='o'
            AND NOT (dependency.dbid=(SELECT oid FROM pg_catalog.pg_database
                  WHERE datname=current_database())
              AND ((dependency.classid='pg_catalog.pg_namespace'::pg_catalog.regclass
                    AND dependency.objid=namespace.oid)
                OR (dependency.classid='pg_catalog.pg_proc'::pg_catalog.regclass
                    AND dependency.objid=procedure.oid))))
        AND schema_owner.oid=function_owner.oid
        AND granted.rolname='reviewrouter_authority_owner'
        AND member.rolname='reviewrouter_migration_broker'
        AND membership.admin_option AND NOT membership.inherit_option
        AND NOT membership.set_option
        AND (SELECT count(*) FROM pg_catalog.aclexplode(namespace.nspacl) acl)=4
        AND NOT EXISTS (SELECT 1 FROM pg_catalog.aclexplode(namespace.nspacl) acl
          LEFT JOIN pg_catalog.pg_roles grantee ON grantee.oid=acl.grantee
          WHERE acl.grantor<>function_owner.oid OR acl.is_grantable
            OR acl.privilege_type NOT IN ('USAGE','CREATE')
            OR (acl.privilege_type='CREATE' AND acl.grantee<>function_owner.oid)
            OR coalesce(grantee.rolname,'') NOT IN
              (bootstrap_role,'reviewrouter_authority_owner',function_owner.rolname))
        AND (SELECT count(*) FROM pg_catalog.aclexplode(procedure.proacl) acl)=3
        AND NOT EXISTS (SELECT 1 FROM pg_catalog.aclexplode(procedure.proacl) acl
          LEFT JOIN pg_catalog.pg_roles grantee ON grantee.oid=acl.grantee
          WHERE acl.grantor<>function_owner.oid OR acl.is_grantable
            OR acl.privilege_type<>'EXECUTE'
            OR coalesce(grantee.rolname,'') NOT IN
              (bootstrap_role,'reviewrouter_authority_owner',function_owner.rolname)))
  THEN
    RAISE EXCEPTION 'migration credential bootstrap retirement authority is not provisioned';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles
                  WHERE rolname='reviewrouter_migration_issuer') THEN
    RAISE EXCEPTION 'reviewrouter_migration_issuer must be provisioned before credential bootstrap';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles role
      WHERE role.rolname='reviewrouter_migration_issuer' AND role.rolcanlogin
        AND NOT role.rolsuper AND NOT role.rolcreatedb AND NOT role.rolcreaterole
        AND NOT role.rolreplication AND NOT role.rolbypassrls
        AND role.rolconnlimit=(-1) AND role.rolvaliduntil IS NULL
        AND coalesce(array_length(role.rolconfig,1),0)=0)
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_shdepend dependency
      JOIN pg_catalog.pg_roles role ON role.oid=dependency.refobjid
      WHERE role.rolname='reviewrouter_migration_issuer'
        AND dependency.deptype='o')
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members membership
      JOIN pg_catalog.pg_roles granted ON granted.oid=membership.roleid
      JOIN pg_catalog.pg_roles member ON member.oid=membership.member
      JOIN pg_catalog.pg_roles grantor ON grantor.oid=membership.grantor
      WHERE (granted.rolname IN ('reviewrouter_authority_owner',
          'reviewrouter_migration_broker','reviewrouter_migration_issuer')
        OR member.rolname IN ('reviewrouter_authority_owner',
          'reviewrouter_migration_broker','reviewrouter_migration_issuer')
        OR granted.rolname=bootstrap_role OR member.rolname=bootstrap_role)
        AND NOT (granted.rolname='reviewrouter_authority_owner'
          AND member.rolname='reviewrouter_migration_broker'
          AND grantor.rolname='reviewrouter_bootstrap_administrator'
          AND membership.admin_option AND NOT membership.inherit_option
          AND NOT membership.set_option)
        AND NOT (granted.rolname IN ('reviewrouter_authority_owner',
            'reviewrouter_migration_broker')
          AND member.rolname='reviewrouter_bootstrap_administrator'
          AND grantor.oid=provider_root_oid
          AND membership.admin_option AND NOT membership.inherit_option
          AND NOT membership.set_option)
        AND NOT (granted.rolname=bootstrap_role
          AND member.rolname='reviewrouter_bootstrap_administrator'
          AND grantor.oid=provider_root_oid
          AND membership.admin_option AND NOT membership.inherit_option
          AND NOT membership.set_option)
        AND NOT (granted.rolname='reviewrouter_authority_owner'
          AND member.rolname=bootstrap_role
          AND grantor.oid=provider_oid
          AND NOT membership.admin_option
          AND membership.inherit_option AND membership.set_option)
        AND NOT (granted.rolname='reviewrouter_migration_broker'
          AND member.rolname=bootstrap_role
          AND grantor.oid=provider_oid
          AND NOT membership.admin_option
          AND NOT membership.inherit_option AND membership.set_option))
  THEN RAISE EXCEPTION 'migration credential role topology is noncanonical'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace namespace
      JOIN pg_catalog.pg_roles owner ON owner.oid=namespace.nspowner
      WHERE namespace.nspname='release_authority' AND owner.rolname=bootstrap_role)
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class object
      JOIN pg_catalog.pg_namespace namespace ON namespace.oid=object.relnamespace
      JOIN pg_catalog.pg_roles owner ON owner.oid=object.relowner
      WHERE namespace.nspname='release_authority' AND owner.rolname<>bootstrap_role)
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc object
      JOIN pg_catalog.pg_namespace namespace ON namespace.oid=object.pronamespace
      JOIN pg_catalog.pg_roles owner ON owner.oid=object.proowner
      WHERE namespace.nspname='release_authority' AND owner.rolname<>bootstrap_role)
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_type object
      JOIN pg_catalog.pg_namespace namespace ON namespace.oid=object.typnamespace
      JOIN pg_catalog.pg_roles owner ON owner.oid=object.typowner
      WHERE namespace.nspname='release_authority' AND owner.rolname<>bootstrap_role)
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_database database
      JOIN pg_catalog.pg_roles owner ON owner.oid=database.datdba
      WHERE owner.rolname=bootstrap_role AND database.datname<>target_database)
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_namespace namespace
      JOIN pg_catalog.pg_roles owner ON owner.oid=namespace.nspowner
      WHERE owner.rolname=bootstrap_role
        AND namespace.nspname<>'release_authority'
        AND namespace.nspname<>'pg_toast'
        AND namespace.nspname !~ '^pg_(toast_)?temp_[0-9]+$')
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class object
      JOIN pg_catalog.pg_namespace namespace ON namespace.oid=object.relnamespace
      JOIN pg_catalog.pg_roles owner ON owner.oid=object.relowner
      WHERE owner.rolname=bootstrap_role
        AND namespace.nspname<>'release_authority'
        AND namespace.nspname<>'pg_toast'
        AND namespace.nspname !~ '^pg_(toast_)?temp_[0-9]+$')
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc object
      JOIN pg_catalog.pg_namespace namespace ON namespace.oid=object.pronamespace
      JOIN pg_catalog.pg_roles owner ON owner.oid=object.proowner
      WHERE owner.rolname=bootstrap_role
        AND namespace.nspname<>'release_authority'
        AND namespace.nspname !~ '^pg_(toast_)?temp_[0-9]+$')
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_type object
      JOIN pg_catalog.pg_namespace namespace ON namespace.oid=object.typnamespace
      JOIN pg_catalog.pg_roles owner ON owner.oid=object.typowner
      WHERE owner.rolname=bootstrap_role
        AND namespace.nspname<>'release_authority'
        AND namespace.nspname !~ '^pg_(toast_)?temp_[0-9]+$')
  THEN RAISE EXCEPTION 'release authority bootstrap ownership is noncanonical'; END IF;
  EXECUTE pg_catalog.format('REVOKE ALL ON DATABASE %I FROM reviewrouter_migration_issuer',
    target_database);
  EXECUTE pg_catalog.format('REVOKE ALL ON DATABASE %I FROM reviewrouter_migration_broker',
    target_database);
  EXECUTE pg_catalog.format('GRANT CONNECT ON DATABASE %I TO reviewrouter_migration_issuer',
    target_database);
  EXECUTE pg_catalog.format(
    'GRANT CONNECT,CREATE,TEMPORARY ON DATABASE %I TO reviewrouter_migration_broker',
    target_database);
END
$bootstrap_roles$;

SET ROLE reviewrouter_migration_broker;

CREATE SCHEMA reviewrouter_migration_credential;
REVOKE ALL ON SCHEMA reviewrouter_migration_credential FROM PUBLIC;
DO $bootstrap_marker$
DECLARE broker_grantor name;
BEGIN
  SELECT grantor.rolname INTO STRICT broker_grantor
  FROM pg_catalog.pg_auth_members membership
  JOIN pg_catalog.pg_roles granted ON granted.oid=membership.roleid
  JOIN pg_catalog.pg_roles member ON member.oid=membership.member
  JOIN pg_catalog.pg_roles grantor ON grantor.oid=membership.grantor
  WHERE granted.rolname='reviewrouter_authority_owner'
    AND member.rolname='reviewrouter_migration_broker'
    AND membership.admin_option AND NOT membership.inherit_option
    AND NOT membership.set_option;
  EXECUTE pg_catalog.format(
    'COMMENT ON SCHEMA reviewrouter_migration_credential IS %L',
    pg_catalog.jsonb_build_object('bootstrapRole',session_user,
      'brokerGrantorRole',broker_grantor)::text);
END
$bootstrap_marker$;

CREATE TABLE reviewrouter_migration_credential.bootstrap_retirement (
  bootstrap_role name PRIMARY KEY,
  database_name name NOT NULL,
  lifecycle_state text NOT NULL CHECK (lifecycle_state IN ('quiesced','deleted')),
  recorded_at timestamptz(3) NOT NULL
);
INSERT INTO reviewrouter_migration_credential.bootstrap_retirement
  (bootstrap_role,database_name,lifecycle_state,recorded_at)
VALUES(session_user,current_database(),'quiesced',
  date_trunc('milliseconds',clock_timestamp()));

CREATE TABLE reviewrouter_migration_credential.provider_root_pin (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  contract_version integer NOT NULL CHECK (contract_version=1),
  system_identifier text NOT NULL CHECK (system_identifier ~ '^[1-9][0-9]*$'),
  root_oid oid NOT NULL,
  root_name name NOT NULL,
  provider_oid oid NOT NULL,
  provider_name name NOT NULL CHECK (
    provider_name='reviewrouter_bootstrap_administrator'),
  CHECK (root_oid<>provider_oid AND root_name<>provider_name)
);
INSERT INTO reviewrouter_migration_credential.provider_root_pin
  (contract_version,system_identifier,root_oid,root_name,
    provider_oid,provider_name)
SELECT 1,control.system_identifier::text,grantor.oid,grantor.rolname,
  provider.oid,provider.rolname
FROM pg_catalog.pg_control_system() control
CROSS JOIN pg_catalog.pg_auth_members membership
JOIN pg_catalog.pg_roles granted ON granted.oid=membership.roleid
JOIN pg_catalog.pg_roles provider ON provider.oid=membership.member
JOIN pg_catalog.pg_roles grantor ON grantor.oid=membership.grantor
WHERE granted.rolname=session_user
  AND provider.rolname='reviewrouter_bootstrap_administrator'
  AND membership.admin_option AND NOT membership.inherit_option
  AND NOT membership.set_option;

CREATE TABLE reviewrouter_migration_credential.lease (
  lease_id text PRIMARY KEY CHECK (lease_id ~ '^rrml-[a-f0-9]{64}$'),
  expected_commit_sha text NOT NULL CHECK (expected_commit_sha ~ '^[a-f0-9]{40}$'),
  workflow_run_id text NOT NULL CHECK (workflow_run_id ~ '^[1-9][0-9]*$'),
  workflow_run_attempt integer NOT NULL CHECK (workflow_run_attempt > 0),
  operation text NOT NULL CHECK (operation='incremental-upgrade'),
  database_name name NOT NULL,
  owner_role name NOT NULL CHECK (owner_role='reviewrouter_authority_owner'),
  login_role name NOT NULL UNIQUE CHECK (login_role ~ '^rr_migration_[a-f0-9]{24}$'),
  password_sha256 text NOT NULL CHECK (password_sha256 ~ '^sha256:[a-f0-9]{64}$'),
  nonce_sha256 text NOT NULL CHECK (nonce_sha256 ~ '^sha256:[a-f0-9]{64}$'),
  state text NOT NULL CHECK (state IN ('issued','consumed','finalized','reconciled')),
  issued_at timestamptz(3) NOT NULL,
  expires_at timestamptz(3) NOT NULL,
  consumed_at timestamptz(3),
  finalized_at timestamptz(3),
  receipt_sha256 text NOT NULL CHECK (receipt_sha256 ~ '^sha256:[a-f0-9]{64}$'),
  CHECK (expires_at > issued_at AND expires_at <= issued_at + interval '10 minutes'),
  CHECK ((state='issued' AND consumed_at IS NULL AND finalized_at IS NULL)
    OR (state='consumed' AND consumed_at IS NOT NULL AND finalized_at IS NULL)
    OR (state IN ('finalized','reconciled') AND finalized_at IS NOT NULL))
);

CREATE FUNCTION reviewrouter_migration_credential.canonical_receipt(
  p_lease reviewrouter_migration_credential.lease)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $body$
  SELECT 'sha256:'||encode(sha256(convert_to(
    jsonb_build_object(
      'databaseName',p_lease.database_name,
      'expectedCommitSha',p_lease.expected_commit_sha,
      'expiresAt',to_char(p_lease.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'issuedAt',to_char(p_lease.issued_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'leaseId',p_lease.lease_id,
      'loginRole',p_lease.login_role,
      'operation',p_lease.operation,
      'ownerRole',p_lease.owner_role,
      'passwordSha256',p_lease.password_sha256,
      'workflowRunAttempt',p_lease.workflow_run_attempt,
      'workflowRunId',p_lease.workflow_run_id)::text,'UTF8')),'hex')
$body$;

CREATE FUNCTION reviewrouter_migration_credential.login_role_is_inert(
  p_login_role name)
RETURNS boolean LANGUAGE sql SECURITY DEFINER STABLE SET search_path=pg_catalog AS $body$
  SELECT count(*)=1 AND bool_and(
      NOT role.rolcanlogin AND NOT role.rolsuper AND NOT role.rolcreatedb
      AND NOT role.rolcreaterole AND NOT role.rolreplication
      AND NOT role.rolbypassrls AND role.rolconnlimit=1
      AND role.rolvaliduntil IS NOT NULL
      AND role.rolvaliduntil<>'infinity'::timestamptz
      AND coalesce(array_length(role.rolconfig,1),0)=0
      AND (SELECT count(*)=1 AND bool_and(
          membership.roleid=role.oid
          AND member.rolname='reviewrouter_migration_broker'
          AND membership.grantor=pin.root_oid
          AND membership.admin_option AND NOT membership.inherit_option
          AND NOT membership.set_option)
        FROM pg_catalog.pg_auth_members membership
        JOIN pg_catalog.pg_roles member ON member.oid=membership.member
        CROSS JOIN reviewrouter_migration_credential.provider_root_pin pin
        WHERE pin.singleton AND (membership.roleid=role.oid
          OR membership.member=role.oid))
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_shdepend dependency
        WHERE dependency.refobjid=role.oid AND dependency.deptype='o')
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_database object
        CROSS JOIN LATERAL pg_catalog.aclexplode(object.datacl) acl
        WHERE acl.grantee=role.oid)
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace object
        CROSS JOIN LATERAL pg_catalog.aclexplode(object.nspacl) acl
        WHERE acl.grantee=role.oid)
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class object
        CROSS JOIN LATERAL pg_catalog.aclexplode(object.relacl) acl
        WHERE acl.grantee=role.oid)
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute object
        CROSS JOIN LATERAL pg_catalog.aclexplode(object.attacl) acl
        WHERE acl.grantee=role.oid)
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc object
        CROSS JOIN LATERAL pg_catalog.aclexplode(object.proacl) acl
        WHERE acl.grantee=role.oid)
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_type object
        CROSS JOIN LATERAL pg_catalog.aclexplode(object.typacl) acl
        WHERE acl.grantee=role.oid)
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_largeobject_metadata object
        CROSS JOIN LATERAL pg_catalog.aclexplode(object.lomacl) acl
        WHERE acl.grantee=role.oid)
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_default_acl object
        CROSS JOIN LATERAL pg_catalog.aclexplode(object.defaclacl) acl
        WHERE object.defaclrole=role.oid OR acl.grantee=role.oid)
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy policy
        WHERE role.oid=ANY(policy.polroles))
      AND NOT pg_catalog.has_schema_privilege(role.oid,
        'reviewrouter_migration_credential','USAGE')
      AND NOT pg_catalog.has_schema_privilege(role.oid,
        'reviewrouter_migration_credential','CREATE')
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc procedure
        WHERE procedure.pronamespace=
            'reviewrouter_migration_credential'::pg_catalog.regnamespace
          AND pg_catalog.has_function_privilege(role.oid,procedure.oid,'EXECUTE'))
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class object
        CROSS JOIN pg_catalog.unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE',
          'TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']) privilege
        WHERE object.relnamespace=
            'reviewrouter_migration_credential'::pg_catalog.regnamespace
          AND object.relkind IN ('r','p','v','m','f')
          AND pg_catalog.has_table_privilege(role.oid,object.oid,privilege))
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute attribute
        JOIN pg_catalog.pg_class object ON object.oid=attribute.attrelid
        CROSS JOIN pg_catalog.unnest(
          ARRAY['SELECT','INSERT','UPDATE','REFERENCES']) privilege
        WHERE object.relnamespace=
            'reviewrouter_migration_credential'::pg_catalog.regnamespace
          AND attribute.attnum>0 AND NOT attribute.attisdropped
          AND pg_catalog.has_column_privilege(
            role.oid,object.oid,attribute.attnum,privilege)))
  FROM pg_catalog.pg_roles role
  WHERE role.rolname=p_login_role
$body$;

CREATE FUNCTION reviewrouter_migration_credential.terminalize_login_role(
  p_login_role name,p_now timestamptz)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $body$
BEGIN
  IF current_user IS DISTINCT FROM 'reviewrouter_migration_broker'
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles role
      WHERE role.rolname=p_login_role AND NOT role.rolsuper
        AND NOT role.rolcreatedb AND NOT role.rolcreaterole
        AND NOT role.rolreplication AND NOT role.rolbypassrls
        AND role.rolconnlimit=1
        AND coalesce(array_length(role.rolconfig,1),0)=0)
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members membership
      JOIN pg_catalog.pg_roles granted ON granted.oid=membership.roleid
      JOIN pg_catalog.pg_roles member ON member.oid=membership.member
      JOIN pg_catalog.pg_roles grantor ON grantor.oid=membership.grantor
      JOIN reviewrouter_migration_credential.provider_root_pin pin ON pin.singleton
      WHERE (granted.rolname=p_login_role OR member.rolname=p_login_role)
        AND NOT (granted.rolname=p_login_role
          AND member.rolname='reviewrouter_migration_broker'
          AND membership.grantor=pin.root_oid
          AND membership.admin_option AND NOT membership.inherit_option
          AND NOT membership.set_option)
        AND NOT (granted.rolname='reviewrouter_authority_owner'
          AND member.rolname=p_login_role
          AND grantor.rolname='reviewrouter_migration_broker'
          AND NOT membership.admin_option AND NOT membership.inherit_option
          AND membership.set_option))
  THEN RAISE EXCEPTION 'migration credential login role terminalization rejected'; END IF;
  EXECUTE pg_catalog.format('ALTER ROLE %I NOLOGIN PASSWORD NULL VALID UNTIL %L',
    p_login_role,p_now);
  EXECUTE pg_catalog.format(
    'REVOKE reviewrouter_authority_owner FROM %I GRANTED BY reviewrouter_migration_broker RESTRICT',
    p_login_role);
  EXECUTE pg_catalog.format(
    'REVOKE ALL ON SCHEMA reviewrouter_migration_credential FROM %I',p_login_role);
  EXECUTE pg_catalog.format(
    'REVOKE ALL ON FUNCTION reviewrouter_migration_credential.consume(jsonb) FROM %I',
    p_login_role);
  EXECUTE pg_catalog.format(
    'REVOKE ALL ON FUNCTION reviewrouter_migration_credential.finalize(jsonb) FROM %I',
    p_login_role);
  IF NOT reviewrouter_migration_credential.login_role_is_inert(p_login_role)
  THEN RAISE EXCEPTION 'migration credential terminal role is noncanonical'; END IF;
  RETURN true;
END $body$;

CREATE FUNCTION reviewrouter_migration_credential.issue(p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $body$
DECLARE issued reviewrouter_migration_credential.lease%ROWTYPE;
DECLARE now_at timestamptz(3) := date_trunc('milliseconds',clock_timestamp());
DECLARE raw_password text := p_input->>'password';
DECLARE raw_nonce text := p_input->>'nonce';
BEGIN
  IF session_user IS DISTINCT FROM 'reviewrouter_migration_issuer'
    OR jsonb_typeof(p_input) IS DISTINCT FROM 'object'
    OR (SELECT count(*) FROM jsonb_object_keys(p_input)) IS DISTINCT FROM 8::bigint
    OR NOT p_input ?& ARRAY['leaseId','expectedCommitSha','workflowRunId',
      'workflowRunAttempt','operation','loginRole','password','nonce']
    OR p_input->>'leaseId' !~ '^rrml-[a-f0-9]{64}$'
    OR p_input->>'expectedCommitSha' !~ '^[a-f0-9]{40}$'
    OR p_input->>'workflowRunId' !~ '^[1-9][0-9]*$'
    OR p_input->>'workflowRunAttempt' !~ '^[1-9][0-9]*$'
    OR p_input->>'operation' IS DISTINCT FROM 'incremental-upgrade'
    OR p_input->>'loginRole' !~ '^rr_migration_[a-f0-9]{24}$'
    OR raw_password !~ '^[A-Za-z0-9_-]{43}$'
    OR raw_nonce !~ '^[A-Za-z0-9_-]{43}$'
  THEN RAISE EXCEPTION 'migration credential issue input invalid'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(1381126735,1381258072);
  -- Converge every unfinished lease before minting another one. Consume and
  -- finalize are commit-coupled below, so no unfinished row can correspond to
  -- a durable owner membership or an unfenced owner backend.
  FOR issued IN SELECT * FROM reviewrouter_migration_credential.lease
    WHERE state IN ('issued','consumed') FOR UPDATE
  LOOP
    PERFORM reviewrouter_migration_credential.terminalize_login_role(
      issued.login_role,now_at);
    UPDATE reviewrouter_migration_credential.lease SET state='reconciled',
      finalized_at=now_at WHERE lease_id=issued.lease_id;
  END LOOP;
  PERFORM reviewrouter_migration_credential.retire_terminal_login_roles();
  IF EXISTS (SELECT 1 FROM reviewrouter_migration_credential.lease
             WHERE state IN ('issued','consumed') AND expires_at>now_at) THEN
    RAISE EXCEPTION 'migration credential lease already active';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles
             WHERE rolname=p_input->>'loginRole') THEN
    RAISE EXCEPTION 'migration credential login role already exists';
  END IF;
  PERFORM pg_catalog.set_config('createrole_self_grant','',true);
  EXECUTE pg_catalog.format(
    'CREATE ROLE %I LOGIN PASSWORD %L CONNECTION LIMIT 1 VALID UNTIL %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',
    p_input->>'loginRole',raw_password,now_at+interval '10 minutes');
  EXECUTE pg_catalog.format('GRANT USAGE ON SCHEMA reviewrouter_migration_credential TO %I',
    p_input->>'loginRole');
  EXECUTE pg_catalog.format(
    'GRANT EXECUTE ON FUNCTION reviewrouter_migration_credential.consume(jsonb) TO %I',
    p_input->>'loginRole');
  EXECUTE pg_catalog.format(
    'GRANT EXECUTE ON FUNCTION reviewrouter_migration_credential.finalize(jsonb) TO %I',
    p_input->>'loginRole');
  INSERT INTO reviewrouter_migration_credential.lease(
    lease_id,expected_commit_sha,workflow_run_id,workflow_run_attempt,operation,
    database_name,owner_role,login_role,password_sha256,nonce_sha256,state,
    issued_at,expires_at,receipt_sha256)
  VALUES(p_input->>'leaseId',p_input->>'expectedCommitSha',p_input->>'workflowRunId',
    (p_input->>'workflowRunAttempt')::integer,p_input->>'operation',current_database(),
    'reviewrouter_authority_owner',p_input->>'loginRole',
    'sha256:'||encode(sha256(convert_to(raw_password,'UTF8')),'hex'),
    'sha256:'||encode(sha256(convert_to(raw_nonce,'UTF8')),'hex'),'issued',now_at,
    now_at+interval '10 minutes','sha256:'||repeat('0',64)) RETURNING * INTO issued;
  UPDATE reviewrouter_migration_credential.lease SET
    receipt_sha256=reviewrouter_migration_credential.canonical_receipt(issued)
    WHERE lease_id=issued.lease_id RETURNING * INTO issued;
  RETURN jsonb_build_object('leaseId',issued.lease_id,'loginRole',issued.login_role,
    'databaseName',issued.database_name,'ownerRole',issued.owner_role,
    'expectedCommitSha',issued.expected_commit_sha,'workflowRunId',issued.workflow_run_id,
    'workflowRunAttempt',issued.workflow_run_attempt,'operation',issued.operation,
    'expiresAt',to_char(issued.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'passwordSha256',issued.password_sha256,'nonce',raw_nonce,
    'receiptSha256',issued.receipt_sha256);
END $body$;

CREATE FUNCTION reviewrouter_migration_credential.consume(p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $body$
DECLARE active reviewrouter_migration_credential.lease%ROWTYPE;
DECLARE now_at timestamptz(3) := date_trunc('milliseconds',clock_timestamp());
DECLARE remaining_milliseconds bigint;
BEGIN
  SELECT * INTO STRICT active FROM reviewrouter_migration_credential.lease
    WHERE lease_id=p_input->>'leaseId' FOR UPDATE;
  IF session_user IS DISTINCT FROM active.login_role
    OR current_database() IS DISTINCT FROM active.database_name
    OR active.state IS DISTINCT FROM 'issued' OR active.expires_at<=now_at
    OR active.expected_commit_sha IS DISTINCT FROM p_input->>'expectedCommitSha'
    OR active.workflow_run_id IS DISTINCT FROM p_input->>'workflowRunId'
    OR active.workflow_run_attempt IS DISTINCT FROM (p_input->>'workflowRunAttempt')::integer
    OR active.operation IS DISTINCT FROM p_input->>'operation'
    OR active.password_sha256 IS DISTINCT FROM p_input->>'passwordSha256'
    OR active.nonce_sha256 IS DISTINCT FROM
      'sha256:'||encode(sha256(convert_to(p_input->>'nonce','UTF8')),'hex')
    OR active.receipt_sha256 IS DISTINCT FROM p_input->>'receiptSha256'
    OR (SELECT count(*) FROM pg_catalog.pg_stat_activity
        WHERE datname=current_database() AND usename=session_user) IS DISTINCT FROM 1::bigint
  THEN RAISE EXCEPTION 'migration credential consume rejected'; END IF;
  remaining_milliseconds := greatest(1,
    pg_catalog.floor(extract(epoch FROM
      (active.expires_at-pg_catalog.clock_timestamp()))*1000)::bigint);
  PERFORM pg_catalog.set_config('transaction_timeout',
    remaining_milliseconds::text||'ms',true);
  PERFORM pg_catalog.set_config('statement_timeout',
    remaining_milliseconds::text||'ms',true);
  PERFORM pg_catalog.set_config('idle_in_transaction_session_timeout',
    remaining_milliseconds::text||'ms',true);
  EXECUTE pg_catalog.format('ALTER ROLE %I NOLOGIN PASSWORD NULL VALID UNTIL %L',
    active.login_role,now_at);
  EXECUTE pg_catalog.format(
    'GRANT reviewrouter_authority_owner TO %I WITH ADMIN FALSE, INHERIT FALSE, SET TRUE',
    active.login_role);
  UPDATE reviewrouter_migration_credential.lease SET state='consumed',consumed_at=now_at
    WHERE lease_id=active.lease_id RETURNING * INTO active;
  RETURN jsonb_build_object('leaseId',active.lease_id,'ownerRole',active.owner_role,
    'state',active.state,'consumedAt',to_char(active.consumed_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
END $body$;

CREATE FUNCTION reviewrouter_migration_credential.active(
  p_lease_id text,p_expected_commit_sha text,p_workflow_run_id text,
  p_workflow_run_attempt integer,p_operation text)
RETURNS boolean LANGUAGE sql SECURITY DEFINER STABLE SET search_path=pg_catalog AS $body$
  SELECT EXISTS (SELECT 1 FROM reviewrouter_migration_credential.lease
    WHERE lease_id=p_lease_id AND login_role=session_user AND state='consumed'
      AND expected_commit_sha=p_expected_commit_sha AND workflow_run_id=p_workflow_run_id
      AND workflow_run_attempt=p_workflow_run_attempt AND operation=p_operation
      AND expires_at>clock_timestamp())
$body$;

CREATE FUNCTION reviewrouter_migration_credential.membership_is_active(
  p_login_role name,p_owner_role name)
RETURNS boolean LANGUAGE sql SECURITY DEFINER STABLE SET search_path=pg_catalog AS $body$
  SELECT p_owner_role='reviewrouter_authority_owner'
    AND EXISTS (SELECT 1 FROM reviewrouter_migration_credential.lease
      WHERE login_role=p_login_role AND owner_role=p_owner_role AND state='consumed'
        AND expires_at>clock_timestamp())
$body$;

CREATE FUNCTION reviewrouter_migration_credential.login_role_membership_is_canonical(
  p_login_role name,p_member_role name)
RETURNS boolean LANGUAGE sql SECURITY DEFINER STABLE SET search_path=pg_catalog AS $body$
  SELECT p_member_role='reviewrouter_migration_broker'
    AND count(*)=1
    AND bool_and(lease.state='consumed' AND lease.expires_at>clock_timestamp()
      AND NOT role.rolcanlogin AND NOT role.rolsuper AND NOT role.rolcreatedb
      AND NOT role.rolcreaterole AND NOT role.rolreplication
      AND NOT role.rolbypassrls AND role.rolconnlimit=1
      AND role.rolvaliduntil IS NOT NULL
      AND role.rolvaliduntil<>'infinity'::timestamptz
      AND coalesce(array_length(role.rolconfig,1),0)=0)
  FROM reviewrouter_migration_credential.lease lease
  JOIN pg_catalog.pg_roles role ON role.rolname=lease.login_role
  WHERE lease.login_role=p_login_role
$body$;

CREATE FUNCTION reviewrouter_migration_credential.retire_terminal_login_roles()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $body$
DECLARE item reviewrouter_migration_credential.lease%ROWTYPE;
DECLARE retired integer := 0;
BEGIN
  IF current_user IS DISTINCT FROM 'reviewrouter_migration_broker' THEN
    RAISE EXCEPTION 'migration credential role retirement caller invalid';
  END IF;
  FOR item IN SELECT * FROM reviewrouter_migration_credential.lease
    WHERE state IN ('finalized','reconciled')
      AND pg_catalog.to_regrole(login_role) IS NOT NULL
    ORDER BY issued_at,lease_id FOR UPDATE
  LOOP
    IF NOT reviewrouter_migration_credential.login_role_is_inert(item.login_role)
    THEN RAISE EXCEPTION 'migration credential terminal role is noncanonical'; END IF;
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_stat_activity
         WHERE usename=item.login_role) THEN
      CONTINUE;
    END IF;
    EXECUTE pg_catalog.format('DROP ROLE %I',item.login_role);
    retired := retired+1;
  END LOOP;
  RETURN retired;
END $body$;

CREATE FUNCTION reviewrouter_migration_credential.bootstrap_is_retired()
RETURNS boolean LANGUAGE sql SECURITY DEFINER STABLE SET search_path=pg_catalog AS $body$
  SELECT count(*)=1 AND bool_and(retirement.lifecycle_state='deleted'
      AND pg_catalog.to_regrole(retirement.bootstrap_role) IS NULL)
  FROM reviewrouter_migration_credential.bootstrap_retirement retirement
  WHERE retirement.database_name=current_database()
$body$;

CREATE FUNCTION reviewrouter_migration_credential.bootstrap_is_retired(
  p_bootstrap name)
RETURNS boolean LANGUAGE sql SECURITY DEFINER STABLE SET search_path=pg_catalog AS $body$
  SELECT count(*)=1 AND bool_and(retirement.bootstrap_role=p_bootstrap
      AND retirement.lifecycle_state='deleted'
      AND pg_catalog.to_regrole(retirement.bootstrap_role) IS NULL)
  FROM reviewrouter_migration_credential.bootstrap_retirement retirement
  WHERE retirement.database_name=current_database()
$body$;

CREATE FUNCTION reviewrouter_migration_credential.provider_root_pin_is_exact(
  p_system_identifier text,p_root_oid oid,p_root_name name,
  p_provider_oid oid,p_provider_name name)
RETURNS boolean LANGUAGE sql SECURITY DEFINER STABLE SET search_path=pg_catalog AS $body$
  SELECT count(*)=1 AND bool_and(pin.contract_version=1
      AND pin.system_identifier=p_system_identifier
      AND pin.root_oid=p_root_oid AND pin.root_name=p_root_name
      AND pin.provider_oid=p_provider_oid AND pin.provider_name=p_provider_name)
  FROM reviewrouter_migration_credential.provider_root_pin pin
  WHERE pin.singleton
$body$;

CREATE FUNCTION reviewrouter_migration_credential.provider_terminal_topology_is_exact()
RETURNS boolean LANGUAGE sql SECURITY DEFINER STABLE SET search_path=pg_catalog AS $body$
  SELECT coalesce((
    WITH pin AS (
      SELECT * FROM reviewrouter_migration_credential.provider_root_pin
      WHERE singleton AND contract_version=1
    ), bootstrap AS (
      SELECT bootstrap_role FROM reviewrouter_migration_credential.bootstrap_retirement
      WHERE database_name=current_database() AND lifecycle_state='deleted'
    )
    SELECT (SELECT count(*)=1 FROM pin)
      AND (SELECT count(*)=1 FROM bootstrap)
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles role
        JOIN bootstrap ON role.rolname=bootstrap.bootstrap_role)
      AND EXISTS (SELECT 1 FROM pin
        JOIN pg_catalog.pg_roles root ON root.oid=pin.root_oid
        JOIN pg_catalog.pg_roles provider ON provider.oid=pin.provider_oid
        WHERE pin.system_identifier=(SELECT system_identifier::text
            FROM pg_catalog.pg_control_system())
          AND root.rolname=pin.root_name AND provider.rolname=pin.provider_name
          AND provider.rolname='reviewrouter_bootstrap_administrator'
          AND provider.rolcanlogin AND provider.rolcreaterole
          AND NOT provider.rolsuper AND NOT provider.rolcreatedb
          AND NOT provider.rolreplication AND NOT provider.rolbypassrls
          AND provider.rolconnlimit=1 AND provider.rolvaliduntil IS NULL
          AND coalesce(pg_catalog.array_length(provider.rolconfig,1),0)=0)
      AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_shdepend dependency
        JOIN pg_catalog.pg_roles role ON role.oid=dependency.refobjid
        CROSS JOIN bootstrap
        WHERE role.rolname IN ('reviewrouter_migration_issuer',
            bootstrap.bootstrap_role,'reviewrouter_bootstrap_administrator')
          AND dependency.deptype='o')
      AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_shdepend dependency
        JOIN pg_catalog.pg_roles role ON role.oid=dependency.refobjid
        WHERE role.rolname='reviewrouter_migration_broker'
          AND dependency.deptype='o'
          AND dependency.dbid<>(SELECT oid FROM pg_catalog.pg_database
            WHERE datname=current_database()))
      AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_shdepend dependency
        JOIN pg_catalog.pg_roles role ON role.oid=dependency.refobjid
        WHERE role.rolname='reviewrouter_authority_owner'
          AND dependency.deptype='o'
          AND NOT (dependency.dbid=(SELECT oid FROM pg_catalog.pg_database
                WHERE datname=current_database())
            OR (dependency.dbid=0
              AND dependency.classid='pg_catalog.pg_database'::regclass
              AND dependency.objid=(SELECT oid FROM pg_catalog.pg_database
                WHERE datname=current_database()))))
      AND (SELECT count(*)=3 AND bool_and(
          ((granted.rolname IN ('reviewrouter_authority_owner',
                'reviewrouter_migration_broker')
              AND member.oid=pin.provider_oid
              AND membership.grantor=pin.root_oid)
            OR (granted.rolname='reviewrouter_authority_owner'
              AND member.rolname='reviewrouter_migration_broker'
              AND membership.grantor=pin.provider_oid))
          AND membership.admin_option AND NOT membership.inherit_option
          AND NOT membership.set_option)
        FROM pg_catalog.pg_auth_members membership
        JOIN pg_catalog.pg_roles granted ON granted.oid=membership.roleid
        JOIN pg_catalog.pg_roles member ON member.oid=membership.member
        CROSS JOIN pin
        WHERE (granted.rolname IN ('reviewrouter_authority_owner',
              'reviewrouter_migration_broker') AND member.oid=pin.provider_oid)
          OR (granted.rolname='reviewrouter_authority_owner'
            AND member.rolname='reviewrouter_migration_broker'))
      AND (SELECT count(*)=1 AND bool_and(NOT membership.admin_option
          AND membership.inherit_option AND membership.set_option)
        FROM pg_catalog.pg_auth_members membership
        JOIN pg_catalog.pg_roles granted ON granted.oid=membership.roleid
        JOIN pg_catalog.pg_roles member ON member.oid=membership.member
        WHERE granted.rolname='pg_signal_backend'
          AND member.rolname='reviewrouter_bootstrap_administrator')
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members membership
        JOIN pg_catalog.pg_roles granted ON granted.oid=membership.roleid
        JOIN pg_catalog.pg_roles member ON member.oid=membership.member
        WHERE member.rolname='reviewrouter_bootstrap_administrator'
          AND granted.rolname NOT IN ('pg_signal_backend',
            'reviewrouter_authority_owner','reviewrouter_migration_broker'))
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members membership
        JOIN pg_catalog.pg_roles granted ON granted.oid=membership.roleid
        WHERE granted.rolname='reviewrouter_bootstrap_administrator')
      AND NOT EXISTS (
        SELECT 1 FROM reviewrouter_migration_credential.lease lease
        JOIN pg_catalog.pg_roles role ON role.rolname=lease.login_role
        WHERE lease.state IN ('finalized','reconciled')
          AND NOT reviewrouter_migration_credential.login_role_is_inert(
            lease.login_role))
      AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_roles role
        WHERE role.rolname ~ '^rr_migration_[a-f0-9]{24}$'
          AND NOT EXISTS (
            SELECT 1 FROM reviewrouter_migration_credential.lease lease
            WHERE lease.login_role=role.rolname
              AND lease.state IN ('finalized','reconciled')))
      AND NOT EXISTS (
        SELECT 1 FROM reviewrouter_migration_credential.lease lease
        WHERE lease.state IN ('issued','consumed'))
  ),false)
$body$;

CREATE FUNCTION reviewrouter_migration_credential.mark_bootstrap_deleted(
  p_bootstrap name,p_root_oid oid,p_provider_oid oid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $body$
BEGIN
  IF session_user IS DISTINCT FROM 'reviewrouter_bootstrap_administrator'
    OR current_user IS DISTINCT FROM 'reviewrouter_migration_broker'
    OR session_user::pg_catalog.regrole::oid<>p_provider_oid
    OR NOT EXISTS (SELECT 1
      FROM reviewrouter_migration_credential.provider_root_pin pin
      WHERE pin.singleton AND pin.root_oid=p_root_oid
        AND pin.provider_oid=p_provider_oid)
    OR NOT EXISTS (SELECT 1
      FROM reviewrouter_migration_credential.bootstrap_retirement retirement
      JOIN pg_catalog.pg_roles role ON role.rolname=retirement.bootstrap_role
      WHERE retirement.bootstrap_role=p_bootstrap
        AND retirement.database_name=current_database()
        AND retirement.lifecycle_state='quiesced'
        AND NOT role.rolcanlogin AND NOT role.rolcreaterole)
  THEN RAISE EXCEPTION 'bootstrap terminal deletion marker rejected'; END IF;
  UPDATE reviewrouter_migration_credential.bootstrap_retirement
  SET lifecycle_state='deleted',recorded_at=date_trunc('milliseconds',clock_timestamp())
  WHERE bootstrap_role=p_bootstrap AND database_name=current_database();
  RETURN true;
END $body$;

CREATE FUNCTION reviewrouter_migration_credential.finalize(p_input jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $body$
DECLARE active reviewrouter_migration_credential.lease%ROWTYPE;
DECLARE now_at timestamptz(3) := date_trunc('milliseconds',clock_timestamp());
BEGIN
  SELECT * INTO STRICT active FROM reviewrouter_migration_credential.lease
    WHERE lease_id=p_input->>'leaseId' FOR UPDATE;
  IF session_user IS DISTINCT FROM active.login_role
    OR active.state IS DISTINCT FROM 'consumed'
    OR active.nonce_sha256 IS DISTINCT FROM
      'sha256:'||encode(sha256(convert_to(p_input->>'nonce','UTF8')),'hex')
  THEN RAISE EXCEPTION 'migration credential finalize rejected'; END IF;
  PERFORM reviewrouter_migration_credential.terminalize_login_role(
    active.login_role,now_at);
  UPDATE reviewrouter_migration_credential.lease SET state='finalized',finalized_at=now_at
    WHERE lease_id=active.lease_id;
  RETURN true;
END $body$;

-- A single-statement/autocommit consume must never make the catalog grant
-- durable. The installer finalizes in the same explicit transaction; this
-- deferred check observes that final state at commit and rolls every other
-- consume (including its membership grant) back.
CREATE FUNCTION reviewrouter_migration_credential.consumed_lease_must_finalize()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $body$
BEGIN
  IF NEW.state='consumed' AND EXISTS (
    SELECT 1 FROM reviewrouter_migration_credential.lease current_lease
    WHERE current_lease.lease_id=NEW.lease_id
      AND current_lease.state='consumed')
  THEN RAISE EXCEPTION 'migration credential consume requires same-transaction finalize'; END IF;
  RETURN NULL;
END $body$;
CREATE CONSTRAINT TRIGGER migration_credential_consume_finalize_guard
AFTER INSERT OR UPDATE ON reviewrouter_migration_credential.lease
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION reviewrouter_migration_credential.consumed_lease_must_finalize();

CREATE FUNCTION reviewrouter_migration_credential.reconcile()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $body$
DECLARE item reviewrouter_migration_credential.lease%ROWTYPE;
DECLARE reconciled integer := 0;
BEGIN
  IF session_user IS DISTINCT FROM 'reviewrouter_migration_issuer' THEN
    RAISE EXCEPTION 'migration credential reconcile caller invalid';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(1381126735,1381258072);
  FOR item IN SELECT * FROM reviewrouter_migration_credential.lease
    WHERE state IN ('issued','consumed') FOR UPDATE
  LOOP
    PERFORM reviewrouter_migration_credential.terminalize_login_role(
      item.login_role,date_trunc('milliseconds',clock_timestamp()));
    UPDATE reviewrouter_migration_credential.lease SET state='reconciled',
      finalized_at=date_trunc('milliseconds',clock_timestamp()) WHERE lease_id=item.lease_id;
    reconciled := reconciled+1;
  END LOOP;
  PERFORM reviewrouter_migration_credential.retire_terminal_login_roles();
  RETURN reconciled;
END $body$;

REVOKE ALL ON ALL TABLES IN SCHEMA reviewrouter_migration_credential FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA reviewrouter_migration_credential FROM PUBLIC;
GRANT SELECT ON TABLE reviewrouter_migration_credential.provider_root_pin
  TO reviewrouter_authority_owner;
GRANT USAGE ON SCHEMA reviewrouter_migration_credential TO reviewrouter_migration_issuer;
GRANT EXECUTE ON FUNCTION reviewrouter_migration_credential.issue(jsonb)
  TO reviewrouter_migration_issuer;
GRANT EXECUTE ON FUNCTION reviewrouter_migration_credential.reconcile()
  TO reviewrouter_migration_issuer;
GRANT USAGE ON SCHEMA reviewrouter_migration_credential
  TO reviewrouter_authority_owner;
GRANT EXECUTE ON FUNCTION reviewrouter_migration_credential.membership_is_active(name,name)
  TO reviewrouter_authority_owner;
GRANT EXECUTE ON FUNCTION reviewrouter_migration_credential.login_role_membership_is_canonical(name,name)
  TO reviewrouter_authority_owner;
GRANT EXECUTE ON FUNCTION reviewrouter_migration_credential.login_role_is_inert(name)
  TO reviewrouter_authority_owner;
GRANT EXECUTE ON FUNCTION reviewrouter_migration_credential.bootstrap_is_retired()
  TO reviewrouter_authority_owner;
GRANT EXECUTE ON FUNCTION reviewrouter_migration_credential.provider_terminal_topology_is_exact()
  TO reviewrouter_authority_owner;
GRANT EXECUTE ON FUNCTION reviewrouter_migration_credential.active(text,text,text,integer,text)
  TO reviewrouter_authority_owner;
GRANT USAGE ON SCHEMA reviewrouter_migration_credential
  TO reviewrouter_release_control,reviewrouter_provider_authority,
     reviewrouter_release_witness;
GRANT SELECT ON TABLE reviewrouter_migration_credential.provider_root_pin
  TO reviewrouter_release_control,reviewrouter_provider_authority,
     reviewrouter_release_witness;
GRANT SELECT ON TABLE reviewrouter_migration_credential.bootstrap_retirement
  TO reviewrouter_release_control,reviewrouter_provider_authority,
     reviewrouter_release_witness;
GRANT EXECUTE ON FUNCTION reviewrouter_migration_credential.membership_is_active(name,name)
  TO reviewrouter_release_control,reviewrouter_provider_authority,
     reviewrouter_release_witness;
GRANT EXECUTE ON FUNCTION reviewrouter_migration_credential.bootstrap_is_retired()
  TO reviewrouter_release_control,reviewrouter_provider_authority,
     reviewrouter_release_witness;
GRANT EXECUTE ON FUNCTION reviewrouter_migration_credential.login_role_is_inert(name)
  TO reviewrouter_release_control,reviewrouter_provider_authority,
     reviewrouter_release_witness;
GRANT EXECUTE ON FUNCTION reviewrouter_migration_credential.provider_terminal_topology_is_exact()
  TO reviewrouter_release_control,reviewrouter_provider_authority,
     reviewrouter_release_witness;
GRANT USAGE ON SCHEMA reviewrouter_migration_credential
  TO reviewrouter_bootstrap_administrator;
GRANT EXECUTE ON FUNCTION reviewrouter_migration_credential.mark_bootstrap_deleted(name,oid,oid)
  TO reviewrouter_bootstrap_administrator;
GRANT EXECUTE ON FUNCTION reviewrouter_migration_credential.provider_root_pin_is_exact(text,oid,name,oid,name)
  TO reviewrouter_bootstrap_administrator;
GRANT EXECUTE ON FUNCTION reviewrouter_migration_credential.bootstrap_is_retired(name)
  TO reviewrouter_bootstrap_administrator;
GRANT EXECUTE ON FUNCTION reviewrouter_migration_credential.provider_terminal_topology_is_exact()
  TO reviewrouter_bootstrap_administrator;
GRANT EXECUTE ON FUNCTION reviewrouter_migration_credential.login_role_is_inert(name)
  TO reviewrouter_bootstrap_administrator;

RESET ROLE;

-- The exact bootstrap-to-broker provisioning edge is needed to enter the
-- broker, but must be gone before any ownership transfer can commit.
DO $transfer_authority_ownership$
DECLARE object record;
DECLARE bootstrap_role name := current_user;
BEGIN
  GRANT CREATE ON SCHEMA release_authority TO reviewrouter_authority_owner;
  FOR object IN SELECT c.relkind,c.relname FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='release_authority' AND c.relkind IN ('r','p','v','m','f')
  LOOP
    EXECUTE pg_catalog.format('ALTER %s release_authority.%I OWNER TO reviewrouter_authority_owner',
      CASE object.relkind WHEN 'v' THEN 'VIEW'
        WHEN 'm' THEN 'MATERIALIZED VIEW' WHEN 'f' THEN 'FOREIGN TABLE'
        ELSE 'TABLE' END,
      object.relname);
  END LOOP;
  FOR object IN SELECT p.oid::pg_catalog.regprocedure AS identity
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='release_authority'
  LOOP
    EXECUTE pg_catalog.format('ALTER FUNCTION %s OWNER TO reviewrouter_authority_owner',
      object.identity);
  END LOOP;
  FOR object IN SELECT t.typname FROM pg_catalog.pg_type t
    JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace
    WHERE n.nspname='release_authority' AND t.typrelid=0 AND t.typname !~ '^_'
  LOOP
    EXECUTE pg_catalog.format('ALTER TYPE release_authority.%I OWNER TO reviewrouter_authority_owner',
      object.typname);
  END LOOP;
  REVOKE ALL ON SCHEMA release_authority FROM reviewrouter_authority_owner;
  ALTER SCHEMA release_authority OWNER TO reviewrouter_authority_owner;
  EXECUTE pg_catalog.format(
    'GRANT CONNECT,CREATE,TEMPORARY ON DATABASE %I TO reviewrouter_authority_owner',
    current_database());
  EXECUTE pg_catalog.format(
    'REVOKE CREATE,TEMPORARY ON DATABASE %I FROM reviewrouter_migration_broker',
    current_database());
  IF pg_catalog.to_regclass('pg_temp.release_authority_catalog_verification') IS NOT NULL THEN
    GRANT ALL ON TABLE pg_temp.release_authority_catalog_verification
      TO reviewrouter_authority_owner;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_shdepend dependency
      WHERE dependency.refobjid=bootstrap_role::pg_catalog.regrole
        AND dependency.deptype='o'
        AND CASE
          WHEN dependency.dbid=0
            AND dependency.classid='pg_catalog.pg_database'::pg_catalog.regclass
            AND dependency.objid=(SELECT oid FROM pg_catalog.pg_database
              WHERE datname=current_database()) THEN false
          WHEN dependency.dbid=(SELECT oid FROM pg_catalog.pg_database
              WHERE datname=current_database())
            AND (dependency.classid='pg_catalog.pg_namespace'::pg_catalog.regclass
                  AND dependency.objid IN (SELECT oid FROM pg_catalog.pg_namespace
                    WHERE nspname ~ '^pg_(toast_)?temp_[0-9]+$')
              OR dependency.classid='pg_catalog.pg_class'::pg_catalog.regclass
                  AND dependency.objid IN (SELECT temp_object.oid
                    FROM pg_catalog.pg_class temp_object
                    JOIN pg_catalog.pg_namespace namespace
                      ON namespace.oid=temp_object.relnamespace
                    WHERE namespace.nspname ~ '^pg_(toast_)?temp_[0-9]+$')
              OR dependency.classid='pg_catalog.pg_proc'::pg_catalog.regclass
                  AND dependency.objid IN (SELECT temp_object.oid
                    FROM pg_catalog.pg_proc temp_object
                    JOIN pg_catalog.pg_namespace namespace
                      ON namespace.oid=temp_object.pronamespace
                    WHERE namespace.nspname ~ '^pg_(toast_)?temp_[0-9]+$')
              OR dependency.classid='pg_catalog.pg_type'::pg_catalog.regclass
                  AND dependency.objid IN (SELECT temp_object.oid
                    FROM pg_catalog.pg_type temp_object
                    JOIN pg_catalog.pg_namespace namespace
                      ON namespace.oid=temp_object.typnamespace
                    WHERE namespace.nspname ~ '^pg_(toast_)?temp_[0-9]+$')) THEN false
          ELSE true
        END) THEN
    RAISE EXCEPTION 'release authority bootstrap retained unexpected ownership';
  END IF;
  EXECUTE pg_catalog.format(
    'REASSIGN OWNED BY %I TO reviewrouter_authority_owner',bootstrap_role);
  EXECUTE pg_catalog.format('REVOKE ALL ON DATABASE %I FROM %I',
    current_database(),bootstrap_role);
END
$transfer_authority_ownership$;

SET ROLE reviewrouter_authority_owner;

DO $database_acl$
DECLARE bootstrap_role name := session_user;
DECLARE target_database name := current_database();
BEGIN
  EXECUTE pg_catalog.format('REVOKE ALL ON DATABASE %I FROM PUBLIC',target_database);
  EXECUTE pg_catalog.format(
    'GRANT CONNECT,TEMPORARY ON DATABASE %I TO PUBLIC',target_database);
  EXECUTE pg_catalog.format('REVOKE ALL ON DATABASE %I FROM %I',
    target_database,bootstrap_role);
  EXECUTE pg_catalog.format(
    'REVOKE ALL ON DATABASE %I FROM reviewrouter_bootstrap_administrator',
    target_database);
  EXECUTE pg_catalog.format(
    'REVOKE ALL ON DATABASE %I FROM reviewrouter_migration_broker',
    target_database);
  EXECUTE pg_catalog.format(
    'REVOKE ALL ON DATABASE %I FROM reviewrouter_migration_issuer',
    target_database);
  EXECUTE pg_catalog.format(
    'GRANT CONNECT ON DATABASE %I TO reviewrouter_migration_issuer',
    target_database);
END
$database_acl$;

DO $schema_version_marker$
DECLARE marker jsonb := coalesce(pg_catalog.obj_description(
  'release_authority'::pg_catalog.regnamespace,'pg_namespace')::jsonb,'{}'::jsonb);
BEGIN
  EXECUTE pg_catalog.format('COMMENT ON SCHEMA release_authority IS %L',
    (marker||pg_catalog.jsonb_build_object('schemaVersion',15))::text);
END
$schema_version_marker$;

DO $quiesce_bootstrap$
BEGIN
  PERFORM reviewrouter_migration_bootstrap.quiesce(
    session_user,current_database());
END
$quiesce_bootstrap$;

COMMIT;
