import assert from "node:assert/strict";
import { test } from "node:test";
import { checkedDatabaseTarget } from "./database-target.mjs";

// Regression: opt-in accepts production credentials/hosts or URL socket options.
test("PostgreSQL fixture target admits only an explicit passwordless loopback test database", () => {
  // Regression: pg treats falsy password/options as omitted and can fall
  // back to ambient credentials/session settings. Require explicit safe inputs.
  const { password, ...target } = checkedDatabaseTarget(
    "postgresql://fixture_owner@127.0.0.1:5544/rr_gateway_test_c1",
  );
  assert.deepEqual(target, {
    host: "127.0.0.1",
    port: 5544,
    user: "fixture_owner",
    database: "rr_gateway_test_c1",
    ssl: false,
    max: 8,
    options: "-c search_path=public",
    application_name: "rr_provider_accounts_c1_test",
    client_encoding: "UTF8",
  });
  assert.equal(typeof password, "function");
  assert.equal(password(), "");
  for (const raw of [
    "postgresql://fixture_owner@remote.invalid/rr_gateway_test_c1",
    "postgresql://fixture_owner@127.0.0.1:0/rr_gateway_test_c1",
    "postgresql://fixture_owner@127.0.0.1/production",
    "postgresql://fixture_owner:synthetic-password@127.0.0.1/rr_gateway_test_c1",
    "postgresql://fixture_owner@127.0.0.1/rr_gateway_test_c1?host=/tmp",
    "postgresql://fixture_owner@127.0.0.1/rr_gateway_test_c1#options",
    "postgresql://127.0.0.1/rr_gateway_test_c1",
  ])
    assert.throws(() => checkedDatabaseTarget(raw));
});
