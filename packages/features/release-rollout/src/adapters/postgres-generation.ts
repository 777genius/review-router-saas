import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import {
  RolloutStep,
  sha256Canonical,
  type DatabaseGenerationIdentity,
  type StepReceipt,
} from "../domain/release-rollout";
import type {
  BackupIdentity,
  EquivalenceEvidence,
  QuiescenceEvidence,
} from "../domain/trusted-rollout-evidence";
import type { CommandExecutor } from "./process-command";

const runtimeRoles = Object.freeze([
  "reviewrouter_api",
  "reviewrouter_web",
  "reviewrouter_worker",
  "reviewrouter_codex_effect_authority",
]);
const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/u;

interface Connection {
  readonly env: NodeJS.ProcessEnv;
  readonly args: readonly string[];
}

function connection(value: string): Connection {
  const url = new URL(value);
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !url.hostname ||
    (!/\.internal$/u.test(url.hostname) &&
      !/^dpg-[a-z0-9-]+$/u.test(url.hostname)) ||
    !url.pathname.slice(1) ||
    !url.username ||
    !url.password
  )
    throw new Error("postgres_generation_connection_invalid");
  return {
    env: {
      ...process.env,
      PGHOST: url.hostname,
      PGPORT: url.port || "5432",
      PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
      PGUSER: decodeURIComponent(url.username),
      PGPASSWORD: decodeURIComponent(url.password),
      PGSSLMODE: url.searchParams.get("sslmode") ?? "require",
    },
    args: [
      "--host",
      url.hostname,
      "--port",
      url.port || "5432",
      "--username",
      decodeURIComponent(url.username),
      "--dbname",
      decodeURIComponent(url.pathname.slice(1)),
    ],
  };
}

function digest(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function receipt(step: StepReceipt["step"], payload: unknown): StepReceipt {
  const payloadSha256 = `sha256:${sha256Canonical(payload)}`;
  return Object.freeze({
    step,
    receiptId: `${step}-${payloadSha256.slice(7, 31)}`,
    observedAt: new Date().toISOString(),
    payloadSha256,
  });
}

export class PostgreSqlGenerationAdapter {
  constructor(private readonly commands: CommandExecutor) {}

  private psql(url: string, sql: string): string {
    const target = connection(url);
    return this.commands
      .execute(
        "psql",
        [
          ...target.args,
          "--no-psqlrc",
          "--set",
          "ON_ERROR_STOP=1",
          "--tuples-only",
          "--no-align",
          "--command",
          sql,
        ],
        { env: target.env },
      )
      .stdout.trim();
  }

  observeIdentity(
    url: string,
    expected: DatabaseGenerationIdentity,
  ): DatabaseGenerationIdentity {
    const observed = JSON.parse(
      this.psql(
        url,
        `SELECT json_build_object(
          'systemIdentifier', system_identifier::text,
          'majorVersion', current_setting('server_version_num')::integer / 10000,
          'recoveryWitnessSha256', (shobj_description(database.oid, 'pg_database')::jsonb)->>'recoveryWitnessSha256'
        ) FROM pg_control_system(), pg_database database WHERE database.datname = current_database()`,
      ),
    ) as Record<string, unknown>;
    if (
      observed.systemIdentifier !== expected.systemIdentifier ||
      observed.majorVersion !== expected.majorVersion ||
      observed.recoveryWitnessSha256 !== expected.recoveryWitnessSha256
    )
      throw new Error("postgres_generation_identity_mismatch");
    return expected;
  }

  captureBackup(input: {
    sourceUrl: string;
    dumpPath: string;
    backup: BackupIdentity;
  }): { dumpSha256: string; backup: BackupIdentity; receipt: StepReceipt } {
    const path = resolve(input.dumpPath);
    if (
      (!path.startsWith("/runner/_work/") &&
        !path.startsWith("/tmp/reviewrouter-pg17-rehearsal/")) ||
      basename(path).length < 3
    )
      throw new Error("postgres_generation_dump_path_unsafe");
    const source = connection(input.sourceUrl);
    this.commands.execute(
      "pg_dump",
      [
        ...source.args,
        "--format=custom",
        "--no-owner",
        "--no-privileges",
        "--file",
        path,
      ],
      { env: source.env },
    );
    const dumpSha256 = digest(readFileSync(path));
    const payload = { backup: input.backup, dumpSha256 };
    return {
      ...payload,
      receipt: receipt(RolloutStep.CaptureSourceBackup, payload),
    };
  }

  quiesceSource(sourceUrl: string): {
    evidence: QuiescenceEvidence;
    receipt: StepReceipt;
  } {
    const roles = runtimeRoles
      .map((role) => `REVOKE CONNECT ON DATABASE :"DBNAME" FROM ${role};`)
      .join("\n");
    const observed = JSON.parse(
      this.psql(
        sourceUrl,
        `BEGIN;
${roles}
SELECT pg_terminate_backend(pid) FROM pg_stat_activity
WHERE datname = current_database() AND pid <> pg_backend_pid();
SELECT json_build_object(
  'writersSuspended', true,
  'nonCutoverSessionCount', (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()),
  'sourceRuntimeConnectRevoked', NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = ANY(ARRAY[${runtimeRoles.map((role) => `'${role}'`).join(",")}])
      AND has_database_privilege(rolname, current_database(), 'CONNECT')
  )
);
COMMIT;`,
      )
        .split("\n")
        .find((line) => line.startsWith("{")) ?? "null",
    ) as QuiescenceEvidence;
    if (
      observed.writersSuspended !== true ||
      observed.nonCutoverSessionCount !== 0 ||
      observed.sourceRuntimeConnectRevoked !== true
    )
      throw new Error("postgres_generation_quiescence_failed");
    return {
      evidence: observed,
      receipt: receipt(RolloutStep.QuiesceSource, observed),
    };
  }

  restoreCopy(input: {
    targetUrl: string;
    dumpPath: string;
    dumpSha256: string;
  }): StepReceipt {
    const path = resolve(input.dumpPath);
    if (digest(readFileSync(path)) !== input.dumpSha256)
      throw new Error("postgres_generation_dump_digest_mismatch");
    const target = connection(input.targetUrl);
    const count = Number(
      this.psql(
        input.targetUrl,
        "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','S','v','m')",
      ),
    );
    if (count !== 0) throw new Error("postgres_generation_target_not_empty");
    this.commands.execute(
      "pg_restore",
      [
        ...target.args,
        "--no-owner",
        "--no-privileges",
        "--exit-on-error",
        path,
      ],
      { env: target.env },
    );
    return receipt(RolloutStep.CopyDatabaseGeneration, {
      dumpSha256: input.dumpSha256,
      ownershipRestored: false,
      privilegesRestored: false,
    });
  }

  private snapshot(url: string): {
    tables: Map<string, { rows: number; sha256: string }>;
    sequencesSha256: string;
    constraintsSha256: string;
    indexesSha256: string;
    migrationHistorySha256: string;
  } {
    const tableNames = JSON.parse(
      this.psql(
        url,
        "SELECT coalesce(json_agg(tablename ORDER BY tablename), '[]'::json) FROM pg_tables WHERE schemaname='public'",
      ),
    ) as string[];
    if (tableNames.some((name) => !identifier.test(name)))
      throw new Error("postgres_generation_table_identifier_invalid");
    const tables = new Map<string, { rows: number; sha256: string }>();
    for (const table of tableNames) {
      const rows = this.psql(
        url,
        `SELECT encode(convert_to(row_to_json(value)::text, 'UTF8'), 'hex') FROM public."${table}" value ORDER BY row_to_json(value)::text`,
      );
      tables.set(table, {
        rows: rows ? rows.split("\n").length : 0,
        sha256: digest(rows),
      });
    }
    const metadata = (sql: string) => digest(this.psql(url, sql));
    return {
      tables,
      sequencesSha256: metadata(
        "SELECT json_agg(value ORDER BY value->>'name') FROM (SELECT json_build_object('name', sequencename, 'dataType', data_type, 'start', start_value, 'min', min_value, 'max', max_value, 'increment', increment_by, 'cycle', cycle, 'cache', cache_size, 'last', last_value) value FROM pg_sequences WHERE schemaname='public') observed",
      ),
      constraintsSha256: metadata(
        "SELECT json_agg(value ORDER BY value->>'table', value->>'name') FROM (SELECT json_build_object('table', c.conrelid::regclass::text, 'name', c.conname, 'definition', pg_get_constraintdef(c.oid)) value FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public') observed",
      ),
      indexesSha256: metadata(
        "SELECT json_agg(value ORDER BY value->>'table', value->>'name') FROM (SELECT json_build_object('table', tablename, 'name', indexname, 'definition', indexdef) value FROM pg_indexes WHERE schemaname='public') observed",
      ),
      migrationHistorySha256: metadata(
        'SELECT coalesce(json_agg(row_to_json(m) ORDER BY "migration_name"), \'[]\'::json) FROM public."_prisma_migrations" m',
      ),
    };
  }

  verifyEquivalence(
    sourceUrl: string,
    targetUrl: string,
  ): {
    evidence: EquivalenceEvidence;
    receipt: StepReceipt;
  } {
    const source = this.snapshot(sourceUrl);
    const target = this.snapshot(targetUrl);
    if (
      source.tables.size === 0 ||
      source.tables.size !== target.tables.size ||
      [...source.tables.keys()].some((table) => !target.tables.has(table))
    )
      throw new Error("postgres_generation_table_set_mismatch");
    const tables = [...source.tables].map(([table, left]) => {
      const right = target.tables.get(table)!;
      return {
        table,
        sourceRows: left.rows,
        targetRows: right.rows,
        sourceSha256: left.sha256,
        targetSha256: right.sha256,
      };
    });
    const metadataMatches =
      source.sequencesSha256 === target.sequencesSha256 &&
      source.constraintsSha256 === target.constraintsSha256 &&
      source.indexesSha256 === target.indexesSha256 &&
      source.migrationHistorySha256 === target.migrationHistorySha256;
    if (
      tables.some(
        (table) =>
          table.sourceRows !== table.targetRows ||
          table.sourceSha256 !== table.targetSha256,
      ) ||
      !metadataMatches
    )
      throw new Error("postgres_generation_equivalence_failed");
    const evidence: EquivalenceEvidence = Object.freeze({
      tables: Object.freeze(tables),
      sequencesSha256: source.sequencesSha256,
      constraintsSha256: source.constraintsSha256,
      indexesSha256: source.indexesSha256,
      migrationHistorySha256: source.migrationHistorySha256,
      equivalent: true,
    });
    return {
      evidence,
      receipt: receipt(RolloutStep.VerifyDataEquivalence, evidence),
    };
  }
}
