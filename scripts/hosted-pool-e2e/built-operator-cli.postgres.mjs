import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createPrismaClient } from "../../packages/platform/db/dist/index.js";
import { createApiApp } from "../../apps/api/dist/app.js";

// Only the built release modules and an actual loopback API/PG connection.
// No injected pool handlers, provider requests, GitHub requests or live auth.
const ownerUrl = process.env.REVIEW_ROUTER_HOSTED_POOL_E2E_DATABASE_URL;
const apiUrl = process.env.REVIEW_ROUTER_HOSTED_POOL_E2E_API_DATABASE_URL;
for (const url of [ownerUrl, apiUrl]) {
  assert.ok(url, "built_operator_disposable_database_required");
  const parsed = new URL(url);
  assert.ok(["localhost", "127.0.0.1"].includes(parsed.hostname));
  assert.ok(parsed.pathname.startsWith("/reviewrouter_hosted_pool_e2e_"));
}
assert.equal(process.env.REVIEW_ROUTER_RUN_BUILT_OPERATOR_PG, "1");
const owner = createPrismaClient({ databaseUrl: ownerUrl, poolMax: 2 });
const api = createPrismaClient({ databaseUrl: apiUrl, poolMax: 2 });
const prefix = `built-operator-${randomUUID()}`;
const credential = randomBytes(24).toString("base64url");
const githubId = BigInt(Date.now());
const directory = await mkdtemp(
  join(tmpdir(), "rr-built-operator-disposable-"),
);
const authFile = join(directory, "auth.json");
const steps = [];
let app;
let endpoint;
const executeFile = promisify(execFile);
const env = {
  NODE_ENV: "test",
  DATABASE_URL: apiUrl,
  REVIEW_ROUTER_HOSTED_POOL_OPERATOR_ENABLED: "1",
  REVIEW_ROUTER_HOSTED_POOL_OPERATOR_WORKSPACE_ID: prefix,
  REVIEW_ROUTER_HOSTED_POOL_OPERATOR_OWNER_GITHUB_USER_ID: githubId.toString(),
  REVIEW_ROUTER_REVIEW_CONFIG_OPERATOR_CREDENTIAL_SHA256: hash(credential),
  REVIEW_ROUTER_HOSTED_CODEX_DATABASE_INCARNATION: "disposable-incarnation",
  REVIEW_ROUTER_HOSTED_CODEX_DATABASE_RESOURCE_IDENTITY: "disposable-resource",
  REVIEW_ROUTER_HOSTED_CODEX_FINGERPRINT_PEPPER: Buffer.alloc(32, 29).toString(
    "base64",
  ),
  REVIEW_ROUTER_HOSTED_CODEX_KEYRING_MODE: "local_env",
  REVIEW_ROUTER_HOSTED_CODEX_KEK_CURRENT_ID: "fixture",
  REVIEW_ROUTER_HOSTED_CODEX_KEK_KEYRING_JSON: JSON.stringify({
    fixture: Buffer.alloc(32, 17).toString("base64"),
  }),
};
async function cli(args, workspace = prefix, expectedExit = 0) {
  const result = await executeFile(
    process.execPath,
    [
      "--conditions=production",
      "apps/api/dist/reviewrouter-operator-cli.js",
      "pool",
      ...args,
      "--workspace",
      workspace,
    ],
    {
      cwd: process.cwd(),
      timeout: 20_000,
      maxBuffer: 256 * 1024,
      env: {
        PATH: process.env.PATH,
        NODE_ENV: "test",
        REVIEW_ROUTER_API_URL: endpoint,
        REVIEW_ROUTER_REVIEW_CONFIG_OPERATOR_CREDENTIAL: credential,
      },
    },
  ).then(
    ({ stdout, stderr }) => ({ exit: 0, stdout, stderr }),
    (error) => ({
      exit: error.code,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
    }),
  );
  for (const secret of [credential, "fake-refresh", "fake-access"]) {
    assert.equal(
      (result.stdout + result.stderr).includes(secret),
      false,
      "built_operator_output_secret_leak",
    );
  }
  assert.equal(
    result.exit,
    expectedExit,
    `built_operator_command_failed:${args.slice(0, 2).join(" ")}:${result.stderr}`,
  );
  return expectedExit === 0 ? JSON.parse(result.stdout) : result;
}
async function writeAuth(subject, minute) {
  const claims = Buffer.from(
    JSON.stringify({
      iss: "https://auth.openai.com",
      sub: subject,
      "https://api.openai.com/auth": { chatgpt_account_id: subject },
    }),
  ).toString("base64url");
  await writeFile(
    authFile,
    JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        access_token: "fake-access",
        refresh_token: "fake-refresh",
        id_token: `e30.${claims}.signature`,
      },
      last_refresh: `2026-09-06T01:${minute}:00Z`,
    }),
    { mode: 0o600 },
  );
}
try {
  assert.equal(
    (await api.$queryRaw`SELECT current_user::text AS name`)[0].name,
    "reviewrouter_api",
  );
  await owner.workspace.create({
    data: { id: prefix, slug: prefix, name: "Disposable built operator" },
  });
  const user = await owner.user.create({ data: { githubUserId: githubId } });
  const membership = await owner.workspaceMember.create({
    data: { workspaceId: prefix, userId: user.id, role: "owner" },
  });
  await owner.workspaceEntitlement.create({
    data: {
      workspaceId: prefix,
      limits: {},
      flags: { hosted_codex_pool: true },
    },
  });
  app = await createApiApp({ prisma: api, reviewActionV2Env: env });
  endpoint = await app.listen({ host: "127.0.0.1", port: 0 });
  assert.equal((await cli(["status"])).pool, null);
  await cli(["status"], `${prefix}-foreign`, 1);
  steps.push("normal_api_composition_and_foreign_workspace_denial");
  await writeAuth(prefix, "00");
  const imported = await cli([
    "accounts",
    "import",
    "--label",
    "primary",
    "--auth-file",
    authFile,
  ]);
  assert.equal(imported.status, "imported");
  const duplicate = await cli([
    "accounts",
    "import",
    "--label",
    "primary",
    "--auth-file",
    authFile,
  ]);
  assert.equal(duplicate.status, "already_imported");
  assert.equal(duplicate.accountId, imported.accountId);
  steps.push("import_and_duplicate_reconciliation");
  await writeAuth(`${prefix}-backup`, "00");
  assert.equal(
    (
      await cli([
        "accounts",
        "import",
        "--label",
        "backup",
        "--auth-file",
        authFile,
      ])
    ).status,
    "imported",
  );
  const status = await cli(["status"]);
  assert.equal(status.accounts.length, 2);
  assert.equal(
    await owner.hostedCodexPool.count({ where: { workspaceId: prefix } }),
    1,
  );
  const account = status.accounts.find((a) => a.id === imported.accountId);
  const paused = await cli([
    "accounts",
    "pause",
    "--account-id",
    account.id,
    "--expected-health-version",
    String(account.healthVersion),
  ]);
  await writeAuth(prefix, "01");
  const replaced = await cli([
    "accounts",
    "replace",
    "--account-id",
    account.id,
    "--expected-generation",
    String(account.generation),
    "--expected-health-version",
    String(paused.healthVersion),
    "--auth-file",
    authFile,
  ]);
  assert.equal(replaced.status, "replaced");
  const afterReplace = (await cli(["status"])).accounts.find(
    (a) => a.id === account.id,
  );
  assert.equal(afterReplace.availability, "paused");
  assert.equal(afterReplace.generation, account.generation + 1);
  await cli([
    "accounts",
    "resume",
    "--account-id",
    account.id,
    "--expected-health-version",
    String(afterReplace.healthVersion),
  ]);
  assert.equal(
    (await cli(["status"])).accounts.find((a) => a.id === account.id)
      .availability,
    "healthy",
  );
  steps.push("two_accounts_one_pool_pause_replace_resume");
  await owner.workspaceMember.delete({ where: { id: membership.id } });
  await cli(["status"], prefix, 1);
  steps.push("revoked_owner_denied_by_live_api");
  process.stdout.write(
    JSON.stringify({
      kind: "built_operator_cli_api_postgres",
      status: "passed",
      steps,
      providerCalls: 0,
    }) + "\n",
  );
} finally {
  await app?.close();
  await api.$disconnect();
  await owner.$disconnect();
  await rm(directory, { recursive: true, force: true });
  // Database and immutable ledgers are destroyed by the supplying PG harness.
}
function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}
