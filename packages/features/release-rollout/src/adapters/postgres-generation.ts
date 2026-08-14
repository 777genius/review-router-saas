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
  sha256Canonical,
  type DatabaseGenerationIdentity,
  type StepObservation,
} from "../domain/release-rollout";
import type {
  BackupIdentity,
  EquivalenceEvidence,
  LegacyAmbiguityEvidence,
  QuiescenceEvidence,
  SourceDatabaseFenceEvidence,
} from "../domain/trusted-rollout-evidence";
import type { CommandExecutor } from "./process-command";
import type { DatabaseAclWitness } from "../application/ports";
import {
  assertEffectivePrincipalInventory,
  canonicalEffectivePrincipalPolicy,
  type EffectivePrincipalGrant,
  type EffectivePrincipalInventory,
  type EffectivePrincipalPolicy,
} from "../domain/effective-principal-inventory";

const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/**
 * PostgreSQL catalog projection for the provider-neutral effective-principal
 * contract. Policy deliberately does not live in this adapter.
 */
import { effectivePrincipalInventorySql } from "./effective-principal-postgres.mjs";
export { effectivePrincipalInventorySql } from "./effective-principal-postgres.mjs";
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
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("postgres_generation_connection_invalid");
  }
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
const sqlLiteral = (value: string): string =>
  `'${value.replaceAll("'", "''")}'`;
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
  constructor(
    private readonly commands: CommandExecutor,
    private readonly now: () => Date = () => new Date(),
  ) {}

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

  inventoryEffectivePrincipals(url: string): EffectivePrincipalInventory {
    const value = JSON.parse(
      this.psql(url, effectivePrincipalInventorySql),
    ) as EffectivePrincipalInventory;
    if (
      value.version !== 1 ||
      typeof value.database !== "string" ||
      typeof value.sessionPrincipal !== "string" ||
      !Array.isArray(value.roles) ||
      !Array.isArray(value.memberships) ||
      !Array.isArray(value.grants)
    )
      throw new Error("postgres_effective_principal_inventory_invalid");
    return Object.freeze({
      ...value,
      roles: Object.freeze(value.roles),
      memberships: Object.freeze(value.memberships),
      grants: Object.freeze(value.grants as readonly EffectivePrincipalGrant[]),
    });
  }

  establishSourceFence(input: {
    adminUrl: string;
    source: DatabaseGenerationIdentity;
    rolloutId: string;
    fenceId: string;
    beforePolicy: EffectivePrincipalPolicy;
    fencedPolicy: EffectivePrincipalPolicy;
  }): SourceDatabaseFenceEvidence {
    this.observeIdentity(input.adminUrl, input.source);
    this.psql(
      input.adminUrl,
      `BEGIN;
CREATE SCHEMA IF NOT EXISTS release_authority;
CREATE TABLE IF NOT EXISTS release_authority.source_database_fence (
  fence_id text PRIMARY KEY, rollout_id text NOT NULL UNIQUE,
  source_system_identifier text NOT NULL, authority_principal text NOT NULL,
  before_inventory_sha256 text NOT NULL, before_policy_sha256 text NOT NULL,
  fenced_inventory_sha256 text, fenced_policy_sha256 text NOT NULL, prior_connect_acl jsonb NOT NULL,
  lifecycle text NOT NULL CHECK (lifecycle IN ('active','released','forward_only')),
  established_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  released_at timestamptz
);
COMMIT;`,
    );
    const fencedPolicySha256 = `sha256:${sha256Canonical(canonicalEffectivePrincipalPolicy(input.fencedPolicy))}`;
    if (
      this.psql(
        input.adminUrl,
        "SELECT to_regclass('release_authority.source_database_fence') IS NOT NULL",
      ) === "t"
    ) {
      const replay = this.psql(
        input.adminUrl,
        `SELECT json_build_object('version',1,'fenceId',fence_id,'rolloutId',rollout_id,
          'sourceSystemIdentifier',source_system_identifier,'authorityPrincipal',authority_principal,
          'beforeInventorySha256',before_inventory_sha256,'fencedInventorySha256',fenced_inventory_sha256,
          'beforePolicySha256',before_policy_sha256,'fencedPolicySha256',fenced_policy_sha256,
          'priorConnectAclSha256','sha256:'||encode(digest(convert_to(prior_connect_acl::text,'UTF8'),'sha256'),'hex'),
          'lifecycle',lifecycle,'observedAt',established_at)
         FROM release_authority.source_database_fence WHERE rollout_id=${sqlLiteral(input.rolloutId)}`,
      );
      if (replay) {
        const persisted = JSON.parse(replay) as SourceDatabaseFenceEvidence;
        if (
          persisted.fenceId !== input.fenceId ||
          persisted.sourceSystemIdentifier !== input.source.systemIdentifier ||
          persisted.lifecycle !== "active" ||
          persisted.beforePolicySha256 !==
            `sha256:${sha256Canonical(canonicalEffectivePrincipalPolicy(input.beforePolicy))}` ||
          persisted.fencedPolicySha256 !== fencedPolicySha256
        )
          throw new Error("postgres_source_fence_replay_mismatch");
        const fenced = assertEffectivePrincipalInventory(
          this.inventoryEffectivePrincipals(input.adminUrl),
          input.fencedPolicy,
        );
        if (
          persisted.fencedInventorySha256 &&
          persisted.fencedInventorySha256 !== fenced.inventorySha256
        )
          throw new Error("postgres_source_fence_replay_mismatch");
        const attested = this.psql(
          input.adminUrl,
          `UPDATE release_authority.source_database_fence
             SET fenced_inventory_sha256=${sqlLiteral(fenced.inventorySha256)}
           WHERE fence_id=${sqlLiteral(input.fenceId)} AND lifecycle='active'
             AND (fenced_inventory_sha256 IS NULL OR fenced_inventory_sha256=${sqlLiteral(fenced.inventorySha256)})
           RETURNING true`,
        );
        if (attested !== "t")
          throw new Error(
            "postgres_source_fence_inventory_attestation_cas_failed",
          );
        return Object.freeze({
          ...persisted,
          fencedInventorySha256: fenced.inventorySha256,
          lifecycle: "active" as const,
        });
      }
    }
    const beforeInventory = this.inventoryEffectivePrincipals(input.adminUrl);
    const before = assertEffectivePrincipalInventory(
      beforeInventory,
      input.beforePolicy,
    );
    if (
      before.effectivePermissions[beforeInventory.sessionPrincipal] ===
      undefined
    ) {
      // The adapter authority must itself be represented by the attested inventory.
      throw new Error("postgres_source_fence_authority_not_in_inventory");
    }
    const persisted = JSON.parse(
      this.psql(
        input.adminUrl,
        `BEGIN;
SELECT pg_advisory_xact_lock(hashtext('reviewrouter_source_database_fence'));
CREATE SCHEMA IF NOT EXISTS release_authority;
CREATE TABLE IF NOT EXISTS release_authority.source_database_fence (
  fence_id text PRIMARY KEY, rollout_id text NOT NULL UNIQUE,
  source_system_identifier text NOT NULL, authority_principal text NOT NULL,
  before_inventory_sha256 text NOT NULL, before_policy_sha256 text NOT NULL,
  fenced_inventory_sha256 text, fenced_policy_sha256 text NOT NULL, prior_connect_acl jsonb NOT NULL,
  lifecycle text NOT NULL CHECK (lifecycle IN ('active','released','forward_only')),
  established_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  released_at timestamptz
);
DO $fence$
DECLARE existing release_authority.source_database_fence%ROWTYPE;
DECLARE principal record;
DECLARE prior_acl jsonb;
BEGIN
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'principal',coalesce(grantee.rolname,'PUBLIC'),'grantable',acl.is_grantable
  ) ORDER BY coalesce(grantee.rolname,'PUBLIC'),acl.is_grantable),'[]'::jsonb)
  INTO prior_acl
  FROM pg_database database
  CROSS JOIN LATERAL aclexplode(coalesce(database.datacl,acldefault('d',database.datdba))) acl
  LEFT JOIN pg_roles grantee ON grantee.oid=acl.grantee
  WHERE database.datname=current_database() AND acl.privilege_type='CONNECT';
  SELECT * INTO existing FROM release_authority.source_database_fence
    WHERE rollout_id=${sqlLiteral(input.rolloutId)} FOR UPDATE;
  IF existing.fence_id IS NOT NULL THEN
    IF existing.fence_id<>${sqlLiteral(input.fenceId)}
       OR existing.source_system_identifier<>${sqlLiteral(input.source.systemIdentifier)}
       OR existing.before_inventory_sha256<>${sqlLiteral(before.inventorySha256)}
       OR existing.before_policy_sha256<>${sqlLiteral(before.policySha256)}
       OR existing.fenced_policy_sha256<>${sqlLiteral(fencedPolicySha256)}
       OR existing.lifecycle<>'active' THEN
      RAISE EXCEPTION 'source database fence replay mismatch';
    END IF;
  ELSE
    INSERT INTO release_authority.source_database_fence(
      fence_id,rollout_id,source_system_identifier,authority_principal,
      before_inventory_sha256,before_policy_sha256,fenced_policy_sha256,
      prior_connect_acl,lifecycle
    ) VALUES (${sqlLiteral(input.fenceId)},${sqlLiteral(input.rolloutId)},
      ${sqlLiteral(input.source.systemIdentifier)},session_user,
      ${sqlLiteral(before.inventorySha256)},${sqlLiteral(before.policySha256)},
      ${sqlLiteral(fencedPolicySha256)},prior_acl,'active');
  END IF;
  EXECUTE format('REVOKE CONNECT ON DATABASE %I FROM PUBLIC',current_database());
  FOR principal IN SELECT rolname FROM pg_roles WHERE rolname<>session_user LOOP
    EXECUTE format('REVOKE CONNECT ON DATABASE %I FROM %I',current_database(),principal.rolname);
  END LOOP;
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I',current_database(),session_user);
END $fence$;
COMMIT;
DO $terminate$ DECLARE connection record; BEGIN
  FOR connection IN SELECT pid FROM pg_stat_activity
    WHERE datname=current_database() AND pid<>pg_backend_pid() LOOP
    PERFORM pg_terminate_backend(connection.pid);
  END LOOP;
END $terminate$;
SELECT json_build_object('fenceId',fence_id,'rolloutId',rollout_id,
  'sourceSystemIdentifier',source_system_identifier,'authorityPrincipal',authority_principal,
  'priorConnectAclSha256','sha256:'||encode(digest(convert_to(prior_connect_acl::text,'UTF8'),'sha256'),'hex'),
  'lifecycle',lifecycle,'observedAt',established_at)
FROM release_authority.source_database_fence WHERE rollout_id=${sqlLiteral(input.rolloutId)}`,
      ),
    ) as Omit<
      SourceDatabaseFenceEvidence,
      | "version"
      | "beforeInventorySha256"
      | "fencedInventorySha256"
      | "beforePolicySha256"
      | "fencedPolicySha256"
    >;
    const fenced = assertEffectivePrincipalInventory(
      this.inventoryEffectivePrincipals(input.adminUrl),
      input.fencedPolicy,
    );
    const attested = this.psql(
      input.adminUrl,
      `UPDATE release_authority.source_database_fence
       SET fenced_inventory_sha256=${sqlLiteral(fenced.inventorySha256)}
       WHERE fence_id=${sqlLiteral(input.fenceId)} AND rollout_id=${sqlLiteral(input.rolloutId)}
         AND lifecycle='active'
         AND (fenced_inventory_sha256 IS NULL OR fenced_inventory_sha256=${sqlLiteral(fenced.inventorySha256)})
       RETURNING true`,
    );
    if (attested !== "t")
      throw new Error("postgres_source_fence_inventory_attestation_cas_failed");
    if (persisted.lifecycle !== "active")
      throw new Error("postgres_source_fence_not_active");
    return Object.freeze({
      version: 1,
      ...persisted,
      beforeInventorySha256: before.inventorySha256,
      fencedInventorySha256: fenced.inventorySha256,
      beforePolicySha256: before.policySha256,
      fencedPolicySha256: fenced.policySha256,
      lifecycle: "active" as const,
    });
  }

  observeSourceFence(input: {
    adminUrl: string;
    source: DatabaseGenerationIdentity;
    rolloutId: string;
  }): SourceDatabaseFenceEvidence {
    this.observeIdentity(input.adminUrl, input.source);
    const raw = this.psql(
      input.adminUrl,
      `SELECT json_build_object('version',1,'fenceId',fence_id,'rolloutId',rollout_id,
          'sourceSystemIdentifier',source_system_identifier,'authorityPrincipal',authority_principal,
          'beforeInventorySha256',before_inventory_sha256,'fencedInventorySha256',fenced_inventory_sha256,
          'beforePolicySha256',before_policy_sha256,'fencedPolicySha256',fenced_policy_sha256,
          'priorConnectAclSha256','sha256:'||encode(digest(convert_to(prior_connect_acl::text,'UTF8'),'sha256'),'hex'),
          'lifecycle',lifecycle,'observedAt',established_at)
         FROM release_authority.source_database_fence WHERE rollout_id=${sqlLiteral(input.rolloutId)}`,
    );
    if (!raw) throw new Error("postgres_source_fence_observation_invalid");
    const value = JSON.parse(raw) as SourceDatabaseFenceEvidence;
    if (
      value.version !== 1 ||
      value.rolloutId !== input.rolloutId ||
      value.sourceSystemIdentifier !== input.source.systemIdentifier ||
      value.lifecycle !== "active" ||
      !/^sha256:[a-f0-9]{64}$/u.test(value.fencedInventorySha256)
    )
      throw new Error("postgres_source_fence_observation_invalid");
    return Object.freeze(value);
  }

  findActiveSourceFence(input: {
    adminUrl: string;
    source: DatabaseGenerationIdentity;
    rolloutId: string;
  }): SourceDatabaseFenceEvidence | null {
    this.observeIdentity(input.adminUrl, input.source);
    if (
      this.psql(
        input.adminUrl,
        "SELECT to_regclass('release_authority.source_database_fence') IS NOT NULL",
      ) !== "t"
    )
      return null;
    try {
      return this.observeSourceFence(input);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "postgres_source_fence_observation_invalid"
      )
        return null;
      throw error;
    }
  }

  verifySourceFence(input: {
    adminUrl: string;
    source: DatabaseGenerationIdentity;
    rolloutId: string;
    fencedPolicy: EffectivePrincipalPolicy;
  }): SourceDatabaseFenceEvidence {
    const fence = this.observeSourceFence(input);
    const decision = assertEffectivePrincipalInventory(
      this.inventoryEffectivePrincipals(input.adminUrl),
      input.fencedPolicy,
    );
    if (
      decision.inventorySha256 !== fence.fencedInventorySha256 ||
      decision.policySha256 !== fence.fencedPolicySha256
    )
      throw new Error("postgres_source_fence_drifted");
    return fence;
  }

  observeSourcePolicy(input: {
    adminUrl: string;
    source: DatabaseGenerationIdentity;
    policy: EffectivePrincipalPolicy;
  }): DatabaseAclWitness {
    this.observeIdentity(input.adminUrl, input.source);
    const decision = assertEffectivePrincipalInventory(
      this.inventoryEffectivePrincipals(input.adminUrl),
      input.policy,
    );
    return Object.freeze({
      systemIdentifier: input.source.systemIdentifier,
      aclSha256: decision.inventorySha256,
      observedAt: new Date().toISOString(),
      sourceWritesRestored: true as const,
    });
  }

  restoreSourceFence(input: {
    adminUrl: string;
    source: DatabaseGenerationIdentity;
    fence: SourceDatabaseFenceEvidence;
    beforePolicy: EffectivePrincipalPolicy;
  }): DatabaseAclWitness {
    this.observeIdentity(input.adminUrl, input.source);
    if (
      input.fence.lifecycle !== "active" ||
      input.fence.sourceSystemIdentifier !== input.source.systemIdentifier
    )
      throw new Error("postgres_source_fence_restore_identity_invalid");
    const activeInventorySha256 = `sha256:${sha256Canonical(
      this.inventoryEffectivePrincipals(input.adminUrl),
    )}`;
    if (activeInventorySha256 !== input.fence.fencedInventorySha256)
      throw new Error("postgres_source_fence_restore_inventory_drifted");
    const restored = JSON.parse(
      this.psql(
        input.adminUrl,
        `BEGIN;
SELECT pg_advisory_xact_lock(hashtext('reviewrouter_source_database_fence'));
DO $restore$
DECLARE fence release_authority.source_database_fence%ROWTYPE;
DECLARE principal record;
DECLARE saved record;
BEGIN
  SELECT * INTO fence FROM release_authority.source_database_fence
    WHERE fence_id=${sqlLiteral(input.fence.fenceId)} AND rollout_id=${sqlLiteral(input.fence.rolloutId)} FOR UPDATE;
  IF fence.fence_id IS NULL OR fence.lifecycle<>'active'
     OR fence.source_system_identifier<>${sqlLiteral(input.source.systemIdentifier)}
     OR fence.before_inventory_sha256<>${sqlLiteral(input.fence.beforeInventorySha256)}
     OR fence.before_policy_sha256<>${sqlLiteral(input.fence.beforePolicySha256)}
     OR ('sha256:'||encode(digest(convert_to(fence.prior_connect_acl::text,'UTF8'),'sha256'),'hex'))<>${sqlLiteral(input.fence.priorConnectAclSha256)} THEN
    RAISE EXCEPTION 'source database fence restore attestation mismatch';
  END IF;
  EXECUTE format('REVOKE CONNECT ON DATABASE %I FROM PUBLIC',current_database());
  FOR principal IN SELECT rolname FROM pg_roles LOOP
    EXECUTE format('REVOKE CONNECT ON DATABASE %I FROM %I',current_database(),principal.rolname);
  END LOOP;
  FOR saved IN SELECT value->>'principal' AS principal,
      (value->>'grantable')::boolean AS grantable
    FROM jsonb_array_elements(fence.prior_connect_acl) LOOP
    IF saved.principal='PUBLIC' THEN
      EXECUTE format('GRANT CONNECT ON DATABASE %I TO PUBLIC%s',current_database(),
        CASE WHEN saved.grantable THEN ' WITH GRANT OPTION' ELSE '' END);
    ELSE
      EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I%s',current_database(),saved.principal,
        CASE WHEN saved.grantable THEN ' WITH GRANT OPTION' ELSE '' END);
    END IF;
  END LOOP;
  UPDATE release_authority.source_database_fence AS stored
    SET lifecycle='released',released_at=transaction_timestamp()
    WHERE stored.fence_id=fence.fence_id;
END $restore$;
COMMIT;
SELECT json_build_object('lifecycle',lifecycle,'sourceSystemIdentifier',source_system_identifier)
FROM release_authority.source_database_fence WHERE fence_id=${sqlLiteral(input.fence.fenceId)}`,
      ),
    ) as { lifecycle: string; sourceSystemIdentifier: string };
    if (
      restored.lifecycle !== "released" ||
      restored.sourceSystemIdentifier !== input.source.systemIdentifier
    )
      throw new Error("postgres_source_fence_restore_not_persisted");
    const decision = assertEffectivePrincipalInventory(
      this.inventoryEffectivePrincipals(input.adminUrl),
      input.beforePolicy,
    );
    if (decision.inventorySha256 !== input.fence.beforeInventorySha256)
      throw new Error("postgres_source_fence_restore_inventory_mismatch");
    return Object.freeze({
      systemIdentifier: input.source.systemIdentifier,
      aclSha256: input.fence.priorConnectAclSha256,
      observedAt: new Date().toISOString(),
      sourceWritesRestored: true as const,
    });
  }

  observeRestoredSourceFence(input: {
    adminUrl: string;
    source: DatabaseGenerationIdentity;
    rolloutId: string;
    beforePolicy: EffectivePrincipalPolicy;
  }): DatabaseAclWitness | null {
    this.observeIdentity(input.adminUrl, input.source);
    const raw = this.psql(
      input.adminUrl,
      `SELECT json_build_object('lifecycle',lifecycle,
        'beforeInventorySha256',before_inventory_sha256,
        'priorConnectAclSha256','sha256:'||encode(digest(convert_to(prior_connect_acl::text,'UTF8'),'sha256'),'hex'))
       FROM release_authority.source_database_fence
       WHERE rollout_id=${sqlLiteral(input.rolloutId)} AND source_system_identifier=${sqlLiteral(input.source.systemIdentifier)}`,
    );
    if (!raw) return null;
    const fence = JSON.parse(raw) as {
      lifecycle: string;
      beforeInventorySha256: string;
      priorConnectAclSha256: string;
    };
    if (fence.lifecycle !== "released") return null;
    const decision = assertEffectivePrincipalInventory(
      this.inventoryEffectivePrincipals(input.adminUrl),
      input.beforePolicy,
    );
    if (decision.inventorySha256 !== fence.beforeInventorySha256) return null;
    return Object.freeze({
      systemIdentifier: input.source.systemIdentifier,
      aclSha256: fence.priorConnectAclSha256,
      observedAt: new Date().toISOString(),
      sourceWritesRestored: true as const,
    });
  }

  markSourceFenceForwardOnly(input: {
    adminUrl: string;
    source: DatabaseGenerationIdentity;
    fence: SourceDatabaseFenceEvidence;
  }): void {
    this.observeIdentity(input.adminUrl, input.source);
    const state = this.psql(
      input.adminUrl,
      `WITH changed AS (UPDATE release_authority.source_database_fence SET lifecycle='forward_only'
         WHERE fence_id=${sqlLiteral(input.fence.fenceId)} AND rollout_id=${sqlLiteral(input.fence.rolloutId)}
           AND source_system_identifier=${sqlLiteral(input.source.systemIdentifier)} AND lifecycle='active'
         RETURNING lifecycle)
       SELECT lifecycle FROM changed UNION ALL
       SELECT lifecycle FROM release_authority.source_database_fence
        WHERE fence_id=${sqlLiteral(input.fence.fenceId)} AND rollout_id=${sqlLiteral(input.fence.rolloutId)}
          AND source_system_identifier=${sqlLiteral(input.source.systemIdentifier)} AND lifecycle='forward_only'
       LIMIT 1`,
    );
    if (state !== "forward_only")
      throw new Error("postgres_source_fence_forward_only_cas_failed");
  }

  private legacyAmbiguityInventory(url: string): {
    activeLeaseIds: string[];
    fetchedSetupIds: string[];
    pendingIntentIds: string[];
    intentStatuses: string[];
  } {
    return JSON.parse(
      this.psql(
        url,
        `SELECT json_build_object(
          'activeLeaseIds', coalesce((SELECT json_agg("id" ORDER BY "id") FROM "CodexOAuthLease" WHERE "status" IN ('preleased','finalized')), '[]'::json),
          'fetchedSetupIds', coalesce((SELECT json_agg("id" ORDER BY "id") FROM "CodexOAuthSetupManifest" WHERE "status" = 'fetched'), '[]'::json),
          'pendingIntentIds', coalesce((SELECT json_agg("id" ORDER BY "id") FROM "CodexOAuthWritebackIntent" WHERE "status" = 'pending'), '[]'::json)
          ,'intentStatuses', coalesce((SELECT json_agg(DISTINCT "status" ORDER BY "status") FROM "CodexOAuthWritebackIntent"), '[]'::json)
        )`,
      ),
    );
  }

  private observeStableLegacyAmbiguity(url: string): LegacyAmbiguityEvidence {
    const firstObservedAt = this.now().toISOString();
    const first = this.legacyAmbiguityInventory(url);
    this.psql(url, "SELECT pg_sleep(0.2)");
    const secondObservedAt = this.now().toISOString();
    const second = this.legacyAmbiguityInventory(url);
    const firstDigest = digest(JSON.stringify(first));
    const secondDigest = digest(JSON.stringify(second));
    if (firstDigest !== secondDigest)
      throw new Error("postgres_generation_legacy_ambiguity_not_stable");
    if (Date.parse(secondObservedAt) <= Date.parse(firstObservedAt))
      throw new Error("postgres_generation_legacy_ambiguity_clock_invalid");
    return Object.freeze({
      ...second,
      inventorySha256: secondDigest,
      observations: Object.freeze([
        Object.freeze({
          observedAt: firstObservedAt,
          inventorySha256: firstDigest,
        }),
        Object.freeze({
          observedAt: secondObservedAt,
          inventorySha256: secondDigest,
        }),
      ] as const),
      stable: true as const,
    });
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

  observeTargetBeforeBinding(
    url: string,
    expected: DatabaseGenerationIdentity,
  ): DatabaseGenerationIdentity {
    const observed = JSON.parse(
      this.psql(
        url,
        `SELECT json_build_object('systemIdentifier', system_identifier::text, 'majorVersion', current_setting('server_version_num')::integer / 10000, 'databaseName', current_database(), 'binding', shobj_description(database.oid, 'pg_database')) FROM pg_control_system(), pg_database database WHERE database.datname = current_database()`,
      ),
    );
    const targetBinding = {
      version: 1,
      systemIdentifier: expected.systemIdentifier,
      recoveryWitnessSha256: expected.recoveryWitnessSha256,
    };
    let observedBinding: unknown;
    try {
      observedBinding =
        observed.binding === null ? null : JSON.parse(observed.binding);
    } catch {
      throw new Error("postgres_generation_unbound_target_identity_mismatch");
    }
    if (
      observed.systemIdentifier !== expected.systemIdentifier ||
      observed.majorVersion !== expected.majorVersion ||
      observed.databaseName !== expected.databaseName ||
      (observedBinding !== null &&
        JSON.stringify(observedBinding) !== JSON.stringify(targetBinding))
    )
      throw new Error("postgres_generation_unbound_target_identity_mismatch");
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
    source: DatabaseGenerationIdentity;
    rolloutId: string;
    fenceId: string;
    beforePolicy: EffectivePrincipalPolicy;
    fencedPolicy: EffectivePrincipalPolicy;
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
    const probeRoles = input.beforePolicy.principals
      .filter((role) => role.mayLogin)
      .map((role) => role.principal)
      .filter(
        (role) => role !== decodeURIComponent(new URL(input.adminUrl).username),
      )
      .sort();
    if (
      Object.keys(input.reconnectUrls).sort().join(",") !== probeRoles.join(",")
    )
      throw new Error("postgres_generation_reconnect_probe_set_incomplete");
    const sourceSystemIdentifier = this.psql(
      input.adminUrl,
      "SELECT system_identifier::text FROM pg_control_system()",
    );
    for (const role of probeRoles) {
      const preRevocation = JSON.parse(
        this.psql(
          input.reconnectUrls[role]!,
          "SELECT json_build_object('role',current_user,'systemIdentifier',system_identifier::text) FROM pg_control_system()",
        ),
      );
      if (
        preRevocation.role !== role ||
        preRevocation.systemIdentifier !== sourceSystemIdentifier
      )
        throw new Error("postgres_generation_pre_revocation_probe_mismatch");
    }
    const fence = this.establishSourceFence({
      adminUrl: input.adminUrl,
      source: input.source,
      rolloutId: input.rolloutId,
      fenceId: input.fenceId,
      beforePolicy: input.beforePolicy,
      fencedPolicy: input.fencedPolicy,
    });
    const acl = JSON.parse(
      this.psql(
        input.adminUrl,
        `SELECT json_build_object('effectiveConnectDenied', NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolcanlogin AND rolname<>session_user AND has_database_privilege(rolname,current_database(),'CONNECT')), 'publicConnectDenied', NOT has_database_privilege('public',current_database(),'CONNECT'), 'membershipSha256', encode(digest(coalesce((SELECT string_agg(member.rolname||'>'||parent.rolname,',' ORDER BY member.rolname,parent.rolname) FROM pg_auth_members m JOIN pg_roles member ON member.oid=m.member JOIN pg_roles parent ON parent.oid=m.roleid),''),'sha256'),'hex'))`,
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
    for (const role of probeRoles) {
      const connection = decomposePostgresConnection(
        input.reconnectUrls[role]!,
      );
      try {
        const denial = this.commands.executeExpectingFailure(
          "psql",
          [
            ...connection.args,
            "--no-psqlrc",
            "--set",
            "ON_ERROR_STOP=1",
            "--command",
            "SELECT 1",
          ],
          { env: connection.env },
        );
        if (denial.reason !== "database_connect_permission_denied")
          throw new Error("postgres_generation_reconnect_denial_wrong_reason");
        reconnectDenied.push(role);
      } finally {
        connection.cleanup();
      }
    }
    if (reconnectDenied.length !== probeRoles.length)
      throw new Error("postgres_generation_reconnect_probe_succeeded");
    const evidence: QuiescenceEvidence = Object.freeze({
      writerServices: input.writerSuspension.services,
      aclSha256: digest(JSON.stringify(acl)),
      stabilizationSeries: Object.freeze(stabilizationSeries),
      reconnectDeniedRoles: Object.freeze(reconnectDenied),
      legacyAmbiguity: this.observeStableLegacyAmbiguity(input.adminUrl),
      fence,
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

  private async snapshot(
    url: string,
    applicationSchemas: readonly string[],
  ): Promise<{
    tables: Map<string, { rows: number; sha256: string }>;
    metadata: Record<string, string>;
  }> {
    if (
      !applicationSchemas.length ||
      new Set(applicationSchemas).size !== applicationSchemas.length ||
      applicationSchemas.some((schema) => !identifier.test(schema))
    )
      throw new Error("postgres_generation_application_schemas_invalid");
    const schemaList = applicationSchemas
      .map((schema) => `'${schema}'`)
      .join(",");
    const tableNames = JSON.parse(
      this.psql(
        url,
        `SELECT coalesce(json_agg(n.nspname||'.'||c.relname ORDER BY n.nspname,c.relname),'[]'::json) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p','m') AND n.nspname IN (${schemaList})`,
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
        `SELECT coalesce(json_agg(schemaname||'.'||sequencename ORDER BY schemaname,sequencename),'[]'::json) FROM pg_sequences WHERE schemaname IN (${schemaList})`,
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
          `SELECT json_build_object('schema','${schema}','name','${name}','lastValue',value.last_value,'isCalled',value.is_called,'dataType',definition.data_type,'startValue',definition.start_value,'minValue',definition.min_value,'maxValue',definition.max_value,'incrementBy',definition.increment_by,'cycle',definition.cycle,'cacheSize',definition.cache_size,'owner',pg_get_userbyid(sequence.relowner),'ownedBy',(SELECT owned_namespace.nspname||'.'||owned_table.relname||'.'||attribute.attname FROM pg_depend dependent JOIN pg_class owned_table ON owned_table.oid=dependent.refobjid JOIN pg_namespace owned_namespace ON owned_namespace.oid=owned_table.relnamespace JOIN pg_attribute attribute ON attribute.attrelid=dependent.refobjid AND attribute.attnum=dependent.refobjsubid WHERE dependent.objid=sequence.oid AND dependent.deptype IN ('a','i') LIMIT 1)) FROM "${schema}"."${name}" value, pg_class sequence JOIN pg_namespace namespace ON namespace.oid=sequence.relnamespace JOIN pg_sequences definition ON definition.schemaname=namespace.nspname AND definition.sequencename=sequence.relname WHERE namespace.nspname='${schema}' AND sequence.relname='${name}'`,
        ),
      );
    });
    const metadata = {
      sequences: digest(JSON.stringify(sequenceFacts)),
      columnsDefaults: catalog(
        `SELECT json_agg(x ORDER BY x->>'schema',x->>'table',x->>'column') FROM (SELECT json_build_object('schema',n.nspname,'table',c.relname,'column',a.attname,'type',format_type(a.atttypid,a.atttypmod),'notNull',a.attnotnull,'identity',a.attidentity,'generated',a.attgenerated,'default',pg_get_expr(d.adbin,d.adrelid)) x FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attnum>0 AND NOT a.attisdropped AND n.nspname IN (${schemaList})) q`,
      ),
      constraintsIndexesTriggers: catalog(
        `SELECT json_agg(x ORDER BY x::text) FROM (SELECT json_build_object('kind','constraint','schema',n.nspname,'table',relation.relname,'name',c.conname,'definition',pg_get_constraintdef(c.oid)) x FROM pg_constraint c JOIN pg_class relation ON relation.oid=c.conrelid JOIN pg_namespace n ON n.oid=relation.relnamespace WHERE n.nspname IN (${schemaList}) UNION ALL SELECT json_build_object('kind','index','schema',schemaname,'table',tablename,'name',indexname,'definition',indexdef) FROM pg_indexes WHERE schemaname IN (${schemaList}) UNION ALL SELECT json_build_object('kind','trigger','schema',n.nspname,'table',c.relname,'name',tgname,'definition',pg_get_triggerdef(t.oid)) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE NOT t.tgisinternal AND n.nspname IN (${schemaList})) q`,
      ),
      policiesRls: catalog(
        `SELECT json_agg(x ORDER BY x::text) FROM (SELECT json_build_object('schema',n.nspname,'table',c.relname,'rls',c.relrowsecurity,'force',c.relforcerowsecurity,'policy',p.polname,'command',p.polcmd,'roles',(SELECT json_agg(coalesce(role.rolname,'PUBLIC') ORDER BY coalesce(role.rolname,'PUBLIC')) FROM unnest(p.polroles) role_id LEFT JOIN pg_roles role ON role.oid=role_id),'qual',pg_get_expr(p.polqual,p.polrelid),'check',pg_get_expr(p.polwithcheck,p.polrelid)) x FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_policy p ON p.polrelid=c.oid WHERE c.relkind IN ('r','p') AND n.nspname IN (${schemaList})) q`,
      ),
      functionsViewsSchemas: catalog(
        `SELECT json_agg(x ORDER BY x::text) FROM (SELECT json_build_object('kind','function','schema',n.nspname,'name',p.proname,'arguments',pg_get_function_identity_arguments(p.oid),'definition',pg_get_functiondef(p.oid)) x FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN (${schemaList}) AND p.prokind IN ('f','p','w') UNION ALL SELECT json_build_object('kind','view','schema',schemaname,'name',viewname,'definition',definition) FROM pg_views WHERE schemaname IN (${schemaList}) UNION ALL SELECT json_build_object('kind','schema','name',nspname,'definition','') FROM pg_namespace WHERE nspname IN (${schemaList})) q`,
      ),
      aclOwnershipDefaults: catalog(
        `SELECT json_agg(x ORDER BY x::text) FROM (SELECT json_build_object('kind','object','schema',n.nspname,'name',c.relname,'type',c.relkind,'owner',pg_get_userbyid(c.relowner),'acl',c.relacl) x FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN (${schemaList}) UNION ALL SELECT json_build_object('kind','default','schema',coalesce(n.nspname,'*'),'type',d.defaclobjtype,'owner',pg_get_userbyid(d.defaclrole),'acl',d.defaclacl) FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid=d.defaclnamespace WHERE d.defaclnamespace=0 OR n.nspname IN (${schemaList})) q`,
      ),
      migrationHistory: catalog(
        applicationSchemas.includes("public")
          ? 'SELECT coalesce(json_agg(row_to_json(m) ORDER BY "migration_name"),\'[]\'::json) FROM public."_prisma_migrations" m'
          : "SELECT '[]'::json",
      ),
    };
    return { tables, metadata };
  }

  async verifyEquivalence(
    sourceUrl: string,
    targetUrl: string,
    applicationSchemas: readonly string[],
    policies: {
      source: EffectivePrincipalPolicy;
      target: EffectivePrincipalPolicy;
    },
  ): Promise<{ evidence: EquivalenceEvidence; observation: StepObservation }> {
    const sourcePrincipalBefore = assertEffectivePrincipalInventory(
      this.inventoryEffectivePrincipals(sourceUrl),
      policies.source,
    );
    const targetPrincipalBefore = assertEffectivePrincipalInventory(
      this.inventoryEffectivePrincipals(targetUrl),
      policies.target,
    );
    const [source, target] = await Promise.all([
      this.snapshot(sourceUrl, applicationSchemas),
      this.snapshot(targetUrl, applicationSchemas),
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
    const sourcePrincipalAfter = assertEffectivePrincipalInventory(
      this.inventoryEffectivePrincipals(sourceUrl),
      policies.source,
    );
    const targetPrincipalAfter = assertEffectivePrincipalInventory(
      this.inventoryEffectivePrincipals(targetUrl),
      policies.target,
    );
    if (
      sourcePrincipalBefore.inventorySha256 !==
        sourcePrincipalAfter.inventorySha256 ||
      targetPrincipalBefore.inventorySha256 !==
        targetPrincipalAfter.inventorySha256
    )
      throw new Error("postgres_generation_principal_inventory_drifted");
    const evidence: EquivalenceEvidence = Object.freeze({
      tables: Object.freeze(tables),
      catalogSha256: Object.freeze(source.metadata),
      equivalent: true,
      streamingHash: true,
      maxProcessBufferBytes: 8 * 1024 * 1024,
      effectivePrincipals: Object.freeze({
        sourceInventorySha256: sourcePrincipalAfter.inventorySha256,
        sourcePolicySha256: sourcePrincipalAfter.policySha256,
        targetInventorySha256: targetPrincipalAfter.inventorySha256,
        targetPolicySha256: targetPrincipalAfter.policySha256,
        stable: true as const,
      }),
    });
    return {
      evidence,
      observation: observation(RolloutStep.VerifyDataEquivalence, evidence),
    };
  }
}
