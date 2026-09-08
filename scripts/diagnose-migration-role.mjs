import pg from "pg";

async function check(label, url) {
  if (!url) {
    console.log(`${label}: not set`);
    return;
  }
  const client = new pg.Client({ connectionString: url });
  try {
    await client.connect();
    const who = await client.query(
      "select current_user, session_user, pg_has_role(current_user, 'reviewrouter', 'MEMBER') as owner_member, has_table_privilege(current_user, 'public._prisma_migrations', 'SELECT') as can_select, has_table_privilege(current_user, 'public._prisma_migrations', 'INSERT') as can_insert, has_table_privilege(current_user, 'public._prisma_migrations', 'UPDATE') as can_update",
    );
    console.log(`${label}:`, JSON.stringify(who.rows[0]));
    const roles = await client.query(
      "select r.rolname as granted_role from pg_auth_members m join pg_roles r on r.oid = m.roleid where m.member = (select oid from pg_roles where rolname = current_user)",
    );
    console.log(
      `${label} role memberships:`,
      JSON.stringify(roles.rows.map((r) => r.granted_role)),
    );
  } catch (e) {
    console.log(`${label}: query_failed`, e.message);
  } finally {
    await client.end().catch(() => {});
  }
}

await check(
  "release_migration",
  process.env.REVIEW_ROUTER_RELEASE_MIGRATION_DATABASE_URL,
);
await check(
  "comment_token_custody",
  process.env.REVIEW_ROUTER_COMMENT_TOKEN_CUSTODY_DATABASE_URL,
);
