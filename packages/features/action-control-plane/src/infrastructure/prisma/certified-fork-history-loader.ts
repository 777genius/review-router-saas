import {
  hash,
  requireFact,
} from "../../domain/certified-fork-effect-canonical.js";
import type { ProtectedForkHistoricalSource } from "../proofs/certified-fork-historical-source.js";
import { archiveCounter } from "./certified-fork-archive-codec.js";
import {
  CertifiedForkProofFactReader,
  type RetainedFact,
  type RetainedFactSql,
} from "./certified-fork-proof-fact-store.js";
import type {
  RetainedFactKind,
  RetainedFactScope,
} from "./certified-fork-proof-fact-types.js";
import {
  decodeForkArchiveJoinedRow,
  forkArchiveJoinedQuery,
  type ForkArchiveVersion,
} from "./prisma-certified-fork-effect-repository.js";

/** INTERNAL mandatory current principal/read authorization. Implementations must
 * acquire current control guards on this connection before checking permission;
 * historical facts cannot implement this check. No default or caller DTO flag. */
export type ForkHistoryReadGuard = (
  sql: RetainedFactSql,
  familyKey: string,
) => Promise<void>;

export type CommittedForkHistory = Readonly<{
  familyKey: string;
  tipVersion: string;
  versions: readonly ForkArchiveVersion[];
  readFact<K extends RetainedFactKind>(
    kind: K,
    proof: string,
    scope: RetainedFactScope,
  ): Promise<RetainedFact<K>>;
}>;

/** Storage only: no domain branding, producer authentication or write hooks.
 * The owner supplies a protected committed-reader connection (never a transaction
 * containing staged writes), keeps it alive through restoration, and owns its
 * transaction/guard lifetime. Like CertifiedForkProofFactReader, SQL cannot infer
 * commit custody from a timestamp or distinguish its own staged writes. Do not
 * invoke inside build/run/retain. No BEGIN, commit, reconnect, retry or promotion.
 * READ COMMITTED is sufficient because archive rows are immutable and every
 * archive query is constrained to the one sampled tip. */
export async function loadCommittedForkHistory(
  sql: RetainedFactSql,
  familyKey: string,
  assertCurrentRead: ForkHistoryReadGuard,
): Promise<CommittedForkHistory> {
  hash(familyKey);
  await assertCurrentRead(sql, familyKey);
  const family = await sql.query(
    `SELECT "tipVersion" FROM public."CertifiedForkFamily" WHERE "familyKey"=$1`,
    [familyKey],
  );
  requireFact(family.rows.length === 1);
  const tipVersion = archiveCounter(family.rows[0]!.tipVersion);
  // Match the historical restorer's explicit bound; never silently load a suffix.
  requireFact(BigInt(tipVersion) > 0n && BigInt(tipVersion) <= 10_000n);
  const { rows } = await sql.query(
    `${forkArchiveJoinedQuery}
    WHERE v."familyKey"=$1 AND v."version">=1 AND v."version"<=$2::bigint
    ORDER BY v."version" ASC`,
    [familyKey, tipVersion],
  );
  requireFact(rows.length === Number(tipVersion));
  const commands = new Set<string>(),
    checkpoints = new Set<string>();
  const versions = Object.freeze(
    rows.map((row, index) => {
      const version = decodeForkArchiveJoinedRow(row);
      requireFact(
        version.snapshot.familyKey === familyKey &&
          version.snapshot.version === String(index + 1),
      );
      const proof = version.snapshot.checkpoint!.proof;
      requireFact(
        !commands.has(version.receipt.commandId) && !checkpoints.has(proof),
      );
      commands.add(version.receipt.commandId);
      checkpoints.add(proof);
      return version;
    }),
  );
  const reader = new CertifiedForkProofFactReader(sql);
  return Object.freeze({
    familyKey,
    tipVersion,
    versions,
    async readFact<K extends RetainedFactKind>(
      kind: K,
      proof: string,
      scope: RetainedFactScope,
    ): Promise<RetainedFact<K>> {
      requireFact(
        scope.familyKey === familyKey &&
          versions.some(
            ({ snapshot: s }) =>
              s.reviewHash === scope.reviewHash &&
              s.seed.facts.workspaceId === scope.workspaceId &&
              s.seed.facts.repositoryId === scope.repositoryConnectionId,
          ),
      );
      await assertCurrentRead(sql, familyKey);
      const fact = await reader.read(kind, proof, scope);
      requireFact(fact);
      return fact;
    },
  });
}

type Opened = Awaited<ReturnType<ProtectedForkHistoricalSource["open"]>>;
type Extra<K extends RetainedFactKind> =
  Parameters<Opened[K]> extends [RetainedFactScope, string, ...infer Tail]
    ? Tail
    : never;
/** Fixed authenticated producers are mandatory protected composition. Each must
 * verify its original source custody/version/preimages and full closure, including
 * output read-before-command. Labels, hashes and observed/committed times do not
 * provide that authentication. This module supplies no producer implementations. */
export type ForkHistoryProducers = {
  [K in RetainedFactKind]: (
    history: CommittedForkHistory,
    retained: RetainedFact<K>,
    ...extra: Extra<K>
  ) => Promise<Omit<Awaited<ReturnType<Opened[K]>>, "fact">>;
};

/** Feature-local composition only; no public runtime export or current execution
 * authority. Every resolution passes the same committed retained reader before
 * invoking the separately authenticated producer. */
export class CertifiedForkHistoryLoader implements ProtectedForkHistoricalSource {
  constructor(
    private readonly sql: RetainedFactSql,
    private readonly assertCurrentRead: ForkHistoryReadGuard,
    private readonly producers: ForkHistoryProducers,
  ) {}

  async open(familyKey: string): Promise<Opened> {
    const history = await loadCommittedForkHistory(
      this.sql,
      familyKey,
      this.assertCurrentRead,
    );
    const resolve = async <K extends RetainedFactKind>(
      kind: K,
      scope: RetainedFactScope,
      proof: string,
      ...extra: Extra<K>
    ) => {
      const retained = await history.readFact(kind, proof, scope);
      const resolved = await this.producers[kind](history, retained, ...extra);
      return { ...resolved, fact: retained.fact };
    };
    return {
      familyKey,
      tipVersion: history.tipVersion,
      versions: history.versions,
      admission: (scope, proof) => resolve("admission", scope, proof),
      command: (scope, proof) => resolve("command", scope, proof),
      authority: (scope, proof) => resolve("authority", scope, proof),
      evidence: (scope, proof, origin) =>
        resolve("evidence", scope, proof, origin),
      inventory: (scope, proof, event) =>
        resolve("inventory", scope, proof, event),
      output: (scope, proof, command) =>
        resolve("output", scope, proof, command),
    };
  }
}
