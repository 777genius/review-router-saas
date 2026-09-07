import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { Duplex } from "node:stream";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { spawnMigration89Process } from "../codex-rotating-migration89-process.mjs";
import { readRenderSchemaHandoffCatalog } from "./render-schema-handoff-policy.mjs";

// Only an owned, labelled, offline container. No database URL, Docker context,
// image override, host mount, published port or ambient credential is accepted.
export function managedPg17Fixture() {
  const token = randomUUID();
  const name = `rr-retained-${token}`;
  const environment = { PATH: process.env.PATH, LANG: "C.UTF-8" };
  const host = ["--host", "unix:///var/run/docker.sock"];
  const image =
    "postgres:17.10@sha256:7958605b474b3d264a969cb3a123d6aa00ad1e1fe9da8a69984dabb704d93317";
  let created = false;
  const docker = (args: string[], input?: string | Buffer, timeout = 30_000) =>
    spawnSync("docker", [...host, ...args], {
      env: environment,
      input,
      encoding: "utf8",
      timeout,
      maxBuffer: 16 * 1024 * 1024,
    });
  const checked = (
    args: string[],
    input?: string | Buffer,
    timeout?: number,
  ) => {
    const result = docker(args, input, timeout);
    if (result.status !== 0 || result.error)
      throw new Error(
        `managed_pg17_fixture_command:${args[0]}:${(result.error as NodeJS.ErrnoException | undefined)?.code ?? result.status ?? result.signal}:${result.stderr}`,
      );
    return result.stdout.trim();
  };
  const psql = (database: string, role = "reviewrouter", port = "5432") => [
    ...host,
    "exec",
    "--env",
    "PGSSLMODE=disable",
    "--env",
    "PGGSSENCMODE=disable",
    "-i",
    name,
    "psql",
    "-h",
    "127.0.0.1",
    "-p",
    port,
    "-U",
    role,
    "-d",
    database,
    "-XqAt",
    "-v",
    "ON_ERROR_STOP=1",
  ];
  const query = (database: string, source: string, role = "reviewrouter") =>
    checked(psql(database, role).slice(host.length), source);
  const session = (database: string, role = "reviewrouter") =>
    spawnMigration89Process({
      binary: "docker",
      args: psql(database, role),
      environment,
      input: undefined,
      keepStdinOpen: true,
      timeoutMs: 60_000,
    });
  const cleanup = () => {
    const identity = docker([
      "inspect",
      "--format",
      '{{ index .Config.Labels "reviewrouter.retained.proof" }}',
      name,
    ]);
    if (identity.status === 0 && identity.stdout.trim() === token) {
      checked(["rm", "--force", "--volumes", name]);
      created = false;
    } else if (created)
      throw new Error("managed_pg17_cleanup_identity_unknown");
  };
  const start = async () => {
    checked(["image", "inspect", image]);
    // A timed-out create can still leave a daemon-owned object. Cleanup must
    // establish its absence or remove this exact label even without an ACK.
    created = true;
    checked(
      [
        "create",
        "--pull=never",
        "--name",
        name,
        "--label",
        `reviewrouter.retained.proof=${token}`,
        "--network",
        "none",
        "--read-only",
        "--tmpfs",
        "/var/lib/postgresql/data:rw",
        "--tmpfs",
        "/var/run/postgresql:rw",
        "--tmpfs",
        "/tmp:rw,exec",
        "--env",
        "POSTGRES_HOST_AUTH_METHOD=trust",
        image,
      ],
      undefined,
      60_000,
    );
    checked(["start", name]);
    await waitFor(
      () =>
        docker(psql("postgres", "postgres").slice(host.length), "SELECT 1")
          .status === 0,
    );
    if (query("postgres", "SHOW server_version_num", "postgres") !== "170010")
      throw new Error("managed_pg17_version");
    // Reuse the installed Prisma engine; no CLI download or dependency install.
    const require = createRequire(import.meta.url);
    const engine = join(
      dirname(
        require.resolve("@prisma/engines/package.json", {
          paths: [require.resolve("prisma/package.json")],
        }),
      ),
      "schema-engine-debian-openssl-3.0.x",
    );
    // docker cp targets the read-only rootfs even for this tmpfs destination.
    // Stream the installed bytes through a process in the existing container;
    // the rootfs stays read-only and no host mount or network is introduced.
    checked(
      ["exec", "-i", name, "sh", "-c", "cat > /tmp/rr-managed-schema-engine"],
      readFileSync(engine),
    );
    checked(["exec", name, "chmod", "0755", "/tmp/rr-managed-schema-engine"]);
    if (
      checked(["exec", name, "/tmp/rr-managed-schema-engine", "--version"]) !==
      "schema-engine-cli 3c6e192761c0362d496ed980de936e2f3cebcd3a"
    )
      throw new Error("managed_pg17_prisma_engine_version");
    checked(
      ["exec", "-i", name, "sh", "-c", "cat > /tmp/rr-managed-schema.prisma"],
      readFileSync(
        new URL(
          "../../packages/platform/db/prisma/schema.prisma",
          import.meta.url,
        ),
      ),
    );
  };
  const apply = (database: string, count: number, applicationName: string) => {
    const catalog = readRenderSchemaHandoffCatalog().slice(0, count);
    const request =
      JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "applyMigrations",
        params: {
          migrationsList: {
            baseDir: "/tmp/managed-source",
            lockfile: {
              path: "migration_lock.toml",
              content: 'provider = "postgresql"\n',
            },
            migrationDirectories: catalog.map((row) => {
              const source = readFileSync(
                new URL(
                  `../../packages/platform/db/prisma/migrations/${row.migrationName}/migration.sql`,
                  import.meta.url,
                ),
                "utf8",
              );
              if (
                createHash("sha256").update(source).digest("hex") !==
                row.checksum
              )
                throw new Error("fixture_source_changed");
              return {
                path: row.migrationName,
                migrationFile: {
                  path: "migration.sql",
                  content: { tag: "ok", value: source },
                },
              };
            }),
            shadowDbInitScript: "",
          },
          filters: { externalTables: [], externalEnums: [] },
        },
      }) + "\n";
    const url = new URL(`postgresql://reviewrouter@127.0.0.1:5432/${database}`);
    url.searchParams.set("application_name", applicationName);
    const process = spawnMigration89Process({
      binary: "docker",
      environment,
      keepStdinOpen: true,
      args: [
        ...host,
        "exec",
        "-i",
        name,
        "sh",
        "-c",
        'echo $$ > /tmp/rr-managed-engine.pid; exec /tmp/rr-managed-schema-engine --datamodels /tmp/rr-managed-schema.prisma --datasource "$1"',
        "managed-engine",
        JSON.stringify({ url: url.toString() }),
      ],
      input: request,
      maxInputBytes: 16 * 1024 * 1024,
      timeoutMs: 120_000,
    });
    // The process supervisor contains the Docker client, not processes in the
    // daemon. Stop the known engine PID inside our own container before return.
    const stop = async () => {
      try {
        checked([
          "exec",
          name,
          "sh",
          "-c",
          'pid=$(cat /tmp/rr-managed-engine.pid); case "$pid" in *[!0-9]*|"") exit 71;; esac; if test -e "/proc/$pid/exe"; then test "$(readlink /proc/$pid/exe)" = /tmp/rr-managed-schema-engine || exit 72; kill -TERM "$pid"; fi',
        ]);
        await waitFor(
          () =>
            docker([
              "exec",
              name,
              "sh",
              "-c",
              'test ! -e "/proc/$(cat /tmp/rr-managed-engine.pid)/exe"',
            ]).status === 0,
        );
        await waitFor(
          () =>
            query(
              database,
              `SELECT count(*) FROM pg_catalog.pg_stat_activity
          WHERE datname=current_database() AND application_name='${applicationName.replaceAll("'", "''")}'`,
              "postgres",
            ) === "0",
        );
      } catch (error) {
        // An unconfirmed contained engine cannot be left running between tests.
        cleanup();
        throw error;
      } finally {
        await process.terminateAndWait();
      }
    };
    const result = (async (): Promise<string[]> => {
      let offset = 0;
      try {
        for (;;) {
          const output = process.stdout();
          const newline = output.indexOf("\n", offset);
          if (newline >= 0) {
            const frame = JSON.parse(output.slice(offset, newline));
            offset = newline + 1;
            if (frame.method === "print")
              process.write(
                JSON.stringify({ id: frame.id, jsonrpc: "2.0", result: {} }) +
                  "\n",
              );
            else if (frame.id === 1 && frame.error)
              throw new Error(
                `prisma_apply_failed:${JSON.stringify(frame.error)}`,
              );
            else if (frame.id === 1 && frame.result)
              return frame.result.appliedMigrationNames;
          } else {
            if (process.closedResult())
              throw new Error(`prisma_engine_closed:${process.stderr()}`);
            await delay(10);
          }
        }
      } finally {
        await stop();
      }
    })();
    void result.catch(() => {});
    return { result };
  };
  const loseCommitResponse = async (database: string) => {
    // The proxy and both TCP endpoints are INSIDE the same --network=none
    // disposable container. It withholds COMMIT's actual wire response until
    // the server sends CommandComplete + ReadyForQuery(I), then disconnects.
    // Discarding a subprocess's stdout would not test acknowledgement loss.
    checked(
      ["exec", "-i", name, "sh", "-c", "cat > /tmp/rr-managed-node"],
      readFileSync(process.execPath),
    );
    checked(["exec", name, "chmod", "0755", "/tmp/rr-managed-node"]);
    checked(
      [
        "exec",
        "-i",
        name,
        "sh",
        "-c",
        "cat > /tmp/rr-managed-commit-proxy.mjs",
      ],
      commitLossProxy,
    );
    checked([
      "exec",
      name,
      "rm",
      "-f",
      "/tmp/rr-managed-proxy-ready",
      "/tmp/rr-managed-commit-dropped",
    ]);
    const proxy = spawnMigration89Process({
      binary: "docker",
      environment,
      input: undefined,
      args: [
        ...host,
        "exec",
        name,
        "/tmp/rr-managed-node",
        "/tmp/rr-managed-commit-proxy.mjs",
      ],
      timeoutMs: 60_000,
    });
    await waitFor(
      () =>
        docker(["exec", name, "test", "-f", "/tmp/rr-managed-proxy-ready"])
          .status === 0,
    );
    const client = spawnMigration89Process({
      binary: "docker",
      environment,
      input: undefined,
      args: psql(database, "reviewrouter", "6543"),
      keepStdinOpen: true,
      timeoutMs: 60_000,
    });
    return {
      client,
      committedResponseDropped: () =>
        checked(["exec", name, "cat", "/tmp/rr-managed-commit-dropped"]) ===
        "COMMIT:I",
      close: async () => {
        await client.terminateAndWait();
        await proxy.terminateAndWait();
      },
    };
  };
  let wireNodeInstalled = false;
  const wireStream = () => {
    if (!wireNodeInstalled) {
      checked(
        ["exec", "-i", name, "sh", "-c", "cat > /tmp/rr-managed-wire-node"],
        readFileSync(process.execPath),
      );
      checked(["exec", name, "chmod", "0755", "/tmp/rr-managed-wire-node"]);
      wireNodeInstalled = true;
    }
    // PostgreSQL and both TCP endpoints remain inside --network=none. Only raw
    // protocol bytes cross stdio; no host sockets, mounts or published ports.
    const child = spawn(
      "docker",
      [
        ...host,
        "exec",
        "-i",
        name,
        "/tmp/rr-managed-wire-node",
        "--input-type=module",
        "-e",
        "import net from 'node:net'; const socket=net.connect(5432,'127.0.0.1'); process.stdin.pipe(socket); socket.pipe(process.stdout); socket.on('error',()=>{process.exitCode=1;process.stdin.destroy();}); socket.on('close',()=>process.stdin.destroy());",
      ],
      { env: environment, stdio: ["pipe", "pipe", "ignore"] },
    );
    const stream = new Duplex({
      read() {},
      write(chunk, encoding, callback) {
        child.stdin.write(chunk, encoding, callback);
      },
      final(callback) {
        child.stdin.end(callback);
      },
      destroy(error, callback) {
        child.stdin.destroy();
        if (child.exitCode !== null) {
          callback(error);
          return;
        }
        const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
        child.once("close", () => {
          clearTimeout(timer);
          callback(error);
        });
      },
    }) as Duplex & {
      connect: () => Duplex;
      setNoDelay: () => Duplex;
      setKeepAlive: () => Duplex;
    };
    stream.connect = () => {
      queueMicrotask(() => stream.emit("connect"));
      return stream;
    };
    stream.setNoDelay = () => stream;
    stream.setKeepAlive = () => stream;
    child.stdout.on("data", (chunk) => stream.push(chunk));
    child.stdout.on("end", () => stream.push(null));
    child.on("error", () =>
      stream.destroy(new Error("managed_pg17_wire_process")),
    );
    child.on("close", (code) => {
      if (code !== 0) stream.destroy(new Error("managed_pg17_wire_closed"));
    });
    return stream;
  };
  return {
    start,
    cleanup,
    query,
    session,
    apply,
    loseCommitResponse,
    wireStream,
  };
}

// PostgreSQL Simple Query framing, including startup and fragmented frames.
// Unexpected framing aborts the disposable proof; nothing is forwarded as a
// successful commit until a real server response proves that it committed.
const commitLossProxy = String.raw`
import net from 'node:net';
import { writeFileSync } from 'node:fs';
let closing=false;
const close=()=>{ if(!closing){ closing=true; server.close(); } };
const server=net.createServer(client=>{
  const upstream=net.createConnection({host:'127.0.0.1',port:5432});
  let front=Buffer.alloc(0), back=Buffer.alloc(0), startup=true, startupReply=true;
  const queries=[];
  const abort=()=>{ process.exitCode=1; client.destroy(); upstream.destroy(); close(); };
  client.on('error',abort); upstream.on('error',abort);
  client.on('close',()=>{ upstream.destroy(); close(); });
  upstream.on('end',()=>client.end());
  client.on('data',chunk=>{
    front=Buffer.concat([front,chunk]);
    while(front.length >= (startup?4:5)){
      const size=front.readUInt32BE(startup?0:1)+(startup?0:1);
      if(size<(startup?8:5)||size>16*1024*1024) return abort();
      if(front.length<size) return;
      const frame=front.subarray(0,size); front=front.subarray(size);
      if(startup){ if(frame.readUInt32BE(4)!==196608) return abort(); startup=false; }
      else if(frame[0]===81) queries.push({commit:/^\s*COMMIT\s*;?\s*$/i.test(frame.subarray(5,-1).toString()),complete:false,frames:[]});
      upstream.write(frame);
    }
  });
  upstream.on('data',chunk=>{
    back=Buffer.concat([back,chunk]);
    while(back.length>=5){
      const size=back.readUInt32BE(1)+1;
      if(size<5||size>16*1024*1024) return abort();
      if(back.length<size) return;
      const frame=back.subarray(0,size); back=back.subarray(size);
      const query=startupReply?undefined:queries[0];
      if(query?.commit){ query.frames.push(frame); if(frame[0]===67&&frame.subarray(5).toString()==='COMMIT\0') query.complete=true; }
      else client.write(frame);
      if(frame[0]===90){
        if(startupReply){ startupReply=false; continue; }
        queries.shift();
        if(query?.commit){
          if(query.complete&&frame[5]===73){
            writeFileSync('/tmp/rr-managed-commit-dropped','COMMIT:I');
            client.destroy(); upstream.destroy(); close(); return;
          }
          for(const held of query.frames) client.write(held);
        }
      }
    }
  });
});
server.on('error',()=>{ process.exitCode=1; });
server.listen(6543,'127.0.0.1',()=>writeFileSync('/tmp/rr-managed-proxy-ready','ready'));
`;

export async function waitFor(predicate: () => boolean, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error("managed_pg17_observation_timeout");
    await delay(50);
  }
}

// Fixture-only predecessor construction through the accepted libraries. No
// production receipt is issued. Seed SQL must contain disposable data only.
export async function prepareManaged92Fixture(
  pg: ReturnType<typeof managedPg17Fixture>,
  database: string,
  seedSql: string,
) {
  if (!/^[a-z][a-z0-9_]*$/u.test(database)) throw new Error("fixture_database");
  const policy = await import("./render-schema-handoff-policy.mjs");
  const { renderRetainedLedgerGuard, renderManagedCoordinatorExclusionSql } =
    await import("./render-retained-exclusion.mjs");
  const { renderSchemaHandoffTransaction } =
    await import("./render-schema-handoff-transaction.mjs");
  pg.query(
    "postgres",
    `CREATE ROLE reviewrouter LOGIN; CREATE DATABASE ${database} OWNER reviewrouter;`,
    "postgres",
  );
  await pg.apply(database, 76, "rr-cutover-fixture-baseline").result;
  pg.query(database, `ALTER SCHEMA public OWNER TO reviewrouter; ${seedSql}`);
  pg.query(
    "postgres",
    `CREATE ROLE reviewrouter_release_schema_owner;
    CREATE ROLE reviewrouter_release_migration LOGIN;
    CREATE ROLE reviewrouter_comment_token_custody LOGIN;
    CREATE ROLE reviewrouter_api LOGIN;
    CREATE ROLE cutover_inherited;
    GRANT reviewrouter_release_schema_owner TO reviewrouter
    WITH ADMIN TRUE, INHERIT FALSE, SET FALSE GRANTED BY postgres;`,
    "postgres",
  );
  const retainedBinding = {
    operationId: randomUUID(),
    implementationSha: "7870300e71932d8b8cf185004641470d0283cf11",
    custodyDigest: policy.renderManagedEvidenceDigest(
      JSON.parse(pg.query(database, policy.renderManagedLedgerSql)),
    ),
  };
  const guard = renderRetainedLedgerGuard(retainedBinding);
  pg.query(
    database,
    `GRANT USAGE, CREATE ON SCHEMA public TO reviewrouter_release_schema_owner;
    ${policy.renderManagedTemporaryMembershipSql}
    BEGIN; ${renderManagedCoordinatorExclusionSql} ${guard.installSql} COMMIT;`,
  );
  await pg.apply(database, 89, guard.applicationName).result;
  pg.query(
    database,
    `BEGIN; ${renderManagedCoordinatorExclusionSql} ${guard.verifySql}
    ALTER TABLE public."ReviewProviderScopeConcurrencyControl" OWNER TO reviewrouter_release_schema_owner;
    ALTER TABLE public."ReviewInvocationLeaseV2" OWNER TO reviewrouter_release_schema_owner;
    REVOKE CREATE ON SCHEMA public FROM reviewrouter_release_schema_owner;
    ${policy.renderManagedMembershipCleanupSql} COMMIT;`,
  );
  const originalMembership = JSON.parse(
    pg.query(database, policy.renderManagedMembershipSql),
  )[0];
  pg.query(
    database,
    renderSchemaHandoffTransaction({
      ledger: JSON.parse(pg.query(database, policy.renderManagedLedgerSql)),
      retainedBinding,
      originalMembership,
    }) + "\nCOMMIT;",
  );
  return { originalMembership };
}
