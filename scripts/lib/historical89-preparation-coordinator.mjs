import {
  createHash,
  createHmac,
  pbkdf2Sync,
  randomBytes,
  randomUUID,
} from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createReadStream } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { renderHistorical89PreparationReadSql } from "./render-historical89-preparation-custody.mjs";
import { RenderApiAdapter } from "../../packages/features/release-rollout/src/adapters/render-api.ts";
import { renderManagedEvidenceDigest } from "./render-schema-handoff-policy.mjs";
import { createSecretSafePostgresInvocation } from "./secret-safe-command-boundary.mjs";

const fail = (reason) => {
  throw new Error(`historical89_coordinator:${reason}`);
};
const sha256 = (bytes) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const name = (key) => {
  if (!/^[a-z0-9][a-z0-9._-]{0,180}$/u.test(key)) fail("journal_key");
  return key;
};

/** Immutable local journal. The operator must place this directory on retained
 * storage. Atomic publication never replaces an existing request, including CAS
 * coordinates. A leftover private temporary file is never treated as evidence. */
export function createHistorical89Journal(directory) {
  const root = resolve(directory);
  try {
    mkdirSync(root, { mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const syncDirectory = (directory = root) => {
    const fd = openSync(
      directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  };
  syncDirectory(dirname(root));
  const bytes = (key) => {
    let fd;
    try {
      fd = openSync(
        join(root, name(key)),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      return readFileSync(fd);
    } catch (error) {
      if (error.code === "ENOENT") return undefined;
      throw error;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  };
  const putBytes = (key, value) => {
    const data = Buffer.from(value);
    const previous = bytes(key);
    if (previous) {
      if (!previous.equals(data)) fail("durable_request_conflict");
      return sha256(previous);
    }
    const temporary = join(root, `.pending-${randomUUID()}`);
    const fd = openSync(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeFileSync(fd, data);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      try {
        linkSync(temporary, join(root, name(key)));
      } catch (error) {
        if (error.code !== "EEXIST" || !bytes(key)?.equals(data))
          fail("durable_request_conflict");
      }
      syncDirectory();
    } finally {
      unlinkSync(temporary);
      syncDirectory();
    }
    return sha256(data);
  };
  const get = (key) => {
    const value = bytes(key);
    return value ? JSON.parse(value.toString("utf8")) : undefined;
  };
  const put = (key, value) => putBytes(key, JSON.stringify(value));
  return Object.freeze({
    root,
    bytes,
    putBytes,
    get,
    put,
    once(key, factory) {
      const value = get(key);
      if (value !== undefined) return value;
      const fresh = factory();
      put(key, fresh);
      return fresh;
    },
    keys(prefix) {
      return readdirSync(root)
        .filter((key) => key.startsWith(prefix) && !key.startsWith(".pending-"))
        .sort();
    },
  });
}

async function hashRegularFd(fd) {
  const before = fstatSync(fd);
  if (!before.isFile() || before.size <= 0) fail("backup_file_invalid");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(null, {
    fd,
    autoClose: false,
    start: 0,
  }))
    hash.update(chunk);
  const after = fstatSync(fd);
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size
  )
    fail("backup_file_changed");
  return {
    bytes: after.size,
    sha256: `sha256:${hash.digest("hex")}`,
    capturedAt: after.mtime.toISOString(),
  };
}

export async function captureHistorical89RetainedBackup({
  databaseUrl,
  journal,
  operationId,
  retentionKey,
  execute = spawnSync,
}) {
  if (!/^[0-9a-f-]{36}$/u.test(operationId)) fail("backup_operation_id");
  if (!/^[a-fA-F0-9]{64}$/u.test(retentionKey ?? "")) fail("retention_key");
  const retainedRoot = dirname(journal.root);
  const path = join(retainedRoot, `historical89-${operationId}.dump.gpg`);
  const scratch = mkdtempSync(
    join(process.env.RUNNER_TEMP ?? "/tmp", "rr-h89-backup-"),
  );
  const plain = join(scratch, "database.dump");
  const verified = join(scratch, "verified.dump");
  const pending = join(
    retainedRoot,
    `.pending-historical89-${operationId}-${randomUUID()}.gpg`,
  );
  for (const entry of readdirSync(retainedRoot)) {
    if (!entry.startsWith(`.pending-historical89-${operationId}-`)) continue;
    const stale = join(retainedRoot, entry);
    const staleFd = openSync(stale, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!fstatSync(staleFd).isFile()) fail("backup_pending_invalid");
    } finally {
      closeSync(staleFd);
    }
    unlinkSync(stale);
  }
  let descriptor;
  try {
    descriptor = openSync(
      plain,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    const invocation = createSecretSafePostgresInvocation({ databaseUrl });
    try {
      const result = execute(
        "pg_dump",
        [...invocation.args, "--format=custom", "--no-password"],
        {
          env: invocation.environment,
          stdio: ["ignore", descriptor, "pipe"],
          timeout: 600_000,
          maxBuffer: 1024 * 1024,
        },
      );
      if (result?.status !== 0 || result?.error) fail("backup_dump_failed");
    } finally {
      invocation.cleanup();
    }
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    const encrypted = execute(
      "gpg",
      [
        "--batch",
        "--yes",
        "--pinentry-mode",
        "loopback",
        "--passphrase-fd",
        "0",
        "--symmetric",
        "--cipher-algo",
        "AES256",
        "--output",
        pending,
        plain,
      ],
      { input: retentionKey, timeout: 600_000 },
    );
    if (encrypted?.status !== 0 || encrypted?.error)
      fail("backup_encryption_failed");
    unlinkSync(plain);
    const pendingFd = openSync(
      pending,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    if (!fstatSync(pendingFd).isFile()) fail("backup_ciphertext_invalid");
    const decrypted = execute(
      "gpg",
      [
        "--batch",
        "--yes",
        "--pinentry-mode",
        "loopback",
        "--passphrase-fd",
        "0",
        "--decrypt",
        "--output",
        verified,
        "/proc/self/fd/3",
      ],
      {
        input: retentionKey,
        timeout: 600_000,
        stdio: ["pipe", "pipe", "pipe", pendingFd],
      },
    );
    closeSync(pendingFd);
    if (decrypted?.status !== 0 || decrypted?.error)
      fail("backup_decryption_failed");
    const verifyFd = openSync(
      verified,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      await hashRegularFd(verifyFd);
      const listed = execute("pg_restore", ["--list"], {
        encoding: "utf8",
        stdio: [verifyFd, "pipe", "pipe"],
        timeout: 120_000,
        maxBuffer: 16 * 1024 * 1024,
      });
      if (
        listed?.status !== 0 ||
        listed?.error ||
        !String(listed.stdout ?? "").trim()
      )
        fail("backup_unreadable");
    } finally {
      closeSync(verifyFd);
    }
    unlinkSync(verified);
    const prePublishFd = openSync(
      pending,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      if (!fstatSync(prePublishFd).isFile()) fail("backup_pending_invalid");
      fsyncSync(prePublishFd);
    } finally {
      closeSync(prePublishFd);
    }
    const prePublishDirectory = openSync(
      retainedRoot,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      fsyncSync(prePublishDirectory);
    } finally {
      closeSync(prePublishDirectory);
    }
    let adopted = false;
    try {
      linkSync(pending, path);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      adopted = true;
    }
    unlinkSync(pending);
    if (adopted) {
      const adoptedCipherFd = openSync(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      if (!fstatSync(adoptedCipherFd).isFile()) fail("backup_adoption_invalid");
      const adoptedDecrypt = execute(
        "gpg",
        [
          "--batch",
          "--yes",
          "--pinentry-mode",
          "loopback",
          "--passphrase-fd",
          "0",
          "--decrypt",
          "--output",
          verified,
          "/proc/self/fd/3",
        ],
        {
          input: retentionKey,
          timeout: 600_000,
          stdio: ["pipe", "pipe", "pipe", adoptedCipherFd],
        },
      );
      closeSync(adoptedCipherFd);
      if (adoptedDecrypt?.status !== 0 || adoptedDecrypt?.error)
        fail("backup_adoption_decryption_failed");
      const adoptedFd = openSync(
        verified,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        await hashRegularFd(adoptedFd);
        const adoptedList = execute("pg_restore", ["--list"], {
          encoding: "utf8",
          stdio: [adoptedFd, "pipe", "pipe"],
          timeout: 120_000,
          maxBuffer: 16 * 1024 * 1024,
        });
        if (
          adoptedList?.status !== 0 ||
          !String(adoptedList.stdout ?? "").trim()
        )
          fail("backup_adoption_unreadable");
      } finally {
        closeSync(adoptedFd);
      }
      unlinkSync(verified);
    }
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(pending);
    } catch {
      // The pending artifact may not exist after a failed creation.
    }
    if (/^historical89_coordinator:/u.test(error.message)) throw error;
    fail("backup_capture_failed");
  } finally {
    for (const temporary of [plain, verified])
      try {
        unlinkSync(temporary);
      } catch {
        // Temporary plaintext may already have been removed.
      }
    try {
      rmdirSync(scratch);
    } catch {
      // Scratch cleanup is best effort after its contents are removed.
    }
  }
  const ciphertextFd = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  const measured = await hashRegularFd(ciphertextFd);
  fsyncSync(ciphertextFd);
  closeSync(ciphertextFd);
  const metadata = Object.freeze({
    format: "postgresql-custom-gpg",
    ...measured,
  });
  if (metadata.bytes <= 0) fail("backup_empty");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const rootFd = openSync(
    retainedRoot,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    fsyncSync(rootFd);
  } finally {
    closeSync(rootFd);
  }
  journal.put("recovery", metadata);
  return metadata;
}

export async function verifyHistorical89RetainedBackup(journal, metadata) {
  const identity = journal.get("identity");
  const path = join(
    dirname(journal.root),
    `historical89-${identity.operationId}.dump.gpg`,
  );
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const measured = await hashRegularFd(fd);
  closeSync(fd);
  if (
    metadata?.format !== "postgresql-custom-gpg" ||
    measured.bytes !== metadata.bytes ||
    measured.sha256 !== metadata.sha256
  )
    fail("backup_integrity");
  return metadata;
}

// A complete renderer may return advisory-lock rows and a COMMIT command after
// its single JSON projection. Do not mistake COMMIT.rows=[] for missing custody.
export function historical89JsonResult(response) {
  const values = (Array.isArray(response) ? response : [response])
    .flatMap((part) => part.rows ?? [])
    .filter((row) => Object.keys(row).length === 1)
    .map((row) => Object.values(row)[0])
    .filter((value) => value !== null && typeof value === "object");
  if (values.length !== 1) fail("ambiguous_json_result");
  return values[0];
}
export async function readHistorical89Json(client, sql) {
  return historical89JsonResult(await client.query(sql));
}

export const historical89BackendSql = `SELECT jsonb_build_object(
  'systemIdentifier',(SELECT system_identifier::text FROM pg_control_system()),
  'databaseOid',(SELECT oid::text FROM pg_database WHERE datname=current_database()),
  'databaseName',current_database(),'pid',pg_backend_pid(),
  'backendStart',(SELECT to_char(backend_start AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') FROM pg_stat_activity WHERE pid=pg_backend_pid()))`;

export async function historical89BackendState(client, expected) {
  const actual = await readHistorical89Json(client, historical89BackendSql);
  for (const key of ["systemIdentifier", "databaseOid", "databaseName"])
    if (actual[key] !== expected[key]) return "unknown";
  const response = await client.query({
    text: `SELECT to_char(backend_start AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS started FROM pg_stat_activity WHERE datid=$1::oid AND pid=$2`,
    values: [expected.databaseOid, expected.pid],
  });
  if (response.rows.length === 0) return "terminated";
  if (response.rows.length !== 1 || !response.rows[0].started) return "unknown";
  return response.rows[0].started === expected.backendStart
    ? "alive"
    : "terminated";
}

/** Records the exact source-rendered request and backend before submission.
 * Unknown effects never become ACKs. The caller supplies only a source-owned
 * action; public CLI inputs cannot provide SQL or change an existing request. */
export async function submitHistorical89Transition({
  client,
  journal,
  key,
  request,
  execute,
}) {
  journal.put(`${key}.request`, request);
  const completed = journal.get(`${key}.complete`);
  if (completed !== undefined) return completed.value;
  const attempts = journal
    .keys(`${key}.attempt-`)
    .filter((k) => k.endsWith(".start"));
  if (attempts.length >= 8) fail("transition_attempt_budget");
  for (const attempt of attempts) {
    if (journal.get(attempt.replace(/\.start$/u, ".rollback"))) continue;
    const previous = journal.get(attempt);
    if (
      (await historical89BackendState(client, previous.backend)) !==
      "terminated"
    )
      fail("original_backend_unresolved");
  }
  const attempt = `${key}.attempt-${attempts.length}`;
  const backend = await readHistorical89Json(client, historical89BackendSql);
  journal.put(`${attempt}.start`, {
    backend,
    requestDigest: renderManagedEvidenceDigest(request),
  });
  const value = await execute({
    rollbackConfirmed() {
      journal.put(`${attempt}.rollback`, { backend });
    },
  });
  journal.put(`${key}.complete`, { value: value ?? null });
  return value;
}

/** Recording transport for the supported Render adapter. Only GET service and
 * POST suspend are allowed. No authorization headers or arbitrary error bodies
 * enter the journal. A POST ACK is independent from observed suspension. */
export function createHistorical89Render({
  token,
  journal,
  serviceIds,
  fetchImpl = globalThis.fetch,
}) {
  const transport = async (input, init = {}) => {
    const url = new URL(input);
    const method = init.method ?? "GET";
    const match = url.pathname.match(
      /^\/v1\/services\/(srv-[a-z0-9]+)(\/(?:suspend|resume))?$/u,
    );
    if (
      url.origin !== "https://api.render.com" ||
      url.search ||
      !match ||
      !serviceIds.includes(match[1]) ||
      (init.body !== undefined && init.body !== null) ||
      (method === "POST"
        ? !["/suspend", "/resume"].includes(match[2])
        : method !== "GET" || match[2])
    )
      fail("provider_request_scope");
    const key = `provider-${randomUUID()}`;
    const request = {
      method,
      serviceId: match[1],
      resource: url.pathname,
      attemptedAt: new Date().toISOString(),
      body: null,
    };
    journal.put(`${key}.request`, request);
    let response;
    try {
      response = await fetchImpl(input, init);
      // Bounded bytes, including providers that omit Content-Length. These two
      // endpoints contain service metadata, never credentials or environment.
      const reader = response.body?.getReader();
      const chunks = [];
      let size = 0;
      if (reader)
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 64 * 1024) {
              await reader.cancel();
              fail("provider_response_size");
            }
            chunks.push(Buffer.from(value));
          }
        } finally {
          reader.releaseLock();
        }
      const body = Buffer.concat(chunks);
      if (token && body.includes(Buffer.from(token)))
        fail("provider_response_contains_credential");
      const requestId = response.headers.get("x-request-id");
      journal.put(`${key}.response`, {
        request,
        status: response.status,
        requestId:
          requestId && /^[a-zA-Z0-9._:-]{1,160}$/u.test(requestId)
            ? requestId
            : null,
        body: body.toString("utf8"),
        observedAt: new Date().toISOString(),
      });
      return new globalThis.Response(body.length ? body : null, {
        status: response.status,
        headers: response.headers,
      });
    } catch {
      journal.put(`${key}.unknown`, { request, outcome: "transport-unknown" });
      fail("provider_transport_unknown");
    }
  };
  return new RenderApiAdapter(token, transport);
}

// Only successful protocol-level SCRAM authentication is accepted. A supplied
// password on a trust connection is not proof that the password works.
export async function connectHistorical89Reader(configuration) {
  const client = new pg.Client(configuration);
  let scram = false;
  client.connection.on("authenticationSASLFinal", () => {
    scram = true;
  });
  try {
    await client.connect();
    if (!scram) fail("reader_password_authentication_required");
    return client;
  } catch {
    await client.end().catch(() => {});
    fail("reader_password_authentication_failed");
  }
}

/** Passwords arrive only through the existing reader connection secret. The
 * verifier is never part of a rendered/journaled transition. Provisioning is
 * idempotent and only follows source verification of our own prepared role.
 * Printable ASCII passwords have identical PostgreSQL/client SASLprep bytes.
 * Parameter logging must already be disabled by the trusted DB configuration;
 * this helper does not acquire privileges or change cluster logging policy. */
export async function provisionHistorical89Reader(
  client,
  identity,
  binding,
  password,
) {
  if (typeof password !== "string" || !/^[\x20-\x7e]{1,1024}$/u.test(password))
    fail("reader_secret_required");
  try {
    await readHistorical89Json(
      client,
      renderHistorical89PreparationReadSql(identity, binding).replace(
        /COMMIT;$/u,
        "",
      ),
    );
    const logging = await client.query(`SELECT
      current_setting('log_parameter_max_length') AS parameters,
      current_setting('log_parameter_max_length_on_error') AS errors`);
    if (
      logging.rows.length !== 1 ||
      logging.rows[0].parameters !== "0" ||
      logging.rows[0].errors !== "0"
    )
      fail("reader_secret_logging");
    const salt = randomBytes(16);
    const salted = pbkdf2Sync(password, salt, 4096, 32, "sha256");
    const clientKey = createHmac("sha256", salted)
      .update("Client Key")
      .digest();
    const stored = createHash("sha256").update(clientKey).digest("base64");
    const server = createHmac("sha256", salted)
      .update("Server Key")
      .digest("base64");
    const verifier = `SCRAM-SHA-256$4096:${salt.toString("base64")}$${stored}:${server}`;
    await client.query({
      text: "SELECT set_config('reviewrouter.reader_verifier',$1,true)",
      values: [verifier],
    });
    await client.query(`DO $credential$ BEGIN
      EXECUTE format('ALTER ROLE reviewrouter_operation_custody_reader PASSWORD %L',
        current_setting('reviewrouter.reader_verifier'));
      PERFORM set_config('reviewrouter.reader_verifier','',true);
    EXCEPTION WHEN query_canceled OR OTHERS THEN RAISE EXCEPTION 'reader_credential_failed';
    END $credential$;`);
    await client.query("COMMIT;");
  } catch {
    await client.query("ROLLBACK;").catch(() => {});
    fail("reader_credential_provisioning_failed");
  }
}

// Source-owned executable closure, including transitive renderers and their
// local imports. Capture bytes at module load, never from an operator checkout
// path. A registry-only registration can live after the reviewed source tree.
const executableRoot = fileURLToPath(new URL("../../", import.meta.url));
const executableFiles = Object.freeze([
  "packages/features/release-rollout/src/adapters/bounded-provider-io.ts",
  "packages/features/release-rollout/src/adapters/effective-principal-postgres.mjs",
  "packages/features/release-rollout/src/adapters/live-v70-v72-catalog-digest.mjs",
  "packages/features/release-rollout/src/adapters/render-api.ts",
  "packages/features/release-rollout/src/application/service-transition-ports.ts",
  "packages/features/release-rollout/src/domain/activation-catalog-policy-artifact.generated.js",
  "packages/features/release-rollout/src/domain/activation-catalog-policy-contract.ts",
  "packages/features/release-rollout/src/domain/activation-catalog-policy-normalization.ts",
  "packages/features/release-rollout/src/domain/activation-catalog-policy-provenance-contract.ts",
  "packages/features/release-rollout/src/domain/activation-catalog-policy-raw-promotion-trust-root.json",
  "packages/features/release-rollout/src/domain/activation-catalog-policy-raw-promotion-trust-root.ts",
  "packages/features/release-rollout/src/domain/canonical-json.ts",
  "packages/features/release-rollout/src/domain/effective-principal-inventory.ts",
  "packages/features/release-rollout/src/domain/release-authority-contract.ts",
  "packages/features/release-rollout/src/domain/release-image-provenance.ts",
  "packages/features/release-rollout/src/domain/release-migration-artifact-identity.js",
  "packages/features/release-rollout/src/domain/release-migration-transition.ts",
  "packages/features/release-rollout/src/domain/release-rollout.ts",
  "packages/features/release-rollout/src/domain/sanitized-diagnostic.js",
  "packages/features/release-rollout/src/domain/service-transition.ts",
  "packages/features/release-rollout/src/domain/trusted-rollout-evidence.ts",
  "scripts/lib/historical89-preparation-coordinator.mjs",
  "scripts/lib/render-historical89-admission.mjs",
  "scripts/lib/render-historical89-execution-boundary.mjs",
  "scripts/lib/render-historical89-inplace-transaction.mjs",
  "scripts/lib/render-historical89-operation.mjs",
  "scripts/lib/render-historical89-phase.mjs",
  "scripts/lib/render-historical89-preparation-custody.mjs",
  "scripts/lib/render-historical89-prerequisite-capture.mjs",
  "scripts/lib/render-historical96-checkout.mjs",
  "scripts/lib/render-managed-catalog.mjs",
  "scripts/lib/render-managed-operation-custody.mjs",
  "scripts/lib/render-managed-transaction-bodies.mjs",
  "scripts/lib/render-managed-workflow-cutover.mjs",
  "scripts/lib/render-retained-exclusion.mjs",
  "scripts/lib/render-schema-handoff-policy.mjs",
  "scripts/lib/render-schema-handoff-transaction.mjs",
  "scripts/lib/secret-safe-command-boundary.mjs",
  "scripts/lib/verify-historical89-already96.mjs",
  "scripts/reconcile-codex-rotating-legacy-ambiguity.mjs",
  "scripts/run-codex-rotating-release-migration.mjs",
  "scripts/run-historical89-inplace-operation.mjs",
]);
const loadedSources = new Map(
  executableFiles.map((path) => [
    path,
    readFileSync(join(executableRoot, path)),
  ]),
);
function sourceProjection(path, bytes) {
  const source = bytes.toString("utf8");
  if (path !== "scripts/lib/render-historical89-admission.mjs") return source;
  const pattern =
    /const reviewedHistorical89Contracts = Object\.freeze\((\{[\s\S]*?\})\);/u;
  const match = source.match(pattern);
  if (!match) fail("executable_registry_shape");
  // Registration is JSON data only, never an executable override. Only these
  // source-pinned proof references may differ from the reviewed snapshot.
  let registry;
  try {
    registry = JSON.parse(match[1].replace(/,\s*\}/gu, "}"));
  } catch {
    fail("executable_registry_shape");
  }
  const reference = (value) =>
    value &&
    Object.keys(value).sort().join() === "digest,path" &&
    typeof value.path === "string" &&
    /^[a-zA-Z0-9._/-]+$/u.test(value.path) &&
    /^sha256:[a-f0-9]{64}$/u.test(value.digest);
  if (Object.keys(registry).join() !== "managed-historical89-in-place/v1")
    fail("executable_registry_shape");
  const value = registry["managed-historical89-in-place/v1"];
  if (
    value !== null &&
    (Object.keys(value).sort().join() !== "digest,path" ||
      !reference({ path: value.path, digest: value.digest }))
  )
    fail("executable_registry_shape");
  return source.replace(
    pattern,
    "const reviewedHistorical89Contracts = Object.freeze({});",
  );
}
const historical89ActivationPaths = Object.freeze([
  "scripts/lib/render-historical89-admission.mjs",
  "scripts/lib/render-historical89-admission.test.ts",
  "scripts/lib/render-historical89-reviewed-bundle.json",
]);
export function assertHistorical89ExecutingSource(request, identity) {
  try {
    const git = (args) =>
      execFileSync("git", args, {
        cwd: executableRoot,
        maxBuffer: 8 * 1024 * 1024,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
    const executingTree = git([
      "rev-parse",
      `${request.sourceCommit}^{tree}`,
    ]).trim();
    if (executingTree !== identity.sourceTree) {
      // CI checks out a shallow, ancestry-limited clone (for pull_request
      // events, GitHub's synthetic merge commit puts the reviewed guard
      // commit one generation beyond the configured fetch depth). Widen the
      // local history on demand rather than fail closed on an absent object
      // that a full clone would already have.
      try {
        execFileSync(
          "git",
          ["cat-file", "-e", `${identity.sourceTree}^{tree}`],
          {
            cwd: executableRoot,
            stdio: ["ignore", "ignore", "ignore"],
          },
        );
      } catch {
        if (git(["rev-parse", "--is-shallow-repository"]).trim() === "true")
          execFileSync("git", ["fetch", "--unshallow", "origin"], {
            cwd: executableRoot,
            stdio: ["ignore", "ignore", "ignore"],
          });
      }
      const changed = git([
        "diff",
        "--name-only",
        identity.sourceTree,
        request.sourceCommit,
        "--",
      ])
        .trim()
        .split("\n")
        .filter(Boolean)
        .sort();
      if (
        changed.some((path) => !historical89ActivationPaths.includes(path)) ||
        !changed.includes("scripts/lib/render-historical89-admission.mjs") ||
        !changed.includes(
          "scripts/lib/render-historical89-reviewed-bundle.json",
        )
      )
        fail("executable_source");
      const admission = Buffer.from(
        git([
          "show",
          `${request.sourceCommit}:scripts/lib/render-historical89-admission.mjs`,
        ]),
      );
      const admissionPath = "scripts/lib/render-historical89-admission.mjs";
      const reviewedAdmission = Buffer.from(
        git(["show", `${identity.sourceTree}:${admissionPath}`]),
      );
      if (
        sourceProjection(admissionPath, admission) !==
        sourceProjection(admissionPath, reviewedAdmission)
      )
        fail("executable_source");
      const match = admission
        .toString("utf8")
        .match(
          /const reviewedHistorical89Contracts = Object\.freeze\((\{[\s\S]*?\})\);/u,
        );
      const registry = JSON.parse(match[1].replace(/,\s*\}/gu, "}"));
      const review = registry["managed-historical89-in-place/v1"];
      if (
        review?.path !== "./render-historical89-reviewed-bundle.json" ||
        Object.keys(review).sort().join() !== "digest,path"
      )
        fail("executable_registry_shape");
      const bundlePath = historical89ActivationPaths[2];
      const committedBundle = Buffer.from(
        git(["show", `${request.sourceCommit}:${bundlePath}`]),
      );
      if (
        `sha256:${createHash("sha256").update(committedBundle).digest("hex")}` !==
          review.digest ||
        !committedBundle.equals(readFileSync(join(executableRoot, bundlePath)))
      )
        fail("executable_registry_shape");
    }
    const artifact = readFileSync(request.artifactPath);
    if (
      sha256(artifact) !== identity.authorizedBinaryArtifactDigest ||
      !artifact.equals(
        loadedSources.get("scripts/run-historical89-inplace-operation.mjs"),
      )
    )
      fail("executable_artifact");
    for (const [path, loaded] of loadedSources) {
      // Reject resolution shadows (for example an untracked .js beside an
      // extensionless .ts import) as well as modified reviewed source bytes.
      const requireFromSource = createRequire(join(executableRoot, path));
      for (const match of loaded
        .toString("utf8")
        .matchAll(/(?:\bfrom\s*|\bimport\s*\()(["'])([^"']+)\1/gu)) {
        if (!match[2].startsWith(".")) continue;
        let resolved;
        try {
          resolved = realpathSync(requireFromSource.resolve(match[2]));
        } catch (error) {
          if (error.code !== "MODULE_NOT_FOUND") throw error;
          resolved = realpathSync(
            resolve(
              executableRoot,
              dirname(path),
              `${match[2].replace(/\.js$/u, "")}.ts`,
            ),
          );
        }
        if (
          !executableFiles.some(
            (file) => join(executableRoot, file) === resolved,
          )
        )
          fail("executable_closure_resolution");
      }
      if (
        !loaded.equals(readFileSync(join(executableRoot, path))) ||
        sourceProjection(path, loaded) !==
          sourceProjection(
            path,
            Buffer.from(git(["show", `${request.sourceCommit}:${path}`])),
          )
      )
        fail("executable_closure");
    }
    return sha256(artifact);
  } catch (error) {
    if (/^historical89_coordinator:executable_[a-z_]+$/u.test(error.message))
      throw error;
    fail("executable_closure");
  }
}
