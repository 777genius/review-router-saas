-- Committed archive integrity only. The trusted proof adapter authenticates capabilities.
-- Deployment precondition: a trusted schema deploy owner with CREATEROLE and
-- ownership of public (or its grant option). Never run as general app credentials.
-- No runtime login membership is installed. Provision writer/reader custody separately.
-- PG17 creator ADMIN grants belong to the bootstrap superuser and cannot be
-- revoked by a CREATEROLE creator. Use a disposable creator, then drop it.
-- Its name is reserved; collisions and existing archive memberships fail closed.
BEGIN;
SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '5min';
DO $roles$
DECLARE r text;
BEGIN
  IF current_user <> session_user THEN RAISE EXCEPTION 'certified_fork_deployer_session_precondition'; END IF;
  -- Roles are cluster-wide. Validate every preexisting role under the original
  -- deployer BEFORE creating the helper or installing any temporary membership.
  FOREACH r IN ARRAY ARRAY['reviewrouter_certified_fork_owner', 'reviewrouter_certified_fork_writer', 'reviewrouter_certified_fork_reader'] LOOP
    IF EXISTS (SELECT FROM pg_auth_members m JOIN pg_roles p ON p.oid=m.roleid
      WHERE p.rolname=r) THEN
      RAISE EXCEPTION 'certified_fork_existing_membership: %', r;
    END IF;
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = r AND
      (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR rolinherit)) THEN
      RAISE EXCEPTION 'certified_fork_unsafe_role: %', r;
    END IF;
    IF EXISTS (SELECT FROM pg_auth_members m JOIN pg_roles p ON p.oid=m.member
      WHERE p.rolname=r) THEN
      RAISE EXCEPTION 'certified_fork_role_membership_precondition: %', r;
    END IF;
    IF EXISTS (SELECT FROM pg_database WHERE datname=current_database()
      AND datdba=(SELECT oid FROM pg_roles WHERE rolname=r)) OR EXISTS
      (SELECT FROM pg_namespace WHERE nspname='public' AND nspowner=(SELECT oid FROM pg_roles WHERE rolname=r)) THEN
      RAISE EXCEPTION 'certified_fork_schema_owner_precondition: %', r;
    END IF;
  END LOOP;
  -- With all prior memberships forbidden, only a superuser has legitimate
  -- ADMIN authority on an existing owner. CREATEROLE alone does not confer it.
  -- Fresh non-superuser deployment still obtains ADMIN through helper creation.
  IF EXISTS (SELECT FROM pg_roles WHERE rolname='reviewrouter_certified_fork_owner')
    AND NOT (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) THEN
    RAISE EXCEPTION 'certified_fork_existing_owner_admin_precondition';
  END IF;
  CREATE ROLE reviewrouter_certified_fork_creator NOLOGIN NOSUPERUSER NOCREATEDB CREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  EXECUTE format('GRANT reviewrouter_certified_fork_creator TO %I WITH INHERIT FALSE, SET TRUE GRANTED BY %I', current_user, current_user);
  IF EXISTS (SELECT FROM pg_roles WHERE rolname='reviewrouter_certified_fork_owner') THEN
    EXECUTE format('GRANT reviewrouter_certified_fork_owner TO reviewrouter_certified_fork_creator WITH ADMIN TRUE, INHERIT FALSE, SET TRUE GRANTED BY %I', current_user);
  END IF;
END $roles$;
SET LOCAL ROLE reviewrouter_certified_fork_creator;
DO $roles$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['reviewrouter_certified_fork_owner', 'reviewrouter_certified_fork_writer', 'reviewrouter_certified_fork_reader'] LOOP
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS', r);
    END IF;
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = r AND
      (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR rolinherit)) THEN
      RAISE EXCEPTION 'certified_fork_unsafe_role: %', r;
    END IF;
    IF EXISTS (SELECT FROM pg_database WHERE datname=current_database()
      AND datdba=(SELECT oid FROM pg_roles WHERE rolname=r)) OR EXISTS
      (SELECT FROM pg_namespace WHERE nspname='public' AND nspowner=(SELECT oid FROM pg_roles WHERE rolname=r)) THEN
      RAISE EXCEPTION 'certified_fork_schema_owner_precondition: %', r;
    END IF;
    -- Only the disposable creator's automatic ADMIN or the validated deployer's
    -- temporary owner ADMIN membership is accepted; no runtime edge is allowed.
    -- DROP ROLE removes that edge without impersonating its grantor.
    IF EXISTS (SELECT FROM pg_auth_members m JOIN pg_roles p ON p.oid=m.roleid
      WHERE m.member=(SELECT oid FROM pg_roles WHERE rolname=r)) OR EXISTS
      (SELECT FROM pg_auth_members m WHERE m.roleid=(SELECT oid FROM pg_roles WHERE rolname=r)
       AND (m.member<>(SELECT oid FROM pg_roles WHERE rolname=current_user)
         OR NOT m.admin_option OR m.inherit_option)) THEN
      RAISE EXCEPTION 'certified_fork_role_membership_precondition: %', r;
    END IF;
  END LOOP;
  EXECUTE format('GRANT reviewrouter_certified_fork_owner TO %I WITH ADMIN FALSE, INHERIT FALSE, SET TRUE GRANTED BY %I', session_user, current_user);
END $roles$;
RESET ROLE;
GRANT USAGE, CREATE ON SCHEMA public TO reviewrouter_certified_fork_owner;
SET LOCAL ROLE reviewrouter_certified_fork_owner;

CREATE TABLE public."CertifiedForkFamily" (
  "familyKey" text NOT NULL CHECK ("familyKey" ~ '^[a-f0-9]{64}$'),
  "tipVersion" bigint NOT NULL CHECK ("tipVersion" BETWEEN 0 AND 999999999999999999),
  PRIMARY KEY ("familyKey"),
  CHECK ("tipVersion" >= 1)
);

CREATE TABLE public."CertifiedForkVersion" (
  "familyKey" text NOT NULL CHECK ("familyKey" ~ '^[a-f0-9]{64}$'),
  "version" bigint NOT NULL CHECK ("version" BETWEEN 0 AND 999999999999999999),
  "formatVersion" integer NOT NULL,
  "reviewHash" text NOT NULL CHECK ("reviewHash" ~ '^[a-f0-9]{64}$'),
  "generation" bigint NOT NULL CHECK ("generation" BETWEEN 0 AND 999999999999999999),
  "seed" jsonb NOT NULL,
  "admissionProof" text NOT NULL CHECK (length("admissionProof") BETWEEN 1 AND 4096),
  "fence" bigint NOT NULL CHECK ("fence" BETWEEN 0 AND 999999999999999999),
  "claimOwnerHash" text CHECK ("claimOwnerHash" ~ '^[a-f0-9]{64}$'),
  "claimHash" text CHECK ("claimHash" ~ '^[a-f0-9]{64}$'),
  "claimEpoch" bigint CHECK ("claimEpoch" BETWEEN 0 AND 999999999999999999),
  "claimExpiresAtMs" bigint CHECK ("claimExpiresAtMs" BETWEEN 1 AND 9007199254740991),
  "events" jsonb NOT NULL,
  "ledgerHash" text NOT NULL CHECK ("ledgerHash" ~ '^[a-f0-9]{64}$'),
  "outcomeHash" text CHECK ("outcomeHash" ~ '^[a-f0-9]{64}$'),
  "revisions" jsonb NOT NULL,
  "committedAtMs" bigint NOT NULL CHECK ("committedAtMs" BETWEEN 1 AND 9007199254740991),
  PRIMARY KEY ("familyKey", "version"),
  UNIQUE ("familyKey", "version", "reviewHash"),
  CHECK ("version" >= 1 AND "fence" >= 1 AND "formatVersion" = 1),
  CHECK ((num_nonnulls("claimOwnerHash", "claimHash", "claimEpoch", "claimExpiresAtMs") = 0)
    OR (num_nonnulls("claimOwnerHash", "claimHash", "claimEpoch", "claimExpiresAtMs") = 4 AND "claimEpoch" = "fence")),
  CHECK ((jsonb_typeof("seed") = 'object' AND jsonb_typeof("seed"->'facts') = 'object'
    AND "seed"->'facts'->'generation' = to_jsonb("generation"::text)
    AND "seed" ?& ARRAY['facts','bindingHash','admissionHash','predecessor']) IS TRUE),
  CHECK (jsonb_typeof("events") = 'array' AND jsonb_typeof("revisions") = 'array')
);

CREATE TABLE public."CertifiedForkReceipt" (
  "familyKey" text NOT NULL CHECK ("familyKey" ~ '^[a-f0-9]{64}$'),
  "commandId" varchar(64) NOT NULL CHECK ("commandId" ~ '^[A-Za-z0-9_-]{1,64}$'),
  "commandHash" text NOT NULL CHECK ("commandHash" ~ '^[a-f0-9]{64}$'),
  "ownerHash" text NOT NULL CHECK ("ownerHash" ~ '^[a-f0-9]{64}$'),
  "reviewHash" text NOT NULL CHECK ("reviewHash" ~ '^[a-f0-9]{64}$'),
  "version" bigint NOT NULL CHECK ("version" BETWEEN 0 AND 999999999999999999),
  "operation" text NOT NULL,
  PRIMARY KEY ("familyKey", "commandId"),
  UNIQUE ("familyKey", "version"),
  UNIQUE ("familyKey", "version", "reviewHash", "commandId", "commandHash"),
  CHECK ("version" >= 1 AND "operation" IN ('acquireClaim','renewClaim','releaseClaim','compareAndCommit'))
);

CREATE TABLE public."CertifiedForkCheckpoint" (
  "familyKey" text NOT NULL CHECK ("familyKey" ~ '^[a-f0-9]{64}$'),
  "version" bigint NOT NULL CHECK ("version" BETWEEN 0 AND 999999999999999999),
  "reviewHash" text NOT NULL CHECK ("reviewHash" ~ '^[a-f0-9]{64}$'),
  "proof" text NOT NULL CHECK (length("proof") BETWEEN 1 AND 4096),
  "proofSha256" bytea NOT NULL,
  CONSTRAINT "CertifiedForkCheckpoint_proofSha256_check" CHECK (
    pg_catalog.octet_length("proofSha256") = 32 AND
    "proofSha256" = pg_catalog.sha256(pg_catalog.convert_to("proof", 'UTF8'))),
  "formatVersion" integer NOT NULL,
  "prefixLength" integer NOT NULL,
  "prefixHash" text NOT NULL CHECK ("prefixHash" ~ '^[a-f0-9]{64}$'),
  "anchorHash" text NOT NULL CHECK ("anchorHash" ~ '^[a-f0-9]{64}$'),
  "positionCommandId" varchar(64) NOT NULL CHECK ("positionCommandId" ~ '^[A-Za-z0-9_-]{1,64}$'),
  "positionCommandHash" text NOT NULL CHECK ("positionCommandHash" ~ '^[a-f0-9]{64}$'),
  "state" jsonb NOT NULL,
  PRIMARY KEY ("familyKey", "version"),
  CHECK ("version" >= 1 AND "formatVersion" = 1 AND "prefixLength" >= 0),
  CHECK ((jsonb_typeof("state") = 'object' AND jsonb_typeof("state"->'review') = 'object'
    AND jsonb_typeof("state"->'states') = 'array' AND "state" ?& ARRAY['review','states','inventory','outcome']) IS TRUE)
);
-- A fixed 32-byte stored key preserves the full 1..4096-character opaque token.
-- The repository supplies this untrusted digest; the CHECK binds it to UTF8 bytes.
-- convert_to is STABLE: allowed in CHECK, not an index expression/generated column.
-- Digest collisions fail closed as unique violations, atomically rejecting the command.
-- Readers must query proofSha256 AND exact full token UTF8 bytes, then authenticate
-- the capability separately. Digest knowledge/equality supplies no authority.
CREATE UNIQUE INDEX "CertifiedForkCheckpoint_proof_sha256_key"
  ON public."CertifiedForkCheckpoint" ("proofSha256");

ALTER TABLE public."CertifiedForkFamily" ADD CONSTRAINT "CertifiedForkFamily_tip_fkey"
  FOREIGN KEY ("familyKey", "tipVersion") REFERENCES public."CertifiedForkVersion" ("familyKey", "version")
  ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE public."CertifiedForkVersion" ADD CONSTRAINT "CertifiedForkVersion_family_fkey"
  FOREIGN KEY ("familyKey") REFERENCES public."CertifiedForkFamily" ("familyKey")
  ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE public."CertifiedForkVersion" ADD CONSTRAINT "CertifiedForkVersion_checkpoint_fkey"
  FOREIGN KEY ("familyKey", "version") REFERENCES public."CertifiedForkCheckpoint" ("familyKey", "version")
  ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE public."CertifiedForkReceipt" ADD CONSTRAINT "CertifiedForkReceipt_version_fkey"
  FOREIGN KEY ("familyKey", "version", "reviewHash") REFERENCES public."CertifiedForkVersion" ("familyKey", "version", "reviewHash")
  ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE public."CertifiedForkCheckpoint" ADD CONSTRAINT "CertifiedForkCheckpoint_version_fkey"
  FOREIGN KEY ("familyKey", "version", "reviewHash") REFERENCES public."CertifiedForkVersion" ("familyKey", "version", "reviewHash")
  ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE public."CertifiedForkCheckpoint" ADD CONSTRAINT "CertifiedForkCheckpoint_receipt_fkey"
  FOREIGN KEY ("familyKey", "version", "reviewHash", "positionCommandId", "positionCommandHash") REFERENCES public."CertifiedForkReceipt" ("familyKey", "version", "reviewHash", "commandId", "commandHash")
  ON DELETE NO ACTION ON UPDATE NO ACTION;

-- Invoker functions need only the writer's SELECT/column UPDATE privileges.
-- They confer no capability and perform no hash-only authentication.
CREATE FUNCTION public.certified_fork_append_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $guard$
DECLARE tip bigint;
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') OR
     (TG_OP = 'UPDATE' AND TG_TABLE_NAME <> 'CertifiedForkFamily') THEN
    RAISE EXCEPTION 'certified_fork_immutable';
  END IF;
  IF TG_TABLE_NAME = 'CertifiedForkFamily' THEN
    IF TG_OP = 'INSERT' AND NEW."tipVersion" <> 1 THEN
      RAISE EXCEPTION 'certified_fork_initial_tip';
    ELSIF TG_OP = 'UPDATE' AND
      (NEW."familyKey" IS DISTINCT FROM OLD."familyKey" OR NEW."tipVersion" <> OLD."tipVersion" + 1) THEN
      RAISE EXCEPTION 'certified_fork_tip_progression';
    END IF;
  ELSIF TG_TABLE_NAME = 'CertifiedForkVersion' THEN
    -- Exact PK lock serializes existing families; the family's PK serializes
    -- competing first insertion. The adapter still dedupes before building.
    SELECT "tipVersion" INTO STRICT tip FROM public."CertifiedForkFamily"
      WHERE "familyKey" = NEW."familyKey" FOR UPDATE;
    IF NEW."version" <> tip + 1 AND NOT (NEW."version" = 1 AND tip = 1) THEN
      RAISE EXCEPTION 'certified_fork_version_progression';
    END IF;
  END IF;
  RETURN NEW;
END $guard$;

CREATE FUNCTION public.certified_fork_complete_version() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $complete$
DECLARE
  v public."CertifiedForkVersion"%ROWTYPE;
  p public."CertifiedForkVersion"%ROWTYPE;
  r public."CertifiedForkReceipt"%ROWTYPE;
  c public."CertifiedForkCheckpoint"%ROWTYPE;
  item jsonb; expected_revisions jsonb; previous_at bigint := 0; event_at bigint;
BEGIN
  SELECT * INTO STRICT v FROM public."CertifiedForkVersion"
    WHERE "familyKey"=NEW."familyKey" AND "version"=NEW."version";
  SELECT * INTO STRICT r FROM public."CertifiedForkReceipt"
    WHERE "familyKey"=v."familyKey" AND "version"=v."version";
  SELECT * INTO STRICT c FROM public."CertifiedForkCheckpoint"
    WHERE "familyKey"=v."familyKey" AND "version"=v."version";
  IF (SELECT "tipVersion" FROM public."CertifiedForkFamily" WHERE "familyKey"=v."familyKey")
     <> (SELECT max("version") FROM public."CertifiedForkVersion" WHERE "familyKey"=v."familyKey") THEN
    RAISE EXCEPTION 'certified_fork_tip_incomplete';
  END IF;
  IF (c."prefixLength" = jsonb_array_length(v."events")
      AND c."state"->'review'->'facts' = v."seed"->'facts'
      AND c."state"->'review'->>'familyKey' = v."familyKey"
      AND c."state"->'review'->'bindingHash' = v."seed"->'bindingHash'
      AND c."state"->'review'->'admissionHash' = v."seed"->'admissionHash'
      AND jsonb_typeof(c."state"->'review'->'logicalKey') = 'string'
      AND (c."state"->'review'->>'logicalKey') ~ '^[a-f0-9]{64}$'
      AND (c."state"->'outcome' = 'null'::jsonb OR jsonb_typeof(c."state"->'outcome') = 'object')
      AND (c."state"->'inventory' = 'null'::jsonb OR jsonb_typeof(c."state"->'inventory') = 'object')
      AND (c."state"->'outcome'->>'outcomeHash') IS NOT DISTINCT FROM v."outcomeHash") IS NOT TRUE THEN
    RAISE EXCEPTION 'certified_fork_checkpoint_consistency';
  END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(c."state"->'states') LOOP
    IF (jsonb_typeof(item) = 'object'
        AND item ?& ARRAY['request','revision','authority','attempts','stops','sealed','integrityHold','inventoryHash']
        AND jsonb_typeof(item->'request') = 'object'
        AND item->'request'->'review' = c."state"->'review'
        AND jsonb_typeof(item->'authority') = 'object'
        AND jsonb_typeof(item->'attempts') = 'array'
        AND jsonb_typeof(item->'stops') = 'array'
        AND jsonb_typeof(item->'sealed') = 'boolean'
        AND jsonb_typeof(item->'integrityHold') = 'boolean'
        AND jsonb_typeof(item->'revision') = 'string'
        AND (item->>'revision') ~ '^(0|[1-9][0-9]{0,17})$'
        AND (item->'request'->'effect'->>'effectKey') ~ '^[a-f0-9]{64}$') IS NOT TRUE THEN
      RAISE EXCEPTION 'certified_fork_state_shape';
    END IF;
  END LOOP;
  SELECT coalesce(jsonb_agg(jsonb_build_object('effectKey', value->'request'->'effect'->>'effectKey',
    'revision', value->>'revision') ORDER BY (value->'request'->'effect'->>'effectKey') COLLATE "C"), '[]'::jsonb)
    INTO expected_revisions FROM jsonb_array_elements(c."state"->'states');
  IF v."revisions" <> expected_revisions OR
     (SELECT count(*) <> count(DISTINCT value->'request'->'effect'->>'effectKey')
       FROM jsonb_array_elements(c."state"->'states')) THEN
    RAISE EXCEPTION 'certified_fork_comparison_membership';
  END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(v."events") LOOP
    IF (jsonb_typeof(item) = 'object' AND item ?& ARRAY['at','authorityProof','input']
        AND jsonb_typeof(item->'at') = 'number' AND (item->>'at') ~ '^[1-9][0-9]{0,15}$'
        AND (item->'authorityProof' = 'null'::jsonb OR
          (jsonb_typeof(item->'authorityProof') = 'string' AND length(item->>'authorityProof') BETWEEN 1 AND 4096))
        AND jsonb_typeof(item->'input') = 'object'
        AND item->'input'->>'kind' IN ('prepare','begin','retry','seal','stop','evidence','inventory','outcome')) IS NOT TRUE THEN
      RAISE EXCEPTION 'certified_fork_event_shape';
    END IF;
    event_at := (item->>'at')::bigint;
    IF event_at < previous_at OR event_at > v."committedAtMs" THEN
      RAISE EXCEPTION 'certified_fork_event_time';
    END IF;
    previous_at := event_at;
  END LOOP;
  IF v."version" = 1 THEN
    IF r."operation" <> 'acquireClaim' OR v."fence" <> 1 OR v."generation" <> 0 THEN
      RAISE EXCEPTION 'certified_fork_initial_acquire';
    END IF;
  ELSE
    SELECT * INTO STRICT p FROM public."CertifiedForkVersion"
      WHERE "familyKey"=v."familyKey" AND "version"=v."version"-1;
    IF v."committedAtMs" < p."committedAtMs" OR
       v."generation" NOT BETWEEN p."generation" AND p."generation"+1 OR
       (v."generation" = p."generation" AND (v."reviewHash" <> p."reviewHash" OR v."seed" <> p."seed")) OR
       (v."generation" <> p."generation" AND r."operation" <> 'acquireClaim') THEN
      RAISE EXCEPTION 'certified_fork_history_progression';
    END IF;
    IF v."generation" = p."generation" AND
       (SELECT coalesce(jsonb_agg(value ORDER BY ord), '[]'::jsonb)
        FROM jsonb_array_elements(v."events") WITH ORDINALITY e(value,ord)
        WHERE ord <= jsonb_array_length(p."events")) <> p."events" THEN
      RAISE EXCEPTION 'certified_fork_event_prefix';
    END IF;
    IF EXISTS (SELECT FROM jsonb_array_elements(v."events") WITH ORDINALITY e(value,ord)
      WHERE (v."generation" <> p."generation" OR ord > jsonb_array_length(p."events"))
      AND (value->>'at')::bigint < p."committedAtMs") THEN
      RAISE EXCEPTION 'certified_fork_appended_event_time';
    END IF;
  END IF;
  IF r."operation" = 'acquireClaim' THEN
    IF v."claimOwnerHash" IS NULL OR r."ownerHash" <> v."claimOwnerHash" OR
       v."claimExpiresAtMs" <= v."committedAtMs" OR v."fence" <> coalesce(p."fence",0)+1 OR
       p."claimExpiresAtMs" > v."committedAtMs" THEN
      RAISE EXCEPTION 'certified_fork_acquire_claim';
    END IF;
  ELSE
    IF p."claimOwnerHash" IS NULL OR r."ownerHash" <> p."claimOwnerHash" OR
       p."claimExpiresAtMs" <= v."committedAtMs" OR v."fence" <> p."fence" OR
       v."reviewHash" <> p."reviewHash" THEN
      RAISE EXCEPTION 'certified_fork_original_owner';
    END IF;
    IF r."operation" = 'releaseClaim' THEN
      IF v."claimOwnerHash" IS NOT NULL THEN RAISE EXCEPTION 'certified_fork_release_claim'; END IF;
    ELSIF v."claimOwnerHash" IS DISTINCT FROM p."claimOwnerHash" OR
          v."claimHash" IS DISTINCT FROM p."claimHash" OR
          v."claimEpoch" IS DISTINCT FROM p."claimEpoch" OR
          v."claimExpiresAtMs" IS NULL OR v."claimExpiresAtMs" < p."claimExpiresAtMs" OR
          (r."operation" = 'compareAndCommit' AND v."claimExpiresAtMs" <> p."claimExpiresAtMs") THEN
      RAISE EXCEPTION 'certified_fork_preserved_claim';
    END IF;
  END IF;
  RETURN NULL;
END $complete$;

DO $install$
DECLARE t text; a record; f text;
BEGIN
  FOREACH t IN ARRAY ARRAY['CertifiedForkFamily','CertifiedForkVersion','CertifiedForkReceipt','CertifiedForkCheckpoint'] LOOP
    EXECUTE format('CREATE TRIGGER certified_fork_immutable BEFORE UPDATE OR DELETE OR INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION public.certified_fork_append_guard()', t);
    EXECUTE format('CREATE TRIGGER certified_fork_no_truncate BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.certified_fork_append_guard()', t);
    -- Scrub every actual creator/default ACL grantee on these new objects only.
    -- Revoking direct grants to every grantee also closes inherited grant paths.
    FOR a IN SELECT DISTINCT x.grantee FROM pg_class c
      CROSS JOIN LATERAL aclexplode(c.relacl) x
      WHERE c.oid=format('public.%I',t)::regclass AND x.grantee<>c.relowner LOOP
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %s CASCADE', t,
        CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(a.grantee)) END);
    END LOOP;
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', t);
    EXECUTE format('GRANT SELECT, INSERT ON TABLE public.%I TO reviewrouter_certified_fork_writer', t);
    EXECUTE format('GRANT SELECT ON TABLE public.%I TO reviewrouter_certified_fork_reader', t);
  END LOOP;
  FOREACH f IN ARRAY ARRAY['certified_fork_append_guard','certified_fork_complete_version'] LOOP
    FOR a IN SELECT DISTINCT x.grantee FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) x
      WHERE p.oid=format('public.%I()',f)::regprocedure AND x.grantee<>p.proowner LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION public.%I() FROM %s CASCADE', f,
        CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(a.grantee)) END);
    END LOOP;
    EXECUTE format('REVOKE ALL ON FUNCTION public.%I() FROM PUBLIC', f);
  END LOOP;
END $install$;
CREATE CONSTRAINT TRIGGER certified_fork_complete
  AFTER INSERT ON public."CertifiedForkVersion" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.certified_fork_complete_version();
GRANT UPDATE ("tipVersion") ON public."CertifiedForkFamily" TO reviewrouter_certified_fork_writer;
RESET ROLE;
GRANT USAGE ON SCHEMA public TO reviewrouter_certified_fork_writer, reviewrouter_certified_fork_reader;
REVOKE CREATE ON SCHEMA public FROM reviewrouter_certified_fork_owner;
SET LOCAL ROLE reviewrouter_certified_fork_creator;
DO $cleanup$
BEGIN
  EXECUTE format('REVOKE reviewrouter_certified_fork_owner FROM %I GRANTED BY %I RESTRICT', session_user, current_user);
END $cleanup$;
RESET ROLE;
DROP ROLE reviewrouter_certified_fork_creator;
DO $verify_cleanup$
BEGIN
  IF EXISTS (SELECT FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.roleid
    WHERE r.rolname IN ('reviewrouter_certified_fork_owner', 'reviewrouter_certified_fork_writer', 'reviewrouter_certified_fork_reader')) THEN
    RAISE EXCEPTION 'certified_fork_membership_cleanup_incomplete';
  END IF;
END $verify_cleanup$;
COMMIT;
