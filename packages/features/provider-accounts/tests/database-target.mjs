// No ambient DATABASE_URL, credentials, unix sockets, query options or SSL.
export function checkedDatabaseTarget(raw) {
  const url = new URL(raw);
  const database = url.pathname.slice(1);
  const port = url.port ? Number(url.port) : 5432;
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    !/^rr_gateway_test_[a-z0-9_]+$/.test(database) ||
    !/^[a-zA-Z0-9_]+$/.test(url.username) ||
    url.password ||
    url.search ||
    url.hash ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    throw new Error("provider_accounts_disposable_loopback_database_required");
  }
  return {
    host: url.hostname === "[::1]" ? "::1" : url.hostname,
    port,
    user: url.username,
    database,
    // pg treats an empty string password as absent and can consult PGPASSWORD
    // or pgpass. A truthy callback keeps both credential fallbacks disabled.
    password: () => "",
    ssl: false,
    max: 8,
    options: "-c search_path=public",
    application_name: "rr_provider_accounts_c1_test",
    client_encoding: "UTF8",
  };
}
export async function assertEmptyDatabase(client) {
  const { rows } = await client.query(`
    SELECT EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
      UNION ALL
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
      UNION ALL
      SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
      UNION ALL
      SELECT 1 FROM pg_namespace n
      WHERE n.nspname !~ '^pg_' AND n.nspname NOT IN ('information_schema', 'public')
    ) AS nonempty`);
  if (rows[0]?.nonempty !== false)
    throw new Error("provider_accounts_fixture_not_empty");
}
