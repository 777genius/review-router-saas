CREATE TABLE public."RuntimeCanaryChallenge" (
  "nonce" TEXT PRIMARY KEY CHECK ("nonce" ~ '^[a-f0-9]{48}$'),
  "rolloutId" TEXT NOT NULL,
  "releaseCommitSha" TEXT NOT NULL CHECK ("releaseCommitSha" ~ '^[a-f0-9]{40}$'),
  "systemIdentifier" TEXT NOT NULL,
  "recoveryWitnessSha256" TEXT NOT NULL CHECK ("recoveryWitnessSha256" ~ '^[a-f0-9]{64}$'),
  "serviceFacts" JSONB NOT NULL,
  "requestedAt" TIMESTAMPTZ NOT NULL,
  "expiresAt" TIMESTAMPTZ NOT NULL,
  CHECK ("expiresAt" > "requestedAt")
);

CREATE TABLE public."RuntimeCanaryChallengeProof" (
  "nonce" TEXT NOT NULL REFERENCES public."RuntimeCanaryChallenge"("nonce") ON DELETE CASCADE,
  "runtimeRole" TEXT NOT NULL CHECK ("runtimeRole" IN ('api','web','worker')),
  "databaseRole" TEXT NOT NULL,
  "serviceId" TEXT NOT NULL CHECK ("serviceId" ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$'),
  "deployId" TEXT NOT NULL CHECK ("deployId" ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$'),
  "deploymentProvenance" TEXT NOT NULL CHECK ("deploymentProvenance" ~ '^[a-f0-9]{40,64}$'),
  "servicePostconditionSha256" TEXT NOT NULL CHECK ("servicePostconditionSha256" ~ '^sha256:[a-f0-9]{64}$'),
  "systemIdentifier" TEXT NOT NULL,
  "recoveryWitnessSha256" TEXT NOT NULL,
  "releaseCommitSha" TEXT NOT NULL,
  "provedAt" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY ("nonce", "runtimeRole")
);

REVOKE ALL ON TABLE public."RuntimeCanaryChallenge", public."RuntimeCanaryChallengeProof" FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.reviewrouter_request_runtime_canary_challenge(
  requested_rollout_id TEXT,
  requested_nonce TEXT,
  requested_at TIMESTAMPTZ,
  requested_release_commit_sha TEXT,
  requested_system_identifier TEXT,
  requested_recovery_witness_sha256 TEXT,
  requested_service_facts JSONB
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
BEGIN
  IF session_user <> 'reviewrouter_api'
     OR requested_at < clock_timestamp() - interval '10 seconds'
     OR requested_at > clock_timestamp() + interval '5 seconds'
     OR jsonb_typeof(requested_service_facts) <> 'array'
     OR jsonb_array_length(requested_service_facts) <> 3
     OR (SELECT count(DISTINCT item->>'runtimeRole') FROM jsonb_array_elements(requested_service_facts) item) <> 3
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(requested_service_facts) item
       WHERE jsonb_typeof(item) <> 'object'
          OR (SELECT count(*) FROM jsonb_object_keys(item)) <> 5
          OR NOT item ?& ARRAY['runtimeRole','serviceId','deployId','deploymentProvenance','servicePostconditionSha256']
          OR item->>'runtimeRole' NOT IN ('api','web','worker')
          OR item->>'serviceId' !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$'
          OR item->>'deployId' !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$'
          OR item->>'deploymentProvenance' !~ '^[a-f0-9]{40,64}$'
          OR item->>'servicePostconditionSha256' !~ '^sha256:[a-f0-9]{64}$'
     ) THEN
    RAISE EXCEPTION 'runtime canary challenge invalid';
  END IF;
  INSERT INTO public."RuntimeCanaryChallenge" (
    "nonce","rolloutId","releaseCommitSha","systemIdentifier",
    "recoveryWitnessSha256","serviceFacts","requestedAt","expiresAt"
  ) VALUES (
    requested_nonce, requested_rollout_id, requested_release_commit_sha,
    requested_system_identifier, requested_recovery_witness_sha256,
    requested_service_facts, requested_at, requested_at + interval '10 seconds'
  );
END $fn$;

CREATE OR REPLACE FUNCTION public.reviewrouter_answer_runtime_canary_challenge(
  current_rollout_id TEXT,
  current_runtime_role TEXT,
  current_service_id TEXT,
  current_deployment_provenance TEXT,
  current_release_commit_sha TEXT,
  current_recovery_witness_sha256 TEXT
) RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE selected public."RuntimeCanaryChallenge"%ROWTYPE;
DECLARE expected_role TEXT := 'reviewrouter_' || current_runtime_role;
DECLARE binding JSONB;
DECLARE expected_service JSONB;
BEGIN
  IF session_user <> expected_role THEN
    RAISE EXCEPTION 'runtime canary responder role mismatch';
  END IF;
  SELECT challenge.* INTO selected
  FROM public."RuntimeCanaryChallenge" challenge
  WHERE challenge."rolloutId" = current_rollout_id
    AND challenge."releaseCommitSha" = current_release_commit_sha
    AND challenge."recoveryWitnessSha256" = current_recovery_witness_sha256
    AND challenge."expiresAt" >= clock_timestamp()
    AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(challenge."serviceFacts") item
      WHERE item->>'runtimeRole' = current_runtime_role
        AND item->>'serviceId' = current_service_id
        AND item->>'deploymentProvenance' = current_deployment_provenance
    )
    AND NOT EXISTS (
      SELECT 1 FROM public."RuntimeCanaryChallengeProof" proof
      WHERE proof."nonce" = challenge."nonce"
        AND proof."runtimeRole" = current_runtime_role
    )
  ORDER BY challenge."requestedAt" DESC LIMIT 1;
  IF selected."nonce" IS NULL THEN RETURN NULL; END IF;
  SELECT item INTO expected_service
  FROM jsonb_array_elements(selected."serviceFacts") item
  WHERE item->>'runtimeRole' = current_runtime_role
    AND item->>'serviceId' = current_service_id
    AND item->>'deploymentProvenance' = current_deployment_provenance;
  IF expected_service IS NULL
     OR expected_service->>'deployId' IS NULL
     OR expected_service->>'servicePostconditionSha256' !~ '^sha256:[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'runtime canary service binding mismatch';
  END IF;
  SELECT shobj_description(oid, 'pg_database')::jsonb INTO binding
  FROM pg_database WHERE datname = current_database();
  IF binding IS NULL
     OR binding->>'systemIdentifier' IS DISTINCT FROM selected."systemIdentifier"
     OR binding->>'systemIdentifier' IS DISTINCT FROM
        (SELECT system_identifier::text FROM pg_control_system())
     OR binding->>'recoveryWitnessSha256' IS DISTINCT FROM
        current_recovery_witness_sha256 THEN
    RAISE EXCEPTION 'runtime canary generation binding mismatch';
  END IF;
  INSERT INTO public."RuntimeCanaryChallengeProof" (
    "nonce","runtimeRole","databaseRole","serviceId","deployId",
    "deploymentProvenance","servicePostconditionSha256","systemIdentifier",
    "recoveryWitnessSha256","releaseCommitSha"
  ) VALUES (
    selected."nonce", current_runtime_role, session_user,
    expected_service->>'serviceId', expected_service->>'deployId',
    expected_service->>'deploymentProvenance',
    expected_service->>'servicePostconditionSha256', selected."systemIdentifier",
    current_recovery_witness_sha256, current_release_commit_sha
  );
  RETURN selected."nonce";
END $fn$;

CREATE OR REPLACE FUNCTION public.reviewrouter_read_runtime_canary_challenge_proofs(
  requested_nonce TEXT
) RETURNS TABLE (
  "nonce" TEXT, "rolloutId" TEXT, "requestedAt" TIMESTAMPTZ,
  "runtimeRole" TEXT, "databaseRole" TEXT, "serviceId" TEXT,
  "deployId" TEXT, "deploymentProvenance" TEXT,
  "servicePostconditionSha256" TEXT, "systemIdentifier" TEXT,
  "recoveryWitnessSha256" TEXT, "releaseCommitSha" TEXT, "provedAt" TIMESTAMPTZ
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
BEGIN
  IF session_user <> 'reviewrouter_api' THEN
    RAISE EXCEPTION 'runtime canary proof reader role mismatch';
  END IF;
  RETURN QUERY SELECT proof."nonce", challenge."rolloutId", challenge."requestedAt",
    proof."runtimeRole", proof."databaseRole", proof."serviceId",
    proof."deployId", proof."deploymentProvenance", proof."servicePostconditionSha256",
    proof."systemIdentifier",
    proof."recoveryWitnessSha256", proof."releaseCommitSha", proof."provedAt"
  FROM public."RuntimeCanaryChallengeProof" proof
  INNER JOIN public."RuntimeCanaryChallenge" challenge ON challenge."nonce" = proof."nonce"
  WHERE proof."nonce" = requested_nonce ORDER BY proof."runtimeRole";
END $fn$;

REVOKE ALL ON FUNCTION public.reviewrouter_request_runtime_canary_challenge(TEXT,TEXT,TIMESTAMPTZ,TEXT,TEXT,TEXT,JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reviewrouter_answer_runtime_canary_challenge(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reviewrouter_read_runtime_canary_challenge_proofs(TEXT) FROM PUBLIC;

DO $grants$
DECLARE role_name TEXT;
BEGIN
  IF to_regrole('reviewrouter_api') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.reviewrouter_request_runtime_canary_challenge(TEXT,TEXT,TIMESTAMPTZ,TEXT,TEXT,TEXT,JSONB) TO reviewrouter_api;
    GRANT EXECUTE ON FUNCTION public.reviewrouter_read_runtime_canary_challenge_proofs(TEXT) TO reviewrouter_api;
  END IF;
  FOREACH role_name IN ARRAY ARRAY['reviewrouter_api','reviewrouter_web','reviewrouter_worker'] LOOP
    IF to_regrole(role_name) IS NOT NULL THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION public.reviewrouter_answer_runtime_canary_challenge(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT) TO %I', role_name);
    END IF;
  END LOOP;
END $grants$;
