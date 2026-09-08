import { recoverySemanticCommands } from "./render-historical89-recovery-semantics";
import { createHash } from "node:crypto";
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
  fchmodSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  decomposePostgresConnection,
  PostgreSqlGenerationAdapter,
} from "../../packages/features/release-rollout/src/adapters/postgres-generation";
import {
  RedactedProcessCommandAdapter,
  type CommandExecutor,
} from "../../packages/features/release-rollout/src/adapters/process-command";
import {
  type EffectivePrincipalPolicy,
  type EffectivePrincipalRole,
  type EffectivePrincipalMembership,
  type EffectivePrincipalInventory,
  type EffectivePrincipalGrant,
  assertEffectivePrincipalInventory,
} from "../../packages/features/release-rollout/src/domain/effective-principal-inventory";
import { canonicalJson } from "../../packages/features/release-rollout/src/domain/canonical-json";
import {
  renderManagedLedgerSql,
  readRenderSchemaHandoffCatalog,
} from "./render-schema-handoff-policy.mjs";

// Independent evidence only. The composition root must establish and maintain
// writer exclusion, review the plan, and own disposable target/artifact cleanup.
// This module neither acquires production mutation authority nor drops anything.
export interface RecoveryIdentity {
  systemIdentifier: string;
  database: string;
  databaseOid: string;
  serverVersion: string;
  inRecovery: false;
}
export interface ReviewedRecoveryPlan {
  reviewReference: string;
  roles: readonly EffectivePrincipalRole[];
  memberships: readonly EffectivePrincipalMembership[];
  policy: EffectivePrincipalPolicy;
  databaseOwner: string;
  /** Exact reviewed direct grants, grantors, grant options and ownership. */
  grants: readonly EffectivePrincipalGrant[];
}
export interface RecoveryArtifact {
  readonly directory: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly source: RecoveryIdentity;
  readonly capturedAt: string;
  readonly sourceObservation: {
    readonly tables: readonly { table: string; rows: number; sha256: string }[];
    readonly catalogSha256: Readonly<Record<string, string>>;
    readonly principalInventorySha256: string;
    readonly exactSequencesSha256: string;
  };
  readonly ledger: readonly unknown[];
  readonly exclusionReference: {
    readonly reference: string;
    readonly qualification: "external-unverified";
  };
  readonly consistencyReference: {
    readonly reference: string;
    readonly qualification: "external-unverified";
  };
  readonly limitations: readonly string[];
}
const maximumBytes = 64 * 1024 * 1024;
const hash = (value: string | Buffer) =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;
const equal = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
function fail(code: string): never {
  throw new Error(`historical89_recovery_${code}`);
}
const identifier = (s: string) => {
  if (typeof s !== "string" || !/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/u.test(s))
    fail("unsupported_identifier");
  return `"${s}"`;
};
const reference = (s: string) => {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,159}$/u.test(s) || /:\/\//u.test(s))
    fail("reference_invalid");
  return s;
};
const limitations = Object.freeze([
  "No production mutation or rollout authorization.",
  "Writer exclusion and consistency references are external and unverified; the root must maintain exclusion through verification.",
  "Logical equivalence covers public-schema historical89 on PG17 with plpgsql only, no role/database settings, and database connection limit -1; unsupported catalogs fail closed. Passwords and authentication are not captured or reconstructed.",
  "Internal triggers must retain PostgreSQL default origin mode (O); disabled, replica and always internal modes are unsupported on both source and restore. User rewrite rules are unsupported; only standard origin-mode view _RETURN rules are allowed.",
  "Same-process artifact handle required; root owns private artifact retention and disposable cluster cleanup, including failed restores.",
]);
function frozen<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(frozen);
    Object.freeze(value);
  }
  return value;
}
function query(commands: CommandExecutor, url: string, sql: string): any {
  const c = decomposePostgresConnection(url);
  try {
    return JSON.parse(
      commands
        .execute(
          "psql",
          [
            ...c.args,
            "--no-psqlrc",
            "--tuples-only",
            "--no-align",
            "--set",
            "ON_ERROR_STOP=1",
            "--command",
            sql,
          ],
          { env: c.env, maxBuffer: 8 * 1024 * 1024, timeoutMs: 120_000 },
        )
        .stdout.trim(),
    );
  } finally {
    c.cleanup();
  }
}
function executeSql(commands: CommandExecutor, url: string, sql: string) {
  const c = decomposePostgresConnection(url);
  try {
    commands.execute(
      "psql",
      [...c.args, "--no-psqlrc", "--set", "ON_ERROR_STOP=1", "--command", sql],
      { env: c.env, timeoutMs: 120_000 },
    );
  } finally {
    c.cleanup();
  }
}
export const recoveryIdentitySql = `SELECT json_build_object('systemIdentifier',(SELECT system_identifier::text FROM pg_control_system()),'database',current_database(),'databaseOid',(SELECT oid::text FROM pg_database WHERE datname=current_database()),'serverVersion',current_setting('server_version_num'),'inRecovery',pg_is_in_recovery())`;
function identity(
  commands: CommandExecutor,
  url: string,
  expected: RecoveryIdentity,
) {
  const actual = query(commands, url, recoveryIdentitySql) as RecoveryIdentity;
  if (
    !/^[0-9]+$/u.test(actual.systemIdentifier) ||
    !/^[0-9]+$/u.test(actual.databaseOid) ||
    !/^17[0-9]{4}$/u.test(actual.serverVersion) ||
    actual.inRecovery !== false ||
    !equal(actual, expected)
  )
    fail("identity_mismatch");
  identifier(actual.database);
  return actual;
}
// No OIDs in this logical projection; physical identity is checked separately.
// Reject families not covered by the reusable catalog/principal verifier.
// pg_dump recreates internal constraint triggers with origin mode (O). Only that
// default is supported: reject D/R/A on source and restore, without comparing
// generated RI_ConstraintTrigger names or physical OIDs. User modes remain compared.
// Materialized views are unsupported on source and target: the generic verifier
// reads pg_views, so equal stored rows cannot prove equal future refresh behavior.
// Only standard origin-mode ordinary-view _RETURN rules are exempt from rejection;
// every other public rewrite rule (including disabled rules) is unsupported.
export const recoveryScopeSql = `SELECT json_build_object(
 'schemas',(SELECT json_agg(nspname ORDER BY nspname) FROM pg_namespace WHERE nspname !~ '^pg_' AND nspname<>'information_schema'),
 'settings',(SELECT count(*) FROM pg_db_role_setting),
 'extensions',(SELECT json_agg(json_build_object('name',extname,'version',extversion) ORDER BY extname) FROM pg_extension),
 'database',(SELECT json_build_object('encoding',encoding,'collate',datcollate,'ctype',datctype,'provider',datlocprovider,'locale',datlocale,'icuRules',daticurules,'connectionLimit',datconnlimit,'owner',pg_get_userbyid(datdba),'acl',(SELECT json_agg(json_build_object('grantee',coalesce(r.rolname,'PUBLIC'),'grantor',pg_get_userbyid(a.grantor),'privilege',a.privilege_type,'grantable',a.is_grantable) ORDER BY coalesce(r.rolname,'PUBLIC'),a.privilege_type,pg_get_userbyid(a.grantor),a.is_grantable) FROM aclexplode(coalesce(datacl,acldefault('d',datdba))) a LEFT JOIN pg_roles r ON r.oid=a.grantee)) FROM pg_database WHERE datname=current_database()),
 'types',(SELECT coalesce(json_agg(json_build_object('name',t.typname,'kind',t.typtype,'enum',(SELECT json_agg(enumlabel ORDER BY enumsortorder) FROM pg_enum WHERE enumtypid=t.oid)) ORDER BY t.typname),'[]') FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' AND t.typtype='e'),
 'unsupportedTypes',(SELECT count(*) FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' AND t.typtype NOT IN ('e','c') AND t.typelem=0),
 'unsupportedCatalog',(SELECT count(*) FROM pg_seclabel) + (SELECT count(*) FROM pg_shseclabel) + (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind='a'),
 'relations',(SELECT coalesce(json_agg(json_build_object('name',c.relname,'kind',c.relkind,'persistence',c.relpersistence,'options',c.reloptions,'replicaIdentity',c.relreplident,'accessMethod',am.amname,'partitionKey',pg_get_partkeydef(c.oid),'partitionBound',pg_get_expr(c.relpartbound,c.oid),'parents',(SELECT json_agg(pn.nspname||'.'||parent.relname ORDER BY inh.inhseqno) FROM pg_inherits inh JOIN pg_class parent ON parent.oid=inh.inhparent JOIN pg_namespace pn ON pn.oid=parent.relnamespace WHERE inh.inhrelid=c.oid)) ORDER BY c.relname),'[]') FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_am am ON am.oid=c.relam WHERE n.nspname='public'),
 'columnProperties',(SELECT coalesce(json_agg(json_build_object('table',c.relname,'column',a.attname,'collation',cn.nspname||'.'||coll.collname,'storage',a.attstorage,'compression',a.attcompression,'options',a.attoptions) ORDER BY c.relname,a.attnum),'[]') FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_collation coll ON coll.oid=a.attcollation LEFT JOIN pg_namespace cn ON cn.oid=coll.collnamespace WHERE n.nspname='public' AND a.attnum>0 AND NOT a.attisdropped),
 'unsupportedInternalTriggerModes',(SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND t.tgisinternal AND t.tgenabled<>'O'),
 'unsupportedMaterializedViews',(SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='m'),
 'unsupportedRewriteRules',(SELECT count(*) FROM pg_rewrite r JOIN pg_class c ON c.oid=r.ev_class JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT (c.relkind='v' AND r.rulename='_RETURN' AND r.ev_type='1' AND r.is_instead AND r.ev_enabled='O')),
 'triggerModes',(SELECT coalesce(json_agg(json_build_object('table',c.relname,'trigger',t.tgname,'enabled',t.tgenabled) ORDER BY c.relname,t.tgname),'[]') FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal),
 'visible', (SELECT rolsuper OR rolbypassrls OR NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relrowsecurity AND (c.relforcerowsecurity OR NOT pg_has_role(current_user,c.relowner,'USAGE'))) FROM pg_roles WHERE rolname=current_user))`;
export const recoveryEmptySql = `SELECT json_build_object('empty',
 NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema')
 AND NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema')
 AND NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema')
 AND NOT EXISTS (SELECT 1 FROM pg_default_acl)
 AND NOT EXISTS (SELECT 1 FROM pg_largeobject_metadata)
 AND NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname !~ '^pg_' AND nspname NOT IN ('public','information_schema'))
 AND NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname<>'plpgsql'))`;
// The reused adapter parses JSON numbers. Preserve bigint sequence values as
// decimal TEXT here as well, so adjacent values above 2^53 cannot compare equal.
function exactSequences(commands: CommandExecutor, url: string) {
  const names = query(
    commands,
    url,
    "SELECT coalesce(json_agg(schemaname||'.'||sequencename ORDER BY schemaname,sequencename),'[]'::json) FROM pg_sequences WHERE schemaname IN ('public')",
  );
  if (!Array.isArray(names) || names.length > 10000)
    fail("sequence_inventory_invalid");
  return names.map((qualified: string) => {
    const [schema, name, extra] = qualified.split(".");
    if (schema !== "public" || extra) fail("sequence_identifier_invalid");
    const relation = identifier(name);
    const value = query(
      commands,
      url,
      `SELECT json_build_object('lastValue',s.last_value::text,'isCalled',s.is_called,'definition',(SELECT json_build_object('start',start_value::text,'min',min_value::text,'max',max_value::text,'increment',increment_by::text,'cache',cache_size::text) FROM pg_sequences WHERE schemaname='public' AND sequencename='${name}')) FROM public.${relation} s`,
    );
    if (
      typeof value.lastValue !== "string" ||
      !/^-?[0-9]+$/.test(value.lastValue) ||
      typeof value.isCalled !== "boolean"
    )
      fail("sequence_state_invalid");
    return { name, ...value };
  });
}
function scope(commands: CommandExecutor, url: string) {
  const s = query(commands, url, recoveryScopeSql);
  if (s.unsupportedMaterializedViews !== 0)
    fail("unsupported_materialized_views");
  if (s.unsupportedInternalTriggerModes !== 0)
    fail("unsupported_internal_trigger_modes");
  if (s.unsupportedRewriteRules !== 0)
    fail("unsupported_rewrite_rules");
  if (
    !equal(s.schemas, ["public"]) ||
    s.settings !== 0 ||
    s.unsupportedTypes !== 0 ||
    s.unsupportedCatalog !== 0 ||
    s.database.connectionLimit !== -1 ||
    s.visible !== true ||
    !equal(s.extensions, [{ name: "plpgsql", version: "1.0" }])
  )
    fail("unsupported_scope_or_visibility");
  return { ...s, exactSequences: exactSequences(commands, url) };
}
function ledger(commands: CommandExecutor, url: string) {
  const rows = query(commands, url, renderManagedLedgerSql);
  const catalog = readRenderSchemaHandoffCatalog().slice(0, 89);
  if (
    !Array.isArray(rows) ||
    rows.length !== 89 ||
    rows.some(
      (r, i) =>
        r.migrationName !== catalog[i].migrationName ||
        r.checksum !== catalog[i].checksum ||
        !r.finishedAt ||
        r.rolledBackAt !== null ||
        r.hasLogs ||
        r.appliedStepsCount !== 1 ||
        !/^[0-9a-f-]{36}$/u.test(r.id) ||
        !/^\d{4}-\d\d-\d\dT[\d:.]+Z$/u.test(r.startedAt) ||
        !/^\d{4}-\d\d-\d\dT[\d:.]+Z$/u.test(r.finishedAt),
    )
  )
    fail("ledger_not_full89");
  return rows;
}
function inventory(
  adapter: PostgreSqlGenerationAdapter,
  url: string,
  plan: ReviewedRecoveryPlan,
  enforcePolicy: boolean,
) {
  const i = adapter.inventoryEffectivePrincipals(url);
  if (
    !Array.isArray(i.roleReachability) ||
    !Array.isArray(i.rowSecurity) ||
    !Array.isArray(i.extensions) ||
    !Array.isArray(i.unsupportedAuthorityFamilies) ||
    i.unsupportedAuthorityFamilies.length
  )
    fail("principal_visibility_or_unsupported_authority");
  if (enforcePolicy) assertEffectivePrincipalInventory(i, plan.policy);
  return i;
}
function rolePlan(i: EffectivePrincipalInventory, plan: ReviewedRecoveryPlan) {
  reference(plan.reviewReference);
  identifier(plan.databaseOwner);
  if (!equal(i.roles, plan.roles) || !equal(i.memberships, plan.memberships))
    fail("unreviewed_roles_or_memberships");
}
function measuredFile(directory: string, maxBytes: number, copyTo?: string) {
  const dir = lstatSync(directory);
  if (
    !dir.isDirectory() ||
    dir.isSymbolicLink() ||
    (dir.mode & 0o777) !== 0o700 ||
    realpathSync(directory) !== directory
  )
    fail("artifact_directory_invalid");
  const fd = openSync(
    join(directory, "recovery.dump"),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  let copyFd: number | undefined;
  try {
    const before = fstatSync(fd);
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.size < 5 ||
      before.size > maxBytes ||
      (before.mode & 0o777) !== 0o600
    )
      fail("artifact_file_invalid");
    if (copyTo)
      copyFd = openSync(
        join(copyTo, "recovery.dump"),
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
    const h = createHash("sha256"),
      buffer = Buffer.alloc(64 * 1024);
    let bytes = 0;
    for (;;) {
      const n = readSync(fd, buffer, 0, buffer.length, null);
      if (!n) break;
      if (!bytes && buffer.subarray(0, 5).toString() !== "PGDMP")
        fail("artifact_not_custom_dump");
      bytes += n;
      if (bytes > maxBytes) fail("artifact_too_large");
      h.update(buffer.subarray(0, n));
      if (copyFd !== undefined) writeFileSync(copyFd, buffer.subarray(0, n));
    }
    const after = fstatSync(fd);
    if (
      bytes !== before.size ||
      before.ino !== after.ino ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      fail("artifact_changed_during_hash");
    return { sha256: `sha256:${h.digest("hex")}`, bytes };
  } finally {
    closeSync(fd);
    if (copyFd !== undefined) closeSync(copyFd);
  }
}
type Measured = Awaited<
  ReturnType<PostgreSqlGenerationAdapter["verifyEquivalence"]>
>["evidence"];
const custody = new WeakMap<
  RecoveryArtifact,
  {
    commands: CommandExecutor;
    plan: ReviewedRecoveryPlan;
    evidence: Measured;
    inventory: EffectivePrincipalInventory;
    scope: unknown;
    maxBytes: number;
  }
>();
export async function captureRecoveryArtifact(input: {
  sourceUrl: string;
  expectedSource: RecoveryIdentity;
  directory: string;
  reviewedPlan: ReviewedRecoveryPlan;
  exclusionReference: string;
  consistencyReference: string;
  maxArtifactBytes?: number;
  commands?: CommandExecutor;
}): Promise<RecoveryArtifact> {
  let created = false;
  try {
    const commands = input.commands ?? new RedactedProcessCommandAdapter();
    const maxBytes = input.maxArtifactBytes ?? maximumBytes;
    if (
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 5 ||
      maxBytes > maximumBytes
    )
      fail("artifact_bound_invalid");
    const directory = resolve(input.directory);
    if (
      !isAbsolute(input.directory) ||
      directory !== input.directory ||
      realpathSync(dirname(directory)) !== dirname(directory)
    )
      fail("artifact_path_invalid");
    const exclusionReference = {
      reference: reference(input.exclusionReference),
      qualification: "external-unverified" as const,
    };
    const consistencyReference = {
      reference: reference(input.consistencyReference),
      qualification: "external-unverified" as const,
    };
    const plan = frozen(structuredClone(input.reviewedPlan));
    const source = identity(commands, input.sourceUrl, input.expectedSource);
    const adapter = new PostgreSqlGenerationAdapter(recoverySemanticCommands(commands));
    const initialScope = scope(commands, input.sourceUrl);
    if (initialScope.database.owner !== plan.databaseOwner)
      fail("database_owner_plan_mismatch");
    const initialInventory = inventory(adapter, input.sourceUrl, plan, true);
    rolePlan(initialInventory, plan);
    if (!equal(initialInventory.grants, plan.grants))
      fail("unreviewed_ownership_or_acl");
    const fullLedger = ledger(commands, input.sourceUrl);
    const before = (
      await adapter.verifyEquivalence(
        input.sourceUrl,
        input.sourceUrl,
        ["public"],
        { source: plan.policy, target: plan.policy },
      )
    ).evidence;
    // mkdir is exclusive: an existing directory/artifact is never overwritten.
    mkdirSync(directory, { mode: 0o700 });
    created = true;
    const c = decomposePostgresConnection(input.sourceUrl);
    try {
      commands.execute(
        "pg_dump",
        [
          ...c.args,
          "--format=custom",
          "--file",
          join(directory, "recovery.dump"),
        ],
        { env: c.env, timeoutMs: 600_000 },
      );
    } finally {
      c.cleanup();
    }
    // pg_dump may use the process umask. The private parent is already 0700.
    const path = join(directory, "recovery.dump");
    const dumped = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = fstatSync(dumped);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes)
        fail("artifact_file_invalid");
      fchmodSync(dumped, 0o600);
    } finally {
      closeSync(dumped);
    }
    const file = measuredFile(directory, maxBytes);
    const after = (
      await adapter.verifyEquivalence(
        input.sourceUrl,
        input.sourceUrl,
        ["public"],
        { source: plan.policy, target: plan.policy },
      )
    ).evidence;
    if (
      !equal(before, after) ||
      !equal(fullLedger, ledger(commands, input.sourceUrl)) ||
      !equal(initialScope, scope(commands, input.sourceUrl)) ||
      !equal(initialInventory, inventory(adapter, input.sourceUrl, plan, true))
    )
      fail("source_changed_during_capture");
    identity(commands, input.sourceUrl, source);
    const artifact = frozen({
      directory,
      ...file,
      source,
      capturedAt: new Date().toISOString(),
      sourceObservation: {
        tables: after.tables.map((t) => ({
          table: t.table,
          rows: t.sourceRows,
          sha256: t.sourceSha256,
        })),
        catalogSha256: after.catalogSha256,
        principalInventorySha256: hash(canonicalJson(initialInventory)),
        exactSequencesSha256: hash(canonicalJson(initialScope.exactSequences)),
      },
      ledger: fullLedger,
      exclusionReference,
      consistencyReference,
      limitations,
    });
    custody.set(artifact, {
      commands,
      plan,
      evidence: after,
      inventory: initialInventory,
      scope: initialScope,
      maxBytes,
    });
    return artifact;
  } catch (error) {
    if (created) rmSync(input.directory, { recursive: true, force: true });
    if (
      error instanceof Error &&
      /^historical89_recovery_[a-z0-9_]+$/.test(error.message)
    )
      throw error;
    fail("capture_failed");
  }
}

// Narrow reconstruction: pre-existing provider/builtin roles must match exactly.
// Missing managed roles without superuser/bypass/replication authority and memberships
// are recreated with explicitly reviewed nonsecret attributes, including managed
// CREATEDB/CREATEROLE where reviewed. No passwords, arbitrary SQL or role drops.
function reconstruct(
  commands: CommandExecutor,
  url: string,
  adapter: PostgreSqlGenerationAdapter,
  plan: ReviewedRecoveryPlan,
) {
  const observed = inventory(adapter, url, plan, false);
  const statements: string[] = [];
  for (const r of observed.roles)
    if (!plan.roles.some((p) => equal(p, r)))
      fail("target_role_attributes_mismatch");
  for (const r of plan.roles) {
    if (observed.roles.some((p) => p.name === r.name)) continue;
    if (!/^(reviewrouter(?:_[a-z0-9_]+)?|historical_inherited)$/u.test(r.name))
      fail("unsupported_role_name");
    if (r.superuser || r.bypassRls || r.replication)
      fail("unsupported_role_privileged_attributes");
    if (r.validUntil !== null || r.connectionLimit !== -1)
      fail("unsupported_role_expiry_or_connection_limit");
    statements.push(
      `CREATE ROLE ${identifier(r.name)} ${r.canLogin ? "LOGIN" : "NOLOGIN"} ${r.inherit ? "INHERIT" : "NOINHERIT"} NOSUPERUSER NOBYPASSRLS NOREPLICATION ${r.createDatabase ? "CREATEDB" : "NOCREATEDB"} ${r.createRole ? "CREATEROLE" : "NOCREATEROLE"};`,
    );
  }
  for (const m of observed.memberships)
    if (!plan.memberships.some((p) => equal(p, m)))
      fail("target_membership_mismatch");
  for (const m of plan.memberships) {
    if (observed.memberships.some((p) => equal(p, m))) continue;
    if (
      m.grantor !== "postgres" ||
      !plan.roles.some((r) => r.name === m.member) ||
      !plan.roles.some((r) => r.name === m.role)
    )
      fail("unsupported_membership_reconstruction");
    statements.push(
      `GRANT ${identifier(m.role)} TO ${identifier(m.member)} WITH ADMIN ${m.adminOption ? "TRUE" : "FALSE"}, INHERIT ${m.inheritOption ? "TRUE" : "FALSE"}, SET ${m.setOption ? "TRUE" : "FALSE"} GRANTED BY postgres;`,
    );
  }
  if (statements.length)
    executeSql(commands, url, `BEGIN; ${statements.join("\n")} COMMIT;`);
  rolePlan(inventory(adapter, url, plan, false), plan);
}
function databaseReconstructionSql(
  database: string,
  plan: ReviewedRecoveryPlan,
) {
  const db = identifier(database),
    owner = identifier(plan.databaseOwner);
  const grants: string[] = [];
  for (const g of plan.grants.filter(
    (g) => g.resource === `database:${database}`,
  )) {
    if (
      g.resource !== `database:${database}` ||
      g.grantor !== plan.databaseOwner
    )
      fail("unsupported_database_acl_reconstruction");
    if (g.capability === "owner:database" && g.principal === plan.databaseOwner)
      continue;
    const permission = {
      "database:connect": "CONNECT",
      "database:create": "CREATE",
      "database:temporary": "TEMPORARY",
    }[g.capability as string];
    if (
      !permission ||
      typeof g.grantable !== "boolean" ||
      (g.principal !== "PUBLIC" &&
        !plan.roles.some((r) => r.name === g.principal))
    )
      fail("unsupported_database_acl_reconstruction");
    grants.push(
      `GRANT ${permission} ON DATABASE ${db} TO ${g.principal === "PUBLIC" ? "PUBLIC" : identifier(g.principal)}${g.grantable ? " WITH GRANT OPTION" : ""};`,
    );
  }
  return `BEGIN; ALTER DATABASE ${db} OWNER TO ${owner}; SET LOCAL ROLE ${owner}; REVOKE ALL ON DATABASE ${db} FROM PUBLIC, ${plan.roles.map((r) => identifier(r.name)).join(", ")}; ${grants.join(" ")} COMMIT;`;
}
// Diagnostic comparison only: never used to authorize equivalence. Identity
// values stay private; emitted paths contain only fixed field names and indices.
export function recoveryMetadataDifference(source: string, target: string) {
  const left = JSON.parse(source), right = JSON.parse(target);
  const rows = (value: unknown): Record<string, unknown>[] => {
    if (value === null) return [];
    if (!Array.isArray(value) || value.length > 10000 || value.some(row =>
      !row || typeof row !== "object" || Array.isArray(row)))
      throw new Error("recovery_metadata_diagnostic_shape");
    return value;
  };
  const a = rows(left), b = rows(right);
  const identity = (row: Record<string, unknown>) => canonicalJson(
    [row.kind, row.schema, row.table ?? null, row.name ?? null,
      row.type ?? null, row.kind === "default" ? row.owner : null]);
  const group = (values: Record<string, unknown>[]) => {
    const result = new Map<string, Record<string, unknown>[]>();
    for (const row of values) {
      const key = identity(row);
      result.set(key, [...(result.get(key) ?? []), row]);
    }
    return result;
  };
  const ga = group(a), gb = group(b);
  const paths: string[] = [];
  let differences = 0, missingSource = 0, missingTarget = 0, aclOrderOnly = 0;
  const add = (path: string) => { differences++; if (paths.length < 64) paths.push(path); };
  const fields = ["kind", "schema", "table", "name", "type", "owner", "acl", "definition"];
  let index = 0;
  for (const key of [...new Set([...ga.keys(), ...gb.keys()])].sort()) {
    const x = ga.get(key) ?? [], y = gb.get(key) ?? [];
    if (!x.length) { missingSource += y.length; add(`records[${index}].missingSource`); }
    else if (!y.length) { missingTarget += x.length; add(`records[${index}].missingTarget`); }
    else if (x.length !== 1 || y.length !== 1) add(`records[${index}].duplicateIdentity`);
    else {
      for (const field of fields) {
        if (equal(x[0][field] ?? null, y[0][field] ?? null)) continue;
        add(`records[${index}].${field}`);
        if (field === "acl" && Array.isArray(x[0].acl) && Array.isArray(y[0].acl)
          && equal([...x[0].acl].sort(), [...y[0].acl].sort())) aclOrderOnly++;
      }
      if (!equal(Object.keys(x[0]).sort(), Object.keys(y[0]).sort()) ||
          Object.keys(x[0]).some(field => !fields.includes(field)) ||
          Object.keys(y[0]).some(field => !fields.includes(field)))
        add(`records[${index}].unrecognizedShape`);
    }
    index++;
  }
  return { sourceRecords: a.length, targetRecords: b.length,
    rawEqual: source === target, parsedEqual: equal(left, right),
    missingSource, missingTarget, aclOrderOnly, differences, paths,
    truncated: differences > paths.length };
}
export type RecoveryMetadataDiagnostic = ReturnType<typeof recoveryMetadataDifference> & {
  category: "acl_ownership_defaults" | "constraints_indexes_triggers";
};
// Observe existing verifier inputs without changing SQL, output or equivalence.
// Only fixed category names escape this scope; values, names and digests do not.
function restoreDiagnostics(commands: CommandExecutor, sourceUrl: string, targetUrl: string, report?: (diagnostic: RecoveryMetadataDiagnostic) => void) {
  const metadata = new Map<string, Map<string, string>>();
  const host = (url: string) => new URL(url).hostname;
  const observations = new Map<string, Map<string, string>>();
  const category = (sql: string) => {
    if (sql.startsWith("COPY ")) return "rows";
    if (sql.includes("'kind','object'")) return "acl_ownership_defaults";
    if (sql.includes("'kind','constraint'")) return "constraints_indexes_triggers";
    if (sql.includes("'kind','function'")) return "functions_views_schemas";
    if (sql.includes("'force',c.relforcerowsecurity")) return "policies_rls";
    if (sql.includes("'notNull',a.attnotnull")) return "columns_defaults";
    if (sql.includes('row_to_json(m)')) return "migration_history";
    if (sql.includes("'lastValue'")) return "sequences";
    return "other";
  };
  const record = (args: readonly string[], value: string) => {
    const side = args[args.indexOf("--host") + 1];
    const sql = args.at(-1)!;
    const values = observations.get(sql) ?? new Map<string, string>();
    values.set(side!, hash(value));
    const kind = category(sql);
    if (report && (kind === "acl_ownership_defaults" || kind === "constraints_indexes_triggers")) {
      const pair = metadata.get(kind) ?? new Map<string, string>();
      pair.set(side!, value);
      metadata.set(kind, pair);
    }
    observations.set(sql, values);
  };
  const observed: CommandExecutor = {
    execute(command, args, options) {
      const result = commands.execute(command, args, options);
      record(args, result.stdout);
      return result;
    },
    async hashStdout(command, args, options) {
      const result = await commands.hashStdout(command, args, options);
      record(args, canonicalJson(result));
      return result;
    },
    executeExpectingFailure: (command, args, options) =>
      commands.executeExpectingFailure(command, args, options),
  };
  return {
    commands: observed,
    mismatch() {
      const categories = new Set<string>();
      for (const [category, pair] of metadata) {
        const left = pair.get(host(sourceUrl)), right = pair.get(host(targetUrl));
        if (left !== undefined && right !== undefined) {
          try { report?.({ category: category as RecoveryMetadataDiagnostic["category"],
            ...recoveryMetadataDifference(left, right) }); } catch {
            // Diagnostics cannot replace or suppress the original verifier failure.
          }
        }
      }
      for (const [sql, values] of observations) {
        const left = values.get(host(sourceUrl)), right = values.get(host(targetUrl));
        if (left !== undefined && right !== undefined && left !== right)
          categories.add(category(sql));
      }
      return [...categories].sort().join("_and_") || "unclassified";
    },
  };
}
export async function verifyReviewedRestore(input: {
  artifact: RecoveryArtifact;
  sourceUrl: string;
  targetUrl: string;
  metadataDiagnostic?: (diagnostic: RecoveryMetadataDiagnostic) => void;
  disposableTarget: {
    purpose: "historical89-disposable-restore";
    reviewReference: string;
    expectedIdentity: RecoveryIdentity;
  };
}) {
  let phase = "preflight";
  try {
    const state = custody.get(input.artifact);
    if (!state) fail("unmeasured_artifact_handle");
    const { commands, plan, maxBytes } = state,
      a = input.artifact;
    reference(input.disposableTarget.reviewReference);
    if (input.disposableTarget.purpose !== "historical89-disposable-restore")
      fail("target_not_disposable");
    const source = identity(commands, input.sourceUrl, a.source);
    const target = identity(
      commands,
      input.targetUrl,
      input.disposableTarget.expectedIdentity,
    );
    // Identical logical name on a DIFFERENT physical cluster: no database-name,
    // principal resource, OID or routine-body rewriting to manufacture equality.
    if (
      source.systemIdentifier === target.systemIdentifier ||
      source.database !== target.database ||
      source.serverVersion !== target.serverVersion
    )
      fail("target_not_separate_cluster_same_logical_database");
    if (
      !equal(measuredFile(a.directory, maxBytes), {
        sha256: a.sha256,
        bytes: a.bytes,
      })
    )
      fail("artifact_changed");
    if (query(commands, input.targetUrl, recoveryEmptySql).empty !== true)
      fail("target_not_empty");
    const adapter = new PostgreSqlGenerationAdapter(recoverySemanticCommands(commands));
    const sourceNow = (
      await adapter.verifyEquivalence(
        input.sourceUrl,
        input.sourceUrl,
        ["public"],
        { source: plan.policy, target: plan.policy },
      )
    ).evidence;
    if (
      !equal(sourceNow, state.evidence) ||
      !equal(scope(commands, input.sourceUrl), state.scope) ||
      !equal(
        inventory(adapter, input.sourceUrl, plan, true),
        state.inventory,
      ) ||
      !equal(ledger(commands, input.sourceUrl), a.ledger)
    )
      fail("source_changed_since_capture");
    scope(commands, input.targetUrl);
    // Recheck before first mutation. Independent root must own/exclude target
    // writers too; this is not an admission lock or a general restore runner.
    identity(commands, input.targetUrl, target);
    if (query(commands, input.targetUrl, recoveryEmptySql).empty !== true)
      fail("target_not_empty");
    // Private exclusive copy, hashed before any target mutation. The retained
    // root artifact is never consumed, replaced or cleaned by restore.
    const pinDir = join(a.directory, "restore-input");
    mkdirSync(pinDir, { mode: 0o700 });
    try {
      if (
        !equal(measuredFile(a.directory, maxBytes, pinDir), {
          sha256: a.sha256,
          bytes: a.bytes,
        })
      )
        fail("artifact_changed_before_restore");
      if (
        !equal(measuredFile(pinDir, maxBytes), {
          sha256: a.sha256,
          bytes: a.bytes,
        })
      )
        fail("artifact_changed_before_restore");
      identity(commands, input.targetUrl, target);
      if (query(commands, input.targetUrl, recoveryEmptySql).empty !== true)
        fail("target_not_empty");
      const databaseSql = databaseReconstructionSql(target.database, plan);
      phase = "role_reconstruction";
      reconstruct(commands, input.targetUrl, adapter, plan);
      phase = "database_reconstruction";
      executeSql(commands, input.targetUrl, databaseSql);
      const c = decomposePostgresConnection(input.targetUrl);
      try {
        phase = "pg_restore";
        commands.execute(
          "pg_restore",
          [
            ...c.args,
            "--exit-on-error",
            "--single-transaction",
            join(pinDir, "recovery.dump"),
          ],
          { env: c.env, timeoutMs: 600_000 },
        );
      } finally {
        c.cleanup();
      }
    } finally {
      rmSync(pinDir, { recursive: true, force: true });
    }
    phase = "restored_security";
    const restoredInventory = inventory(adapter, input.targetUrl, plan, false);
    if (!equal(restoredInventory.memberships, state.inventory.memberships))
      fail("restored_memberships_mismatch");
    const owners = (i: EffectivePrincipalInventory) => i.grants.filter(g => g.capability.startsWith("owner:"));
    if (!equal(owners(restoredInventory), owners(state.inventory)))
      fail("restored_owners_mismatch");
    if (!equal(restoredInventory.rowSecurity, state.inventory.rowSecurity))
      fail("restored_rls_mismatch");
    if (!equal(restoredInventory.grants, state.inventory.grants))
      fail("restored_grants_mismatch");
    if (!equal(restoredInventory, state.inventory))
      fail("restored_principals_mismatch");
    phase = "restored_ledger";
    if (!equal(ledger(commands, input.targetUrl), a.ledger))
      fail("restored_ledger_mismatch");
    phase = "restored_scope";
    const restoredScope = scope(commands, input.targetUrl);
    if (!equal(restoredScope.exactSequences, (state.scope as ReturnType<typeof scope>).exactSequences))
      fail("restored_sequences_mismatch");
    for (const key of ["schemas", "settings", "extensions", "database", "types", "unsupportedTypes", "unsupportedCatalog", "relations", "columnProperties", "triggerModes", "visible"] as const) {
      if (!equal(restoredScope[key], (state.scope as ReturnType<typeof scope>)[key]))
        fail(`restored_scope_${key.replace(/[A-Z]/g, c => "_" + c.toLowerCase())}_mismatch`);
    }
    if (!equal(restoredScope, state.scope)) fail("restored_scope_mismatch");
    phase = "restored_equivalence";
    // Observe canonical verifier inputs, including normalized CHECK definitions.
    const diagnostics = restoreDiagnostics(recoverySemanticCommands(commands), input.sourceUrl, input.targetUrl, input.metadataDiagnostic);
    let result;
    try {
      result = await new PostgreSqlGenerationAdapter(diagnostics.commands).verifyEquivalence(
        input.sourceUrl, input.targetUrl, ["public"],
        { source: plan.policy, target: plan.policy },
      );
    } catch {
      fail(`restored_equivalence_${diagnostics.mismatch()}`);
    }
    if (
      !equal(result.evidence, state.evidence) ||
      !equal(scope(commands, input.targetUrl), state.scope) ||
      !equal(scope(commands, input.sourceUrl), state.scope) ||
      !equal(
        inventory(adapter, input.targetUrl, plan, true),
        state.inventory,
      ) ||
      !equal(ledger(commands, input.targetUrl), a.ledger) ||
      !equal(measuredFile(a.directory, maxBytes), {
        sha256: a.sha256,
        bytes: a.bytes,
      })
    )
      fail("restored_equivalence_mismatch");
    identity(commands, input.sourceUrl, source);
    identity(commands, input.targetUrl, target);
    return frozen({
      artifactSha256: a.sha256,
      artifactBytes: a.bytes,
      exactSequencesSha256: a.sourceObservation.exactSequencesSha256,
      source,
      target,
      verifiedAt: new Date().toISOString(),
      reviewReference: plan.reviewReference,
      reviewedPlanSha256: hash(canonicalJson(plan)),
      disposableReviewReference: input.disposableTarget.reviewReference,
      ledger: a.ledger,
      evidence: result.evidence,
      logicalSecuritySha256: hash(canonicalJson(state.inventory)),
      supplementalCatalogSha256: hash(canonicalJson(state.scope)),
      limitations,
    });
  } catch (error) {
    if (
      error instanceof Error &&
      /^historical89_recovery_[a-z0-9_]+$/.test(error.message)
    )
      throw error;
    fail(`restore_${phase}_failed`);
  }
}
