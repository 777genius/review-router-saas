-- 000090 removes the legacy writer key and requires attempt identity. This is
-- a quiesced cutover, never a rolling migration. Keep the existing runtime ACL
-- gate closed until every web/API/worker process runs the new schema contract.
-- The migration principal and superuser administrators are reserved operators;
-- runtime services must use separate, non-superuser principals.
DO $quiescence$
BEGIN
  IF session_user IN ('reviewrouter_web', 'reviewrouter_api', 'reviewrouter_worker')
     OR EXISTS (
       SELECT 1 FROM pg_catalog.pg_roles r
       WHERE r.rolcanlogin AND NOT r.rolsuper
         AND r.rolname NOT IN (session_user, current_user)
         AND pg_catalog.has_database_privilege(r.oid, current_database(), 'CONNECT')
         AND (
           pg_catalog.has_any_column_privilege(r.oid, 'public."WorkflowProvisioning"', 'INSERT,UPDATE')
           OR pg_catalog.has_table_privilege(r.oid, 'public."WorkflowProvisioning"', 'DELETE,TRUNCATE')
           OR pg_catalog.has_any_column_privilege(r.oid, 'public."RepositoryConnection"', 'INSERT,UPDATE')
           OR pg_catalog.has_table_privilege(r.oid, 'public."RepositoryConnection"', 'DELETE,TRUNCATE')
         )
     ) OR EXISTS (
       SELECT 1 FROM pg_catalog.pg_stat_activity a
       JOIN pg_catalog.pg_roles r ON r.oid = a.usesysid
       WHERE a.datname = current_database() AND a.pid <> pg_catalog.pg_backend_pid()
         AND NOT r.rolsuper

     ) THEN
    RAISE EXCEPTION 'workflow_provisioning_writer_quiescence_required';
  END IF;
END
$quiescence$;
