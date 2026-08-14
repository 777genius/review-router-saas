-- Remove PostgreSQL's implicit PUBLIC usage from the authority's declared
-- enum. Generated table row and array types are not privilege-bearing DDL
-- targets; their enclosing schema/table ACLs remain closed.
BEGIN;

REVOKE ALL ON TYPE release_authority.aggregate_state FROM PUBLIC;

COMMIT;
