export const rehearsalRoleLoginContract = new Map([
  ["reviewrouter_api", true],
  ["reviewrouter_web", true],
  ["reviewrouter_worker", true],
  ["reviewrouter_codex_effect_authority", true],
  ["reviewrouter_release_migration", true],
  ["reviewrouter_release_schema_owner", false],
]);

export function rehearsalRoleObservationSql(marker) {
  const roles = [...rehearsalRoleLoginContract.keys()]
    .map((role) => `'${role}'`)
    .join(",");
  const quotedMarker = `'${marker.replaceAll("'", "''")}'`;
  return `SELECT json_agg(json_build_object(
    'username', rolname,
    'markerExact', shobj_description(oid, 'pg_authid') = ${quotedMarker},
    'login', rolcanlogin,
    'superuser', rolsuper,
    'createDatabase', rolcreatedb,
    'createRole', rolcreaterole,
    'replication', rolreplication,
    'bypassRls', rolbypassrls
  ) ORDER BY rolname)
  FROM pg_roles
  WHERE rolname IN (${roles});`;
}

export function assertRehearsalRoleObservation(stdout) {
  let observed;
  try {
    observed = JSON.parse(stdout.trim());
  } catch {
    throw new Error("rehearsal_role_provisioning_observation_invalid");
  }
  if (
    !Array.isArray(observed) ||
    observed.length !== rehearsalRoleLoginContract.size ||
    observed.some(
      (role) =>
        !role ||
        !rehearsalRoleLoginContract.has(role.username) ||
        rehearsalRoleLoginContract.get(role.username) !== role.login ||
        role.markerExact !== true ||
        role.superuser !== false ||
        role.createDatabase !== false ||
        role.createRole !== false ||
        role.replication !== false ||
        role.bypassRls !== false,
    )
  ) {
    throw new Error("rehearsal_role_provisioning_postcondition_failed");
  }
  return observed;
}

export function provisionAndAssertRehearsalRoles({
  marker,
  provisioningSql,
  psql,
  url,
}) {
  psql(url, ["-c", provisioningSql]);
  const observation = psql(url, ["-Atc", rehearsalRoleObservationSql(marker)]);
  assertRehearsalRoleObservation(observation.stdout);
}
