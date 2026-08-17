import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";

const image =
  "postgres:17-alpine@sha256:d4bb0a8c1b7bb2e29f976d099e7bfb9a5d8858cffe9e46b35cd302cd1f1f8168";
const suffix = randomBytes(6).toString("hex");
const container = `reviewrouter-hosted-pool-e2e-${suffix}`;
const database = `reviewrouter_hosted_pool_e2e_${suffix}`;
const password = randomBytes(24).toString("base64url");
const port = await reservePort();
const databaseUrl = `postgresql://postgres:${password}@127.0.0.1:${port}/${database}?schema=public`;

let started = false;
try {
  run("docker", [
    "run",
    "--detach",
    "--rm",
    "--name",
    container,
    "--env",
    `POSTGRES_PASSWORD=${password}`,
    "--env",
    `POSTGRES_DB=${database}`,
    "--publish",
    `127.0.0.1:${port}:5432`,
    image,
  ]);
  started = true;
  await waitForPostgres(container);
  run(
    "pnpm",
    [
      "--filter",
      "@reviewrouter/platform-db",
      "exec",
      "prisma",
      "migrate",
      "deploy",
      "--config",
      "prisma.config.ts",
    ],
    { DATABASE_URL: databaseUrl },
  );
  run(
    "pnpm",
    [
      "exec",
      "vitest",
      "run",
      "scripts/hosted-pool-e2e/hosted-pool-postgres.e2e.test.ts",
    ],
    {
      REVIEW_ROUTER_HOSTED_POOL_E2E_DATABASE_URL: databaseUrl,
    },
  );
} finally {
  if (started) {
    spawnSync("docker", ["rm", "--force", container], { stdio: "ignore" });
  }
}

function run(command, args, extraEnv = {}) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: { ...process.env, ...extraEnv },
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} failed with exit code ${result.status ?? "unknown"}`,
    );
  }
}

async function waitForPostgres(name) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const result = spawnSync(
      "docker",
      ["exec", name, "pg_isready", "--username", "postgres"],
      { stdio: "ignore" },
    );
    if (result.status === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("disposable_postgres_not_ready");
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("failed_to_reserve_port"));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}
