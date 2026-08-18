import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sanitizedDiagnosticError } from "../../packages/features/release-rollout/src/domain/sanitized-diagnostic.js";

const allowedSslModes = new Set([
  "disable",
  "allow",
  "prefer",
  "require",
  "verify-ca",
  "verify-full",
]);

function parseDatabaseUrl(value) {
  let url;
  try {
    url = value instanceof URL ? new URL(value) : new URL(value);
  } catch {
    throw new Error("secret_safe_database_url_invalid");
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !url.hostname ||
    !url.pathname.slice(1) ||
    !url.username
  )
    throw new Error("secret_safe_database_url_invalid");
  for (const key of url.searchParams.keys())
    if (!["sslmode", "application_name", "connect_timeout"].includes(key))
      throw new Error("secret_safe_database_url_parameter_unsupported");
  const sslmode = url.searchParams.get("sslmode") ?? "prefer";
  if (!allowedSslModes.has(sslmode))
    throw new Error("secret_safe_database_sslmode_invalid");
  const applicationName = url.searchParams.get("application_name");
  if (
    applicationName !== null &&
    !/^[A-Za-z0-9_.-]{1,64}$/u.test(applicationName)
  )
    throw new Error("secret_safe_database_application_name_invalid");
  const connectTimeout = url.searchParams.get("connect_timeout");
  if (
    connectTimeout !== null &&
    !/^(?:[1-9]|[1-9][0-9]|1[0-1][0-9]|120)$/u.test(connectTimeout)
  )
    throw new Error("secret_safe_database_connect_timeout_invalid");
  return Object.freeze({
    hostname: url.hostname,
    port: url.port || "5432",
    database: decodeURIComponent(url.pathname.slice(1)),
    username: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    sslmode,
    applicationName,
    connectTimeout,
  });
}

function escapePassfile(value) {
  return value.replaceAll("\\", "\\\\").replaceAll(":", "\\:");
}

function normalizeSqlArguments(args, input) {
  const safeArgs = [];
  let safeInput = input;
  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index]);
    if (arg === "-c" || arg === "--command" || /^-[A-Za-z]*c$/u.test(arg)) {
      if (safeInput !== undefined || index + 1 >= args.length)
        throw new Error("secret_safe_postgres_input_ambiguous");
      safeInput = String(args[index + 1]);
      index += 1;
      if (arg !== "-c" && arg !== "--command") {
        const remaining = arg.slice(0, -1);
        if (remaining !== "-") safeArgs.push(remaining);
      }
      continue;
    }
    if (
      arg.startsWith("postgres://") ||
      arg.startsWith("postgresql://") ||
      /(?:password|token|private[_-]?key)=/iu.test(arg)
    )
      throw new Error("secret_safe_postgres_argv_rejected");
    safeArgs.push(arg);
  }
  return Object.freeze({ args: Object.freeze(safeArgs), input: safeInput });
}

export function normalizeSecretSafePostgresArguments(args, input) {
  return normalizeSqlArguments(args, input);
}

function diagnosticInput(kind, result) {
  return {
    code:
      kind === "rehearsal"
        ? "private_pg17_rehearsal_command_failed"
        : "release_migration_step_failed",
    phase: kind === "rehearsal" ? "rehearsal" : "release_migration",
    exitCode: result?.status,
    signal: result?.signal,
    timedOut: result?.error?.code === "ETIMEDOUT",
  };
}

export function runSecretSafePostgresCommand({
  databaseUrl,
  args = [],
  input,
  binary = "psql",
  environment = process.env,
  kind = "migration",
  timeoutMs = 600_000,
  maxBuffer = 8 * 1024 * 1024,
  expectFailureContaining,
}) {
  const invocation = createSecretSafePostgresInvocation({
    databaseUrl,
    args,
    input,
    environment,
  });
  try {
    const result = spawnSync(binary, invocation.args, {
      encoding: "utf8",
      env: invocation.environment,
      input: invocation.input,
      maxBuffer: Math.min(maxBuffer, 16 * 1024 * 1024),
      timeout: Math.min(Math.max(timeoutMs, 1), 600_000),
    });
    if (expectFailureContaining !== undefined) {
      const failedAsExpected =
        result.status !== 0 &&
        `${result.stdout ?? ""}${result.stderr ?? ""}`.includes(
          expectFailureContaining,
        );
      if (!failedAsExpected)
        throw sanitizedDiagnosticError(diagnosticInput(kind, result));
      return Object.freeze({ expectedFailure: true });
    }
    if (result.status !== 0 || result.error)
      throw sanitizedDiagnosticError(diagnosticInput(kind, result));
    return Object.freeze({ stdout: String(result.stdout ?? "") });
  } finally {
    invocation.cleanup();
  }
}

export function createSecretSafePostgresInvocation({
  databaseUrl,
  args = [],
  input,
  environment = process.env,
  pgHostAddress,
}) {
  const connection = parseDatabaseUrl(databaseUrl);
  const normalized = normalizeSqlArguments(args, input);
  if (
    pgHostAddress !== undefined &&
    !/^[A-Za-z0-9.:[\]-]{1,255}$/u.test(pgHostAddress)
  )
    throw new Error("secret_safe_database_host_address_invalid");
  const directory = mkdtempSync(join(tmpdir(), "rr-postgres-command-"));
  const passfile = join(directory, "pgpass");
  writeFileSync(
    passfile,
    `${escapePassfile(connection.hostname)}:${escapePassfile(connection.port)}:${escapePassfile(connection.database)}:${escapePassfile(connection.username)}:${escapePassfile(connection.password)}\n`,
    { mode: 0o600, flag: "wx" },
  );
  let cleaned = false;
  return Object.freeze({
    args: Object.freeze([
      "--host",
      connection.hostname,
      "--port",
      connection.port,
      "--username",
      connection.username,
      "--dbname",
      connection.database,
      ...normalized.args,
    ]),
    environment: Object.freeze({
      PATH: environment.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      PGPASSFILE: passfile,
      PGSSLMODE: connection.sslmode,
      ...(pgHostAddress ? { PGHOSTADDR: pgHostAddress } : {}),
      ...(connection.applicationName
        ? { PGAPPNAME: connection.applicationName }
        : {}),
      ...(connection.connectTimeout
        ? { PGCONNECT_TIMEOUT: connection.connectTimeout }
        : {}),
    }),
    input: normalized.input,
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      rmSync(directory, { recursive: true, force: true });
    },
  });
}

export function createDatabaseCredentialBoundary(
  databaseUrl,
  environment = process.env,
) {
  parseDatabaseUrl(databaseUrl);
  const directory = mkdtempSync(join(tmpdir(), "rr-database-credential-"));
  const credentialFile = join(directory, "database-url");
  writeFileSync(credentialFile, String(databaseUrl), {
    mode: 0o600,
    flag: "wx",
  });
  let cleaned = false;
  return Object.freeze({
    environment: Object.freeze({
      PATH: environment.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      REVIEW_ROUTER_DATABASE_URL_FILE: credentialFile,
    }),
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      rmSync(directory, { recursive: true, force: true });
    },
  });
}
