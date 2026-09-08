// Assignment shape is checked before any fixture side effects. The child also
// verifies the database owner row before claiming or resetting the database.
export function item11Enabled(env) {
  if (env.REVIEW_ROUTER_ITEM11_E2E !== "1") return false;
  const runId = env.REVIEW_ROUTER_ITEM11_RUN_ID ?? "";
  try {
    const url = new URL(env.REVIEW_ROUTER_ITEM11_DATABASE_URL);
    if (
      !/^[a-f0-9]{32}$/.test(runId) ||
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
      url.pathname !== `/item11_test_${runId}` ||
      url.search ||
      url.hash
    )
      throw 0;
  } catch {
    throw new Error("item11_explicit_gate_requires_owned_database_and_run_id");
  }
  return true;
}
