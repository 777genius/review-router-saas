import pg from "pg";

// One-time, idempotent prerequisite: reviewrouter_release_migration must be
// able to `GRANT reviewrouter TO reviewrouter_release_migration WITH INHERIT
// TRUE, SET TRUE` inside its own migration transaction (see
// render-historical89-preparation-custody.mjs's assumeOwner/releaseOwner).
// That self-service GRANT requires the role to already hold ADMIN OPTION on
// `reviewrouter`. Fetch an owner-level connection from the Render API (using
// the same RENDER_API_KEY secret already used for allowlist management, no
// new credential) and grant that admin-option membership if it is missing.
// Never print the connection string.

const apiKey = process.env.RENDER_API_KEY;
const dbId = process.env.RENDER_POSTGRES_ID;
const migrationRole = "reviewrouter_release_migration";
const targetRole = "reviewrouter";

if (!apiKey || !dbId) {
  console.log("missing_render_env");
  process.exit(1);
}

const res = await globalThis.fetch(
  `https://api.render.com/v1/postgres/${dbId}/connection-info`,
  {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
  },
);
if (!res.ok) {
  console.log("connection_info_fetch_failed:", res.status);
  process.exit(1);
}
const info = await res.json();
const ownerUrl = info.internalConnectionString || info.externalConnectionString;
if (!ownerUrl) {
  console.log("connection_info_missing_url");
  process.exit(1);
}

const client = new pg.Client({ connectionString: ownerUrl });
try {
  await client.connect();
  const already = await client.query(
    "select 1 from pg_auth_members m join pg_roles g on g.oid = m.roleid join pg_roles r on r.oid = m.member where g.rolname = $1 and r.rolname = $2 and m.admin_option",
    [targetRole, migrationRole],
  );
  if (already.rowCount > 0) {
    console.log("already_granted");
  } else {
    await client.query(
      `GRANT ${targetRole} TO ${migrationRole} WITH ADMIN TRUE, INHERIT TRUE, SET TRUE`,
    );
    console.log("granted");
  }
} finally {
  await client.end().catch(() => {});
}
