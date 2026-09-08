-- Trusted ingestion custody, not hashes, authenticates these retained observations.
-- No family/source FK: admission precedes family creation and sources may expire.
-- Fresh PG17: nonsuperuser CREATEROLE + public schema ownership suffices.
-- Existing cluster-wide proof owner reuse requires explicit ADMIN (superuser here);
-- fail before mutation otherwise. Never borrow the sealed 000098 owner.
BEGIN;
SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '5min';
DO $roles$
DECLARE r text;
BEGIN
  IF current_user <> session_user THEN RAISE EXCEPTION 'proof_fact_session_precondition'; END IF;
  FOREACH r IN ARRAY ARRAY['reviewrouter_certified_fork_fact_owner','reviewrouter_certified_fork_writer','reviewrouter_certified_fork_reader'] LOOP
    IF r <> 'reviewrouter_certified_fork_fact_owner' AND NOT EXISTS (SELECT FROM pg_roles WHERE rolname=r) THEN
      RAISE EXCEPTION 'proof_fact_requires_000098';
    END IF;
    IF EXISTS (SELECT FROM pg_roles WHERE rolname=r AND
      (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolreplication OR rolbypassrls)) OR
      EXISTS (SELECT FROM pg_auth_members WHERE roleid=(SELECT oid FROM pg_roles WHERE rolname=r)
        OR member=(SELECT oid FROM pg_roles WHERE rolname=r)) THEN
      RAISE EXCEPTION 'proof_fact_unsafe_role: %', r;
    END IF;
    IF EXISTS (SELECT FROM pg_database WHERE datname=current_database() AND datdba=(SELECT oid FROM pg_roles WHERE rolname=r)) OR
      EXISTS (SELECT FROM pg_namespace WHERE nspname='public' AND nspowner=(SELECT oid FROM pg_roles WHERE rolname=r)) THEN
      RAISE EXCEPTION 'proof_fact_owner_scope';
    END IF;
  END LOOP;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname='reviewrouter_certified_fork_fact_owner') AND
    NOT (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) THEN
    RAISE EXCEPTION 'proof_fact_existing_owner_admin_precondition';
  END IF;
  CREATE ROLE reviewrouter_certified_fork_fact_creator NOLOGIN NOSUPERUSER NOCREATEDB CREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  EXECUTE format('GRANT reviewrouter_certified_fork_fact_creator TO %I WITH INHERIT FALSE, SET TRUE GRANTED BY %I',current_user,current_user);
  IF EXISTS (SELECT FROM pg_roles WHERE rolname='reviewrouter_certified_fork_fact_owner') THEN
    EXECUTE format('GRANT reviewrouter_certified_fork_fact_owner TO reviewrouter_certified_fork_fact_creator WITH ADMIN TRUE, INHERIT FALSE, SET TRUE GRANTED BY %I',current_user);
  END IF;
END $roles$;
SET LOCAL ROLE reviewrouter_certified_fork_fact_creator;
DO $owner$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='reviewrouter_certified_fork_fact_owner') THEN
    CREATE ROLE reviewrouter_certified_fork_fact_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
  EXECUTE format('GRANT reviewrouter_certified_fork_fact_owner TO %I WITH ADMIN FALSE, INHERIT FALSE, SET TRUE GRANTED BY %I',session_user,current_user);
END $owner$;
RESET ROLE;
GRANT USAGE, CREATE ON SCHEMA public TO reviewrouter_certified_fork_fact_owner;
SET LOCAL ROLE reviewrouter_certified_fork_fact_owner;

-- Length-prefixed UTF8 fields are unambiguous even with delimiters/unicode.
CREATE FUNCTION public.certified_fork_fact_identity(parts text[]) RETURNS bytea
LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog AS $body$
 SELECT sha256(convert_to(string_agg(octet_length(v)::text || ':' || v,'' ORDER BY n),'UTF8'))
 FROM unnest(parts) WITH ORDINALITY AS t(v,n)
$body$;
CREATE TABLE public."CertifiedForkProofFact" (
 "proofSha256" bytea PRIMARY KEY CHECK (octet_length("proofSha256")=32),
 "sourceSha256" bytea NOT NULL UNIQUE CHECK (octet_length("sourceSha256")=32),
 "proofId" text NOT NULL CHECK (octet_length("proofId") BETWEEN 1 AND 4096),
 "formatVersion" integer NOT NULL CHECK ("formatVersion"=1),
 "kind" text NOT NULL CHECK ("kind" IN ('admission','authority','evidence','inventory','output','command')),
 "workspaceId" text NOT NULL CHECK (octet_length("workspaceId") BETWEEN 1 AND 4096),
 "repositoryConnectionId" text NOT NULL CHECK (octet_length("repositoryConnectionId") BETWEEN 1 AND 4096),
 "familyKey" text NOT NULL CHECK ("familyKey" ~ '^[a-f0-9]{64}$'),
 "reviewHash" text NOT NULL CHECK ("reviewHash" ~ '^[a-f0-9]{64}$'),
 "producerKind" text NOT NULL CHECK (octet_length("producerKind") BETWEEN 1 AND 4096),
 "producerId" text NOT NULL CHECK (octet_length("producerId") BETWEEN 1 AND 4096),
 "producerVersion" text NOT NULL CHECK (octet_length("producerVersion") BETWEEN 1 AND 4096),
 "sourceKey" text NOT NULL CHECK (octet_length("sourceKey") BETWEEN 1 AND 1048576),
 "sourceRevision" text NOT NULL CHECK (octet_length("sourceRevision") BETWEEN 1 AND 1048576),
 "observedAtMs" bigint NOT NULL CHECK ("observedAtMs" BETWEEN 1 AND 9007199254740991),
 "validUntilMs" bigint CHECK ("validUntilMs" BETWEEN "observedAtMs" AND 9007199254740991),
 "payload" jsonb NOT NULL CHECK (jsonb_typeof("payload")='object'),
 "canonicalBytes" text NOT NULL CHECK (octet_length("canonicalBytes") BETWEEN 2 AND 8388608),
 "payloadHash" text NOT NULL CHECK ("payloadHash" ~ '^[a-f0-9]{64}$'),
 "createdAtMs" bigint NOT NULL DEFAULT (floor(extract(epoch FROM clock_timestamp())*1000)::bigint)
   CHECK ("createdAtMs" BETWEEN 1 AND 9007199254740991),
 CHECK ("canonicalBytes"::jsonb="payload"),
 CHECK ("payloadHash"=encode(sha256(convert_to("canonicalBytes",'UTF8')),'hex')),
 CHECK ("proofSha256"=sha256(convert_to("proofId",'UTF8')))
);
-- SECURITY DEFINER only for private trigger/check helpers. No callable write API.
CREATE FUNCTION public.certified_fork_fact_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $body$
BEGIN
 IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'proof_fact_immutable'; END IF;
 IF NEW."sourceSha256" <> public.certified_fork_fact_identity(ARRAY[
   'certified-fork-fact-source-v1',NEW."kind",NEW."producerKind",NEW."producerId",NEW."sourceKey",NEW."sourceRevision"]) THEN
   RAISE EXCEPTION 'proof_fact_source_digest';
 END IF;
 -- Ignore caller supplied storage time; replay compares the original row.
 NEW."createdAtMs" := floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
 RETURN NEW;
END $body$;
CREATE TRIGGER certified_fork_fact_guard BEFORE INSERT OR UPDATE OR DELETE ON public."CertifiedForkProofFact"
 FOR EACH ROW EXECUTE FUNCTION public.certified_fork_fact_guard();
CREATE TRIGGER certified_fork_fact_no_truncate BEFORE TRUNCATE ON public."CertifiedForkProofFact"
 FOR EACH STATEMENT EXECUTE FUNCTION public.certified_fork_fact_guard();
DO $acl$
DECLARE a record; f text;
BEGIN
 FOR a IN SELECT DISTINCT x.grantee FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) x
   WHERE c.oid='public."CertifiedForkProofFact"'::regclass AND x.grantee<>c.relowner LOOP
   EXECUTE format('REVOKE ALL ON public."CertifiedForkProofFact" FROM %s CASCADE',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(a.grantee)) END);
 END LOOP;
 REVOKE ALL ON public."CertifiedForkProofFact" FROM PUBLIC;
 FOREACH f IN ARRAY ARRAY['certified_fork_fact_guard()','certified_fork_fact_identity(text[])'] LOOP
   FOR a IN SELECT DISTINCT x.grantee FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) x
     WHERE p.oid=('public.'||f)::regprocedure AND x.grantee<>p.proowner LOOP
     EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM %s CASCADE',f,CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(a.grantee)) END);
   END LOOP;
   EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC',f);
 END LOOP;
END $acl$;
GRANT SELECT, INSERT ON public."CertifiedForkProofFact" TO reviewrouter_certified_fork_writer;
GRANT SELECT ON public."CertifiedForkProofFact" TO reviewrouter_certified_fork_reader;
RESET ROLE;
GRANT USAGE ON SCHEMA public TO reviewrouter_certified_fork_writer, reviewrouter_certified_fork_reader;
REVOKE CREATE ON SCHEMA public FROM reviewrouter_certified_fork_fact_owner;
SET LOCAL ROLE reviewrouter_certified_fork_fact_creator;
DO $cleanup$
BEGIN
 EXECUTE format('REVOKE reviewrouter_certified_fork_fact_owner FROM %I GRANTED BY %I RESTRICT',session_user,current_user);
END $cleanup$;
RESET ROLE;
DROP ROLE reviewrouter_certified_fork_fact_creator;
DO $verify$
BEGIN
 IF EXISTS (SELECT FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.roleid OR r.oid=m.member
   WHERE r.rolname IN ('reviewrouter_certified_fork_fact_owner','reviewrouter_certified_fork_writer','reviewrouter_certified_fork_reader')) THEN
   RAISE EXCEPTION 'proof_fact_membership_cleanup';
 END IF;
END $verify$;
COMMIT;
