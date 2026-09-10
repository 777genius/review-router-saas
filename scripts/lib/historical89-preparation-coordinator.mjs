import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { RenderApiAdapter } from "../../packages/features/release-rollout/src/adapters/render-api.ts";
import { renderManagedEvidenceDigest } from "./render-schema-handoff-policy.mjs";

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
  fetchImpl = fetch,
}) {
  const transport = async (input, init = {}) => {
    const url = new URL(input);
    const method = init.method ?? "GET";
    const match = url.pathname.match(
      /^\/v1\/services\/(srv-[a-z0-9]+)(\/suspend)?$/u,
    );
    if (
      url.origin !== "https://api.render.com" ||
      url.search ||
      !match ||
      !serviceIds.includes(match[1]) ||
      (init.body !== undefined && init.body !== null) ||
      (method === "POST"
        ? match[2] !== "/suspend"
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
      return new Response(body.length ? body : null, {
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
