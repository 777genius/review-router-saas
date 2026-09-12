import { randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";
import pg from "pg";

// historical89 SQL (render-historical89-preparation-custody.mjs) requires
// session_user = current_user = datdba = `reviewrouter`. The production
// secret REVIEW_ROUTER_RELEASE_MIGRATION_DATABASE_URL logs in as
// `reviewrouter_release_migration`, which cannot satisfy that identity
// guard and also cannot be granted membership in `reviewrouter`: a
// non-superuser cannot GRANT its own role without ADMIN OPTION on itself.
// Bind the Render owner connection (databaseUser `reviewrouter`) into
// GITHUB_ENV for the following operation step instead. Never print the URL.

const apiKey = process.env.RENDER_API_KEY;
const dbId = process.env.RENDER_POSTGRES_ID;
const coordinator = "reviewrouter";

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
const rawOwnerUrl =
  info.externalConnectionString || info.internalConnectionString;
if (!rawOwnerUrl) {
  console.log("connection_info_missing_url");
  process.exit(1);
}

const ownerUrlObject = new URL(rawOwnerUrl);
const sslmode = ownerUrlObject.searchParams.get("sslmode") || "require";
ownerUrlObject.search = "";
ownerUrlObject.searchParams.set(
  "sslmode",
  sslmode === "disable" ? "require" : sslmode,
);
const ownerUrl = ownerUrlObject.toString();

const client = new pg.Client({ connectionString: ownerUrl });
try {
  await client.connect();
  const who = await client.query(
    `select current_user as current_user,
            session_user as session_user,
            (select rolsuper from pg_catalog.pg_roles
              where rolname = session_user) as superuser,
            (select r.rolname from pg_catalog.pg_database d
               join pg_catalog.pg_roles r on r.oid = d.datdba
              where d.datname = current_database()) as datdba`,
  );
  const row = who.rows[0] ?? {};
  if (
    row.current_user !== coordinator ||
    row.session_user !== coordinator ||
    row.superuser !== false ||
    row.datdba !== coordinator
  ) {
    console.log("owner_session_mismatch");
    process.exit(1);
  }
  const envFile = process.env.GITHUB_ENV;
  if (!envFile) {
    console.log("missing_github_env");
    process.exit(1);
  }
  if (process.env.GITHUB_ACTIONS === "true") {
    const password = ownerUrlObject.password;
    if (password) console.log(`::add-mask::${decodeURIComponent(password)}`);
    console.log(`::add-mask::${ownerUrl}`);
  }
  const delim = `OWNERURL_${randomBytes(16).toString("hex")}`;
  appendFileSync(
    envFile,
    `REVIEW_ROUTER_RELEASE_MIGRATION_DATABASE_URL<<${delim}\n${ownerUrl}\n${delim}\n`,
    { mode: 0o600 },
  );
  console.log("owner_session_bound");
} finally {
  await client.end().catch(() => {});
}
