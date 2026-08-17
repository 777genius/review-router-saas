#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  postgresEnvironment,
  postgresPassfileLine,
} from "./install-release-authority-db.mjs";
import { releaseAuthorityPostgresUrlWithCredentials } from "./lib/release-authority-postgres-url.mjs";
import { sanitizedDiagnosticError } from "../packages/features/release-rollout/src/domain/sanitized-diagnostic.js";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

const required = (environment, name, pattern) => {
  const value = environment[name];
  if (!value || (pattern && !pattern.test(value)))
    throw new Error(`release_authority_credential_env_invalid:${name}`);
  return value;
};

const readCredential = (path) => {
  const metadata = statSync(path);
  if (!metadata.isFile() || (metadata.mode & 0o077) !== 0)
    throw new Error("release_authority_credential_file_permissions_invalid");
  return readFileSync(path, "utf8");
};

const sqlLiteral = (value) => `'${value.replaceAll("'", "''")}'`;

const runPsql = ({ databaseUrl, input, environment }) => {
  const directory = mkdtempSync(join(tmpdir(), "rr-authority-credential-"));
  const passfile = join(directory, "pgpass");
  writeFileSync(passfile, postgresPassfileLine(databaseUrl), {
    mode: 0o600,
    flag: "wx",
  });
  try {
    const binary = environment.REVIEW_ROUTER_PSQL_BINARY ?? "psql";
    if (!/^(?:psql|\/[A-Za-z0-9._+/-]{1,1023})$/u.test(binary))
      throw new Error("release_authority_psql_binary_invalid");
    const result = spawnSync(
      binary,
      ["--no-psqlrc", "--quiet", "--tuples-only", "--no-align"],
      {
        encoding: "utf8",
        input,
        env: postgresEnvironment(databaseUrl, environment, passfile),
        timeout: 60_000,
        maxBuffer: 1024 * 1024,
      },
    );
    if (result.status !== 0 || result.error)
      throw sanitizedDiagnosticError({
        code: "release_authority_migration_process_failed",
        phase: "authority_migration",
        exitCode: result.status,
        signal: result.signal,
        timedOut: result.error?.code === "ETIMEDOUT",
      });
    return result.stdout.trim();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

const leasedUrl = (issuerUrl, loginRole, password) => {
  return releaseAuthorityPostgresUrlWithCredentials(
    issuerUrl,
    loginRole,
    password,
  );
};

export const issueMigrationCredential = (environment = process.env) => {
  const issuerFile = required(
    environment,
    "REVIEW_ROUTER_RELEASE_AUTHORITY_CREDENTIAL_ISSUER_DATABASE_URL_FILE",
  );
  const outputUrlFile = required(
    environment,
    "REVIEW_ROUTER_RELEASE_AUTHORITY_MIGRATION_DATABASE_URL_FILE",
  );
  const outputLeaseFile = required(
    environment,
    "REVIEW_ROUTER_RELEASE_AUTHORITY_MIGRATION_LEASE_FILE",
  );
  const expectedCommitSha = required(
    environment,
    "REVIEW_ROUTER_RELEASE_AUTHORITY_EXPECTED_SHA",
    /^[a-f0-9]{40}$/u,
  );
  const workflowRunId = required(
    environment,
    "REVIEW_ROUTER_RELEASE_AUTHORITY_WORKFLOW_RUN_ID",
    /^[1-9][0-9]*$/u,
  );
  const workflowRunAttempt = required(
    environment,
    "REVIEW_ROUTER_RELEASE_AUTHORITY_WORKFLOW_RUN_ATTEMPT",
    /^[1-9][0-9]*$/u,
  );
  const operation = required(
    environment,
    "REVIEW_ROUTER_RELEASE_AUTHORITY_MIGRATION_MODE",
    /^incremental-upgrade$/u,
  );
  const password = randomBytes(32).toString("base64url");
  const nonce = randomBytes(32).toString("base64url");
  const binding = [
    expectedCommitSha,
    workflowRunId,
    workflowRunAttempt,
    nonce,
  ].join(":");
  const identity = sha256(binding);
  const request = {
    leaseId: `rrml-${identity}`,
    expectedCommitSha,
    workflowRunId,
    workflowRunAttempt: Number(workflowRunAttempt),
    operation,
    loginRole: `rr_migration_${identity.slice(0, 24)}`,
    password,
    nonce,
  };
  const issuerUrl = readCredential(issuerFile);
  const raw = runPsql({
    databaseUrl: issuerUrl,
    environment,
    input: `\\set ON_ERROR_STOP on\nBEGIN;\nSELECT reviewrouter_migration_credential.issue(${sqlLiteral(JSON.stringify(request))}::jsonb)::text;\nCOMMIT;\n`,
  });
  let lease;
  try {
    lease = JSON.parse(raw.split("\n").filter(Boolean).at(-1));
  } catch {
    throw new Error("release_authority_credential_issue_response_invalid");
  }
  if (
    lease?.leaseId !== request.leaseId ||
    lease?.loginRole !== request.loginRole ||
    lease?.expectedCommitSha !== expectedCommitSha ||
    lease?.workflowRunId !== workflowRunId ||
    lease?.workflowRunAttempt !== Number(workflowRunAttempt) ||
    lease?.operation !== operation ||
    lease?.nonce !== nonce ||
    lease?.passwordSha256 !== `sha256:${sha256(password)}`
  )
    throw new Error("release_authority_credential_issue_binding_invalid");
  writeFileSync(
    outputUrlFile,
    leasedUrl(issuerUrl, request.loginRole, password),
    {
      mode: 0o600,
      flag: "wx",
    },
  );
  writeFileSync(outputLeaseFile, JSON.stringify(lease), {
    mode: 0o600,
    flag: "wx",
  });
  return Object.freeze({ leaseId: lease.leaseId, expiresAt: lease.expiresAt });
};

export const reconcileMigrationCredentials = (environment = process.env) => {
  const issuerFile = required(
    environment,
    "REVIEW_ROUTER_RELEASE_AUTHORITY_CREDENTIAL_ISSUER_DATABASE_URL_FILE",
  );
  const raw = runPsql({
    databaseUrl: readCredential(issuerFile),
    environment,
    input:
      "\\set ON_ERROR_STOP on\nBEGIN;\nSELECT reviewrouter_migration_credential.reconcile();\nCOMMIT;\n",
  });
  if (!/^[0-9]+$/u.test(raw.split("\n").filter(Boolean).at(-1) ?? ""))
    throw new Error("release_authority_credential_reconcile_response_invalid");
  return Number(raw.split("\n").filter(Boolean).at(-1));
};

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const command = process.argv[2];
  if (command === "issue") issueMigrationCredential();
  else if (command === "reconcile") reconcileMigrationCredentials();
  else throw new Error("release_authority_credential_command_required");
}
