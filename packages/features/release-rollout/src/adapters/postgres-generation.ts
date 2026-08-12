import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  RolloutStep,
  type DatabaseGenerationIdentity,
  type StepObservation,
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
const safeEnvironment = (): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
  LANG: "C.UTF-8",
  PGSSLMODE: "require",
  PGCONNECT_TIMEOUT: "5",
});

interface Connection {
  readonly env: NodeJS.ProcessEnv;
  readonly args: readonly string[];
  readonly cleanup: () => void;
}
function escaped(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll(":", "\\:");
}
export function decomposePostgresConnection(value: string): Connection {
  const url = new URL(value);
  const host = url.hostname;
  const database = decodeURIComponent(url.pathname.slice(1));
  const user = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !host ||
    (!/\.internal$/u.test(host) && !/^dpg-[a-z0-9-]+$/u.test(host)) ||
    !database ||
    !user ||
    !password
  )
    throw new Error("postgres_generation_connection_invalid");
  const directory = mkdtempSync(join(tmpdir(), "rr-pgpass-"));
  chmodSync(directory, 0o700);
  const passfile = join(directory, "pgpass");
  writeFileSync(
    passfile,
    `${escaped(host)}:${escaped(url.port || "5432")}:${escaped(database)}:${escaped(user)}:${escaped(password)}\n`,
    { mode: 0o600, flag: "wx" },
  );
  return {
    env: {
      ...safeEnvironment(),
      PGPASSFILE: passfile,
      PGSSLMODE: url.searchParams.get("sslmode") ?? "require",
    },
    args: [
      "--host",
      host,
      "--port",
      url.port || "5432",
      "--username",
      user,
      "--dbname",
      database,
    ],
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

const digest = (value: string | Buffer): string =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;
const observation = <T>(
  step: StepObservation["step"],
  facts: T,
): StepObservation<T> =>
  Object.freeze({ step, observedAt: new Date().toISOString(), facts });

export interface WriterSuspensionObservation {
  readonly services: readonly {
    readonly serviceId: string;
    readonly suspended: true;
    readonly observedAt: string;
  }[];
  readonly complete: true;
}

export class PostgreSqlGenerationAdapter {
  constructor(private readonly commands: CommandExecutor) {}

  private psql(url: string, sql: string): string {
    const target = decomposePostgresConnection(url);
    try {
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
    } finally {
      target.cleanup();
    }
  }

  observeIdentity(
    url: string,
    expected: DatabaseGenerationIdentity,
  ): DatabaseGenerationIdentity {
    const observed = JSON.parse(
      this.psql(
        url,
        `SELECT json_build_object('systemIdentifier', system_identifier::text, 'majorVersion', current_setting('server_version_num')::integer / 10000, 'internalHostname', '${expected.internalHostname}', 'databaseName', current_database(), 'recoveryWitnessSha256', (shobj_description(database.oid, 'pg_database')::jsonb)->>'recoveryWitnessSha256') FROM pg_control_system(), pg_database database WHERE database.datname = current_database()`,
      ),
    );
    if (
      observed.systemIdentifier !== expected.systemIdentifier ||
      observed.majorVersion !== expected.majorVersion ||
      observed.internalHostname !== expected.internalHostname ||
      observed.databaseName !== expected.databaseName ||
      observed.recoveryWitnessSha256 !== expected.recoveryWitnessSha256
    )
      throw new Error("postgres_generation_identity_mismatch");
    return expected;
  }

  captureBackup(input: {
    sourceUrl: string;
    dumpPath: string;
    backup: BackupIdentity;
  }): {
    dumpSha256: string;
    backup: BackupIdentity;
    observation: StepObservation;
  } {
    const path = resolve(input.dumpPath);
    if (
      (!path.startsWith("/runner/_work/") &&
        !path.startsWith("/tmp/reviewrouter-pg17-rehearsal/")) ||
      basename(path).length < 3
    )
      throw new Error("postgres_generation_dump_path_unsafe");
    const source = decomposePostgresConnection(input.sourceUrl);
    try {
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
    } finally {
      source.cleanup();
    }
    const dumpSha256 = digest(readFileSync(path));
    const facts = { backup: input.backup, dumpSha256 };
    return {
      ...facts,
      observation: observation(RolloutStep.CaptureSourceBackup, facts),
    };
  }

  quiesceSource(input: {
    adminUrl: string;
    writerSuspension: WriterSuspensionObservation;
    reconnectUrls: Readonly<Record<string, string>>;
  }): { evidence: QuiescenceEvidence; observation: StepObservation } {
    if (
      input.writerSuspension.complete !== true ||
      input.writerSuspension.services.length === 0 ||
      input.writerSuspension.services.some(
        (service) => service.suspended !== true,
      )
    )
      throw new Error("postgres_generation_writers_not_observably_suspended");
    if (
      Object.keys(input.reconnectUrls).sort().join(",") !==
      [...runtimeRoles].sort().join(",")
    )
      throw new Error("postgres_generation_reconnect_probe_set_incomplete");
    const roleSql = runtimeRoles
      .map((role) => `REVOKE CONNECT ON DATABASE :"DBNAME" FROM ${role};`)
      .join("\n");
    this.psql(
      input.adminUrl,
      `BEGIN; REVOKE CONNECT ON DATABASE :"DBNAME" FROM PUBLIC; ${roleSql} COMMIT;`,
    );
    this.psql(
      input.adminUrl,
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()`,
    );
    const acl = JSON.parse(
      this.psql(
        input.adminUrl,
        `SELECT json_build_object('effectiveConnectDenied', NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=ANY(ARRAY[${runtimeRoles.map((role) => `'${role}'`).join(",")}]) AND has_database_privilege(rolname,current_database(),'CONNECT')), 'publicConnectDenied', NOT has_database_privilege('public',current_database(),'CONNECT'), 'membershipSha256', encode(digest(coalesce((SELECT string_agg(member.rolname||'>'||parent.rolname,',' ORDER BY member.rolname,parent.rolname) FROM pg_auth_members m JOIN pg_roles member ON member.oid=m.member JOIN pg_roles parent ON parent.oid=m.roleid),''),'sha256'),'hex'))`,
      ),
    );
    if (acl.effectiveConnectDenied !== true || acl.publicConnectDenied !== true)
      throw new Error("postgres_generation_effective_connect_remains");
    const stabilizationSeries: number[] = [];
    for (let sample = 0; sample < 3; sample += 1) {
      stabilizationSeries.push(
        Number(
          this.psql(
            input.adminUrl,
            "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()",
          ),
        ),
      );
      if (sample < 2) this.psql(input.adminUrl, "SELECT pg_sleep(0.2)");
    }
    if (stabilizationSeries.some((count) => count !== 0))
      throw new Error("postgres_generation_sessions_not_stable");
    const reconnectDenied: string[] = [];
    for (const role of runtimeRoles) {
      try {
        this.psql(input.reconnectUrls[role]!, "SELECT 1");
      } catch {
        reconnectDenied.push(role);
      }
    }
    if (reconnectDenied.length !== runtimeRoles.length)
      throw new Error("postgres_generation_reconnect_probe_succeeded");
    const evidence: QuiescenceEvidence = Object.freeze({
      writerServices: input.writerSuspension.services,
      aclSha256: digest(JSON.stringify(acl)),
      stabilizationSeries: Object.freeze(stabilizationSeries),
      reconnectDeniedRoles: Object.freeze(reconnectDenied),
      complete: true,
    });
    return {
      evidence,
      observation: observation(RolloutStep.QuiesceSource, evidence),
    };
  }

  restoreCopy(input: {
    targetUrl: string;
    dumpPath: string;
    dumpSha256: string;
  }): StepObservation {
    const path = resolve(input.dumpPath);
    if (digest(readFileSync(path)) !== input.dumpSha256)
      throw new Error("postgres_generation_dump_digest_mismatch");
    const count = Number(
      this.psql(
        input.targetUrl,
        "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_toast' AND c.relkind IN ('r','p','S','v','m')",
      ),
    );
    if (count !== 0) throw new Error("postgres_generation_target_not_empty");
    const target = decomposePostgresConnection(input.targetUrl);
    try {
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
    } finally {
      target.cleanup();
    }
    return observation(RolloutStep.CopyDatabaseGeneration, {
      dumpSha256: input.dumpSha256,
      ownershipRestored: false,
      privilegesRestored: false,
    });
  }

  private async snapshot(url: string): Promise<{
    tables: Map<string, { rows: number; sha256: string }>;
    metadata: Record<string, string>;
  }> {
    const tableNames = JSON.parse(
      this.psql(
        url,
        "SELECT coalesce(json_agg(n.nspname||'.'||c.relname ORDER BY n.nspname,c.relname),'[]'::json) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_toast'",
      ),
    ) as string[];
    if (
      tableNames.some((name) =>
        name.split(".").some((part) => !identifier.test(part)),
      )
    )
      throw new Error("postgres_generation_table_identifier_invalid");
    const tables = new Map<string, { rows: number; sha256: string }>();
    for (const qualified of tableNames) {
      const [schema, table] = qualified.split(".") as [string, string];
      const connection = decomposePostgresConnection(url);
      try {
        const hashed = await this.commands.hashStdout(
          "psql",
          [
            ...connection.args,
            "--no-psqlrc",
            "--set",
            "ON_ERROR_STOP=1",
            "--tuples-only",
            "--no-align",
            "--command",
            `COPY (SELECT row_to_json(value)::text FROM "${schema}"."${table}" value ORDER BY row_to_json(value)::text) TO STDOUT`,
          ],
          { env: connection.env },
        );
        tables.set(qualified, hashed);
      } finally {
        connection.cleanup();
      }
    }
    const catalog = (sql: string) => digest(this.psql(url, sql));
    const sequenceNames = JSON.parse(
      this.psql(
        url,
        "SELECT coalesce(json_agg(schemaname||'.'||sequencename ORDER BY schemaname,sequencename),'[]'::json) FROM pg_sequences WHERE schemaname NOT IN ('pg_catalog','information_schema')",
      ),
    ) as string[];
    if (
      sequenceNames.some((name) =>
        name.split(".").some((part) => !identifier.test(part)),
      )
    )
      throw new Error("postgres_generation_sequence_identifier_invalid");
    const sequenceFacts = sequenceNames.map((qualified) => {
      const [schema, name] = qualified.split(".") as [string, string];
      return JSON.parse(
        this.psql(
          url,
          `SELECT json_build_object('schema','${schema}','name','${name}','lastValue',value.last_value,'isCalled',value.is_called,'dataType',definition.data_type,'startValue',definition.start_value,'minValue',definition.min_value,'maxValue',definition.max_value,'incrementBy',definition.increment_by,'cycle',definition.cycle,'cacheSize',definition.cache_size,'owner',pg_get_userbyid(sequence.relowner),'ownedBy',(SELECT dependent.refobjid::regclass::text||'.'||attribute.attname FROM pg_depend dependent JOIN pg_attribute attribute ON attribute.attrelid=dependent.refobjid AND attribute.attnum=dependent.refobjsubid WHERE dependent.objid=sequence.oid AND dependent.deptype IN ('a','i') LIMIT 1)) FROM "${schema}"."${name}" value, pg_class sequence JOIN pg_namespace namespace ON namespace.oid=sequence.relnamespace JOIN pg_sequences definition ON definition.schemaname=namespace.nspname AND definition.sequencename=sequence.relname WHERE namespace.nspname='${schema}' AND sequence.relname='${name}'`,
        ),
      );
    });
    const metadata = {
      sequences: digest(JSON.stringify(sequenceFacts)),
      columnsDefaults: catalog(
        "SELECT json_agg(x ORDER BY x->>'schema',x->>'table',x->>'column') FROM (SELECT json_build_object('schema',n.nspname,'table',c.relname,'column',a.attname,'type',format_type(a.atttypid,a.atttypmod),'notNull',a.attnotnull,'identity',a.attidentity,'generated',a.attgenerated,'default',pg_get_expr(d.adbin,d.adrelid)) x FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attnum>0 AND NOT a.attisdropped AND n.nspname NOT IN ('pg_catalog','information_schema')) q",
      ),
      constraintsIndexesTriggers: catalog(
        "SELECT json_agg(x ORDER BY x::text) FROM (SELECT json_build_object('kind','constraint','oid',c.oid::regclass::text,'name',c.conname,'definition',pg_get_constraintdef(c.oid)) x FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_toast' UNION ALL SELECT json_build_object('kind','index','oid',indexname,'name',tablename,'definition',indexdef) FROM pg_indexes WHERE schemaname NOT IN ('pg_catalog','information_schema') AND schemaname !~ '^pg_toast' UNION ALL SELECT json_build_object('kind','trigger','oid',tgrelid::regclass::text,'name',tgname,'definition',pg_get_triggerdef(t.oid)) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE NOT t.tgisinternal AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_toast') q",
      ),
      policiesRls: catalog(
        "SELECT json_agg(x ORDER BY x::text) FROM (SELECT json_build_object('schema',n.nspname,'table',c.relname,'rls',c.relrowsecurity,'force',c.relforcerowsecurity,'policy',p.polname,'command',p.polcmd,'roles',p.polroles,'qual',pg_get_expr(p.polqual,p.polrelid),'check',pg_get_expr(p.polwithcheck,p.polrelid)) x FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_policy p ON p.polrelid=c.oid WHERE c.relkind IN ('r','p')) q",
      ),
      functionsViewsSchemas: catalog(
        "SELECT json_agg(x ORDER BY x::text) FROM (SELECT json_build_object('kind','function','identity',p.oid::regprocedure::text,'definition',pg_get_functiondef(p.oid)) x FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_toast' AND p.prokind IN ('f','p','w') UNION ALL SELECT json_build_object('kind','view','identity',schemaname||'.'||viewname,'definition',definition) FROM pg_views WHERE schemaname NOT IN ('pg_catalog','information_schema') UNION ALL SELECT json_build_object('kind','schema','identity',nspname,'definition','') FROM pg_namespace WHERE nspname NOT IN ('pg_catalog','information_schema') AND nspname !~ '^pg_toast') q",
      ),
      aclOwnershipDefaults: catalog(
        "SELECT json_agg(x ORDER BY x::text) FROM (SELECT json_build_object('kind','object','identity',c.oid::regclass::text,'owner',pg_get_userbyid(c.relowner),'acl',c.relacl) x FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') UNION ALL SELECT json_build_object('kind','default','identity',d.oid::text,'owner',pg_get_userbyid(d.defaclrole),'acl',d.defaclacl) FROM pg_default_acl d) q",
      ),
      migrationHistory: catalog(
        'SELECT coalesce(json_agg(row_to_json(m) ORDER BY "migration_name"),\'[]\'::json) FROM public."_prisma_migrations" m',
      ),
    };
    return { tables, metadata };
  }

  async verifyEquivalence(
    sourceUrl: string,
    targetUrl: string,
  ): Promise<{ evidence: EquivalenceEvidence; observation: StepObservation }> {
    const [source, target] = await Promise.all([
      this.snapshot(sourceUrl),
      this.snapshot(targetUrl),
    ]);
    if (
      !source.tables.size ||
      source.tables.size !== target.tables.size ||
      [...source.tables.keys()].some((table) => !target.tables.has(table))
    )
      throw new Error("postgres_generation_table_set_mismatch");
    const tables = [...source.tables].map(([table, left]) => ({
      table,
      sourceRows: left.rows,
      targetRows: target.tables.get(table)!.rows,
      sourceSha256: left.sha256,
      targetSha256: target.tables.get(table)!.sha256,
    }));
    if (
      tables.some(
        (table) =>
          table.sourceRows !== table.targetRows ||
          table.sourceSha256 !== table.targetSha256,
      ) ||
      JSON.stringify(source.metadata) !== JSON.stringify(target.metadata)
    )
      throw new Error("postgres_generation_equivalence_failed");
    const evidence: EquivalenceEvidence = Object.freeze({
      tables: Object.freeze(tables),
      catalogSha256: Object.freeze(source.metadata),
      equivalent: true,
      streamingHash: true,
      maxProcessBufferBytes: 8 * 1024 * 1024,
    });
    return {
      evidence,
      observation: observation(RolloutStep.VerifyDataEquivalence, evidence),
    };
  }
}
