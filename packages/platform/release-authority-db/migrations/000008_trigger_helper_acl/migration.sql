BEGIN;

REVOKE ALL ON FUNCTION release_authority.release_service_transition_immutable() FROM PUBLIC;

COMMIT;
