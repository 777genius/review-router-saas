#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvFile } from "./lib/env-file.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const composeFile = "deploy/self-hosted/compose.yml";
const dockerfilePath = "deploy/self-hosted/Dockerfile";
const errors = [];

const compose = loadDockerComposeConfig();
const services = compose.services ?? {};
const dockerfile = readFileSync(resolve(repoRoot, dockerfilePath), "utf8");
const rootPackageJson = readJson("package.json");
const codexOauthPackageJson = readJson(
  "packages/features/codex-oauth-rotating/package.json",
);

requireService("postgres");
requireService("migrate");
requireService("web");
requireService("api");
requireService("worker");
requireNamedVolume("reviewrouter-postgres-data");

requireCommand("migrate", [
  "sh",
  "-lc",
  "pnpm --filter @reviewrouter/platform-db db:migrate:deploy && node scripts/review-v2-migrate.mjs --apply --actor=self-hosted-compose",
]);
requireCommand("api", [
  "node",
  "--conditions=production",
  "apps/api/dist/server.js",
]);
requireCommand("worker", [
  "node",
  "--conditions=production",
  "apps/worker/dist/worker.js",
]);
requireCommandIncludes("web", ["pnpm", "next", "start", "--hostname"]);

requireDependsOn("migrate", "postgres", "service_healthy");
for (const service of ["web", "api", "worker"]) {
  requireDependsOn(service, "migrate", "service_completed_successfully");
}

requireHealthcheck("postgres", "pg_isready");
requireHealthcheck("web", "http://127.0.0.1:3000/api/health");
requireHealthcheck("api", "http://127.0.0.1:4000/health");
requireHealthcheck("web", "redirect:'manual'");
requireHealthcheck("api", "redirect:'manual'");
requireHealthcheck("web", "r.status===200");
requireHealthcheck("api", "r.status===200");
requireVolumeMount(
  "postgres",
  "reviewrouter-postgres-data",
  "/var/lib/postgresql",
);
requirePort("postgres", "5432");
requirePort("web", "3000");
requirePort("api", "4000");
requireBuild("web");
requireBuild("api");
requireBuild("worker");
requireBuild("migrate");
requireDockerfileText("postgresql-client");
for (const service of ["migrate", "web", "api", "worker"]) {
  requireEnvironment(
    service,
    "REVIEW_ROUTER_CODEX_ROTATING_ACTION_REF",
    fileEnvValue("REVIEW_ROUTER_CODEX_ROTATING_ACTION_REF"),
  );
  requireEnvironment(
    service,
    "REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS",
    fileEnvValue("REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS"),
  );
  requireEnvironment(
    service,
    "REVIEW_ROUTER_REVIEW_V2_DIRECT_INITIALIZATION_ENABLED",
    "1",
  );
  requireEnvironment(
    service,
    "REVIEW_ROUTER_REVIEW_V2_WORKFLOW_PROVISIONING_MODE",
    "client_triggered_t0",
  );
  requireEnvironment(
    service,
    "REVIEW_ROUTER_REVIEW_V2_INTENT_ADMISSION_REQUIRED",
    "0",
  );
  requireEnvironment(
    service,
    "REVIEW_ROUTER_REVIEW_V2_INTENT_INGRESS_ENABLED",
    "0",
  );
  requireEnvironment(
    service,
    "REVIEW_ROUTER_REVIEW_V2_WORKFLOW_DISPATCH_READY",
    "0",
  );
}
requireSelfHostedDependencyIsolation();

if (errors.length > 0) {
  console.error("ReviewRouter self-hosted compose contract failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

function readJson(path) {
  return JSON.parse(readFileSync(resolve(repoRoot, path), "utf8"));
}

console.log("Self-hosted compose contract passed.");

function loadDockerComposeConfig() {
  const result = spawnSync(
    "docker",
    ["compose", "-f", composeFile, "config", "--format", "json"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: composeEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.status !== 0) {
    console.error("docker compose config failed.");
    console.error(result.stdout);
    console.error(result.stderr);
    process.exit(result.status ?? 1);
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    console.error("docker compose config did not return valid JSON.");
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

function composeEnvironment() {
  const configuredEnvFile =
    process.env.REVIEW_ROUTER_SELF_HOSTED_ENV_FILE?.trim();
  const envFilePath = configuredEnvFile
    ? isAbsolute(configuredEnvFile)
      ? configuredEnvFile
      : resolve(repoRoot, configuredEnvFile)
    : resolve(repoRoot, "deploy/self-hosted/.env.example");
  const fileEnv = loadEnvFile(envFilePath, {});
  return {
    ...fileEnv,
    ...process.env,
    POSTGRES_PASSWORD:
      process.env.POSTGRES_PASSWORD ??
      fileEnv.POSTGRES_PASSWORD ??
      "reviewrouter-compose-contract-password",
    REVIEW_ROUTER_SELF_HOSTED_ENV_FILE: configuredEnvFile ?? "./.env.example",
  };
}

function fileEnvValue(name) {
  return String(composeEnvironment()[name] ?? "");
}

function requireService(name) {
  if (!services[name]) errors.push(`service ${name} is missing.`);
}

function requireNamedVolume(name) {
  if (!compose.volumes?.[name]) errors.push(`volume ${name} is missing.`);
}

function requireCommand(serviceName, expected) {
  const command = services[serviceName]?.command;
  if (!Array.isArray(command) || command.join(" ") !== expected.join(" ")) {
    errors.push(
      `service ${serviceName} must run command ${expected.join(" ")}.`,
    );
  }
}

function requireCommandIncludes(serviceName, expectedParts) {
  const command = services[serviceName]?.command;
  const commandText = Array.isArray(command) ? command.join(" ") : "";
  for (const part of expectedParts) {
    if (!commandText.includes(part)) {
      errors.push(`service ${serviceName} command must include ${part}.`);
    }
  }
}

function requireDependsOn(serviceName, dependencyName, condition) {
  const actual = services[serviceName]?.depends_on?.[dependencyName]?.condition;
  if (actual !== condition) {
    errors.push(
      `service ${serviceName} must depend on ${dependencyName} with ${condition}.`,
    );
  }
}

function requireHealthcheck(serviceName, expectedText) {
  const test = services[serviceName]?.healthcheck?.test;
  const testText = Array.isArray(test) ? test.join(" ") : "";
  if (!testText.includes(expectedText)) {
    errors.push(
      `service ${serviceName} healthcheck must include ${expectedText}.`,
    );
  }
}

function requirePort(serviceName, containerPort) {
  const ports = services[serviceName]?.ports ?? [];
  const hasPort = ports.some((port) => String(port.target) === containerPort);
  if (!hasPort) {
    errors.push(
      `service ${serviceName} must expose container port ${containerPort}.`,
    );
  }
}

function requireVolumeMount(serviceName, volumeName, targetPath) {
  const volumes = services[serviceName]?.volumes ?? [];
  const hasMount = volumes.some(
    (volume) => volume.source === volumeName && volume.target === targetPath,
  );
  if (!hasMount) {
    errors.push(
      `service ${serviceName} must mount ${volumeName} at ${targetPath}.`,
    );
  }
}

function requireBuild(serviceName) {
  const build = services[serviceName]?.build;
  if (
    !build ||
    resolve(String(build.context ?? "")) !== repoRoot ||
    build.dockerfile !== "deploy/self-hosted/Dockerfile"
  ) {
    errors.push(
      `service ${serviceName} must build from deploy/self-hosted/Dockerfile.`,
    );
  }
}

function requireDockerfileText(expectedText) {
  if (!dockerfile.includes(expectedText)) {
    errors.push(`self-hosted Dockerfile must include ${expectedText}.`);
  }
}

function requireEnvironment(serviceName, name, expected) {
  const actual = services[serviceName]?.environment?.[name];
  if (String(actual) !== expected) {
    errors.push(
      `service ${serviceName} environment ${name} must be ${expected}.`,
    );
  }
}

function requireSelfHostedDependencyIsolation() {
  const subscriptionRuntime = "@777genius/subscription-runtime";
  if (rootPackageJson.dependencies?.[subscriptionRuntime]) {
    errors.push(
      `${subscriptionRuntime} must not be a root production dependency; self-hosted image builds must not require private action runtime access.`,
    );
  }
  if (codexOauthPackageJson.dependencies?.[subscriptionRuntime]) {
    errors.push(
      `${subscriptionRuntime} must not be a production dependency of @reviewrouter/features-codex-oauth-rotating.`,
    );
  }
  for (const filter of [
    "--filter @reviewrouter/api...",
    "--filter @reviewrouter/worker...",
    "--filter @reviewrouter/web...",
  ]) {
    if (!dockerfile.includes(filter)) {
      errors.push(
        `self-hosted Dockerfile install/build must include ${filter}.`,
      );
    }
  }
  if (dockerfile.includes("--no-optional")) {
    errors.push(
      "self-hosted Dockerfile must not disable all optional dependencies; Next/Tailwind native packages rely on them.",
    );
  }
}
