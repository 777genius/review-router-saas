-- Private selected execution facts on the EXISTING RR authority. No bearer/ledger.
-- SQL120 and every pre-existing snapshot/NULL pin remain unchanged.
ALTER TABLE "ReviewRunAuthorization" ADD COLUMN "gatewayExecutionCanonicalJson" TEXT;
ALTER TABLE "ReviewRunAuthorization" ADD CONSTRAINT "ReviewRunAuthorization_gateway_execution_bound"
CHECK ("gatewayExecutionCanonicalJson" IS NULL OR (
  octet_length("gatewayExecutionCanonicalJson") BETWEEN 2 AND 2048
  AND jsonb_typeof("gatewayExecutionCanonicalJson"::jsonb) = 'object'
  AND "gatewayExecutionCanonicalJson"::jsonb ?& ARRAY[
    'bindingVersion', 'operationId', 'executionRef', 'accountRef', 'authorizationEpoch', 'deadline']
  AND "gatewayExecutionCanonicalJson"::jsonb - ARRAY[
    'bindingVersion', 'operationId', 'executionRef', 'accountRef', 'authorizationEpoch', 'deadline'] = '{}'::jsonb
  AND "gatewayExecutionCanonicalJson"::jsonb -> 'bindingVersion' = '1'::jsonb
  AND jsonb_typeof("gatewayExecutionCanonicalJson"::jsonb -> 'authorizationEpoch') = 'number'
  AND ("gatewayExecutionCanonicalJson"::jsonb ->> 'authorizationEpoch') ~ '^(0|[1-9][0-9]{0,15})$'
  AND ("gatewayExecutionCanonicalJson"::jsonb ->> 'authorizationEpoch')::numeric BETWEEN 0 AND 9007199254740991
  AND jsonb_typeof("gatewayExecutionCanonicalJson"::jsonb -> 'operationId') = 'string'
  AND ("gatewayExecutionCanonicalJson"::jsonb ->> 'operationId') ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'
  AND jsonb_typeof("gatewayExecutionCanonicalJson"::jsonb -> 'executionRef') = 'string'
  AND ("gatewayExecutionCanonicalJson"::jsonb ->> 'executionRef') ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'
  AND jsonb_typeof("gatewayExecutionCanonicalJson"::jsonb -> 'accountRef') = 'string'
  AND ("gatewayExecutionCanonicalJson"::jsonb ->> 'accountRef') ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'
  AND jsonb_typeof("gatewayExecutionCanonicalJson"::jsonb -> 'deadline') = 'string'
  AND ("gatewayExecutionCanonicalJson"::jsonb ->> 'deadline') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
  -- Flat safe projection in the same sorted compact form as application canonicalJson.
  AND "gatewayExecutionCanonicalJson" =
    '{"accountRef":' || ("gatewayExecutionCanonicalJson"::jsonb -> 'accountRef')::text ||
    ',"authorizationEpoch":' || ("gatewayExecutionCanonicalJson"::jsonb -> 'authorizationEpoch')::text ||
    ',"bindingVersion":1,"deadline":' || ("gatewayExecutionCanonicalJson"::jsonb -> 'deadline')::text ||
    ',"executionRef":' || ("gatewayExecutionCanonicalJson"::jsonb -> 'executionRef')::text ||
    ',"operationId":' || ("gatewayExecutionCanonicalJson"::jsonb -> 'operationId')::text || '}'
) IS TRUE);

CREATE FUNCTION review_run_gateway_execution_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  selected jsonb;
  original jsonb;
  caps jsonb;
  cap_name text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."gatewayExecutionCanonicalJson" IS NOT NULL THEN
      RAISE EXCEPTION 'review_run_gateway_execution_requires_existing_authority' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."gatewayExecutionCanonicalJson" IS NOT NULL AND
     NEW."gatewayExecutionCanonicalJson" IS DISTINCT FROM OLD."gatewayExecutionCanonicalJson" THEN
    RAISE EXCEPTION 'review_run_gateway_execution_immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW."gatewayExecutionCanonicalJson" IS NOT NULL THEN
    IF ROW(NEW."authorizationId", NEW."workspaceId", NEW."repositoryConnectionId",
           NEW."scmRepositoryIdentityId", NEW."pullRequestNumber", NEW."sourceRunId",
           NEW."sourceRunAttempt", NEW."workflowIdentityHash", NEW."baseSha", NEW."mergeBaseSha",
           NEW."headSha", NEW."reviewRevisionHash", NEW."trustDomain", NEW."maxExpiresAt",
           NEW."runtimeSnapshotCanonicalJson") IS DISTINCT FROM
       ROW(OLD."authorizationId", OLD."workspaceId", OLD."repositoryConnectionId",
           OLD."scmRepositoryIdentityId", OLD."pullRequestNumber", OLD."sourceRunId",
           OLD."sourceRunAttempt", OLD."workflowIdentityHash", OLD."baseSha", OLD."mergeBaseSha",
           OLD."headSha", OLD."reviewRevisionHash", OLD."trustDomain", OLD."maxExpiresAt",
           OLD."runtimeSnapshotCanonicalJson") THEN
      RAISE EXCEPTION 'review_run_gateway_execution_owner_immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW."gatewayExecutionCanonicalJson" IS NULL OR OLD."gatewayExecutionCanonicalJson" IS NOT NULL THEN
    RETURN NEW;
  END IF;
  selected := NEW."gatewayExecutionCanonicalJson"::jsonb;
  original := NEW."runtimeSnapshotCanonicalJson"::jsonb;
  caps := original #> '{gateway,limits}';
  IF (NEW."state" = 'active' AND NEW."expiresAt" > (clock_timestamp() AT TIME ZONE 'UTC')
      AND NEW."maxExpiresAt" > (clock_timestamp() AT TIME ZONE 'UTC')
      AND original ->> 'snapshotVersion' = '1'
      AND jsonb_typeof(original -> 'gateway') = 'object'
      AND selected ->> 'operationId' = original #>> '{gateway,operationId}'
      AND selected ->> 'accountRef' = original #>> '{gateway,permittedAccountRef}'
      AND selected ->> 'deadline' = original ->> 'deadline'
      AND ((original ->> 'deadline')::timestamptz AT TIME ZONE 'UTC') = NEW."maxExpiresAt"
      AND jsonb_typeof(caps) = 'object'
      AND caps ?& ARRAY['requests', 'concurrency', 'requestBytes', 'outputBytes', 'tokens']
      AND caps - ARRAY['requests', 'concurrency', 'requestBytes', 'outputBytes', 'tokens'] = '{}'::jsonb
  ) IS NOT TRUE THEN
    RAISE EXCEPTION 'review_run_gateway_execution_original_authority_required' USING ERRCODE = '23514';
  END IF;
  FOREACH cap_name IN ARRAY ARRAY['requests', 'concurrency', 'requestBytes', 'outputBytes', 'tokens'] LOOP
    IF (jsonb_typeof(caps -> cap_name) = 'number'
        AND (caps ->> cap_name) ~ '^[1-9][0-9]{0,15}$'
        AND (caps ->> cap_name)::numeric BETWEEN 1 AND 9007199254740991) IS NOT TRUE THEN
      RAISE EXCEPTION 'review_run_gateway_execution_approved_caps_required' USING ERRCODE = '23514';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "ReviewRunAuthorization_gateway_execution_immutable"
BEFORE INSERT OR UPDATE ON "ReviewRunAuthorization"
FOR EACH ROW EXECUTE FUNCTION review_run_gateway_execution_immutable();
