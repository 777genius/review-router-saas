BEGIN;

-- This is the only transition that uses the original database-owner login.
-- It moves authority ownership to a NOLOGIN role and installs a NOLOGIN
-- credential broker. Future migrations receive a short-lived login whose
-- owner membership is granted only after an atomic database-side consume.
DO $bootstrap_roles$
DECLARE bootstrap_role name := current_user;
DECLARE target_database name := current_database();
BEGIN
  IF session_user IS DISTINCT FROM current_user THEN
    RAISE EXCEPTION 'migration credential bootstrap requires a direct owner session';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles
                  WHERE rolname=current_user AND rolcreaterole) THEN
    RAISE EXCEPTION 'migration credential bootstrap owner requires CREATEROLE';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles
                  WHERE rolname='reviewrouter_authority_owner') THEN
    CREATE ROLE reviewrouter_authority_owner NOLOGIN NOSUPERUSER NOCREATEDB
      NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles
                  WHERE rolname='reviewrouter_migration_broker') THEN
    CREATE ROLE reviewrouter_migration_broker NOLOGIN NOSUPERUSER NOCREATEDB
      CREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT pg_catalog.pg_has_role(
      'reviewrouter_migration_broker','reviewrouter_authority_owner','MEMBER') THEN
    GRANT reviewrouter_authority_owner TO reviewrouter_migration_broker
      WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles
                  WHERE rolname='reviewrouter_migration_issuer') THEN
    RAISE EXCEPTION 'reviewrouter_migration_issuer must be provisioned before credential bootstrap';
  END IF;
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
  IF EXISTS (SELECT 1 FROM reviewrouter_migration_credential.lease
             WHERE state IN ('issued','consumed') AND expires_at>now_at) THEN
    RAISE EXCEPTION 'migration credential lease already active';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles
             WHERE rolname=p_input->>'loginRole') THEN
    RAISE EXCEPTION 'migration credential login role already exists';
  END IF;
  EXECUTE pg_catalog.format(
    'CREATE ROLE %I LOGIN PASSWORD %L CONNECTION LIMIT 1 VALID UNTIL %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',
    p_input->>'loginRole',raw_password,now_at+interval '10 minutes');
  EXECUTE pg_catalog.format('GRANT CONNECT ON DATABASE %I TO %I',
    current_database(),p_input->>'loginRole');
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
  EXECUTE pg_catalog.format('REVOKE reviewrouter_authority_owner FROM %I',active.login_role);
  UPDATE reviewrouter_migration_credential.lease SET state='finalized',finalized_at=now_at
    WHERE lease_id=active.lease_id;
  RETURN true;
END $body$;

CREATE FUNCTION reviewrouter_migration_credential.reconcile()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $body$
DECLARE item reviewrouter_migration_credential.lease%ROWTYPE;
DECLARE reconciled integer := 0;
BEGIN
  IF session_user IS DISTINCT FROM 'reviewrouter_migration_issuer' THEN
    RAISE EXCEPTION 'migration credential reconcile caller invalid';
  END IF;
  FOR item IN SELECT * FROM reviewrouter_migration_credential.lease
    WHERE state IN ('issued','consumed') AND expires_at<=clock_timestamp() FOR UPDATE
  LOOP
    EXECUTE pg_catalog.format('ALTER ROLE %I NOLOGIN PASSWORD NULL',item.login_role);
    EXECUTE pg_catalog.format('REVOKE reviewrouter_authority_owner FROM %I',item.login_role);
    UPDATE reviewrouter_migration_credential.lease SET state='reconciled',
      finalized_at=date_trunc('milliseconds',clock_timestamp()) WHERE lease_id=item.lease_id;
    reconciled := reconciled+1;
  END LOOP;
  RETURN reconciled;
END $body$;

REVOKE ALL ON ALL TABLES IN SCHEMA reviewrouter_migration_credential FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA reviewrouter_migration_credential FROM PUBLIC;
GRANT USAGE ON SCHEMA reviewrouter_migration_credential TO reviewrouter_migration_issuer;
GRANT EXECUTE ON FUNCTION reviewrouter_migration_credential.issue(jsonb)
  TO reviewrouter_migration_issuer;
GRANT EXECUTE ON FUNCTION reviewrouter_migration_credential.reconcile()
  TO reviewrouter_migration_issuer;
GRANT USAGE ON SCHEMA reviewrouter_migration_credential
  TO reviewrouter_authority_owner;
GRANT EXECUTE ON FUNCTION reviewrouter_migration_credential.membership_is_active(name,name)
  TO reviewrouter_authority_owner;
GRANT EXECUTE ON FUNCTION reviewrouter_migration_credential.active(text,text,text,integer,text)
  TO reviewrouter_authority_owner;
GRANT USAGE ON SCHEMA reviewrouter_migration_credential
  TO reviewrouter_release_control,reviewrouter_provider_authority,
     reviewrouter_release_witness;
GRANT EXECUTE ON FUNCTION reviewrouter_migration_credential.membership_is_active(name,name)
  TO reviewrouter_release_control,reviewrouter_provider_authority,
     reviewrouter_release_witness;

RESET ROLE;

DO $transfer_authority_ownership$
DECLARE object record;
DECLARE bootstrap_role name := current_user;
BEGIN
  ALTER SCHEMA release_authority OWNER TO reviewrouter_authority_owner;
  FOR object IN SELECT c.relkind,c.relname FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='release_authority' AND c.relkind IN ('r','p','v','m','f')
  LOOP
    EXECUTE pg_catalog.format('ALTER %s release_authority.%I OWNER TO reviewrouter_authority_owner',
      CASE object.relkind WHEN 'v' THEN 'VIEW'
        WHEN 'm' THEN 'MATERIALIZED VIEW' WHEN 'f' THEN 'FOREIGN TABLE' ELSE 'TABLE' END,
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
  EXECUTE pg_catalog.format('ALTER ROLE %I PASSWORD NULL',bootstrap_role);
END
$transfer_authority_ownership$;

SET ROLE reviewrouter_authority_owner;

DO $schema_version_marker$
DECLARE marker jsonb := coalesce(pg_catalog.obj_description(
  'release_authority'::pg_catalog.regnamespace,'pg_namespace')::jsonb,'{}'::jsonb);
BEGIN
  EXECUTE pg_catalog.format('COMMENT ON SCHEMA release_authority IS %L',
    (marker||pg_catalog.jsonb_build_object('schemaVersion',15))::text);
END
$schema_version_marker$;

COMMIT;
