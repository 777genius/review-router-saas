import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type {
  CertifiedForkEffectRepositoryPort,
  ForkTransaction,
  ForkLedgerSnapshot,
  ForkCommandReceipt,
  ForkLoadedReview,
  ForkComparison,
} from "../../application/ports/certified-fork-effect-repository-port.js";
import type { CertifiedForkEffectProofPort } from "../../application/ports/certified-fork-effect-proof-port.js";
import {
  hash,
  opaqueId,
  next,
  requireFact,
  authentic,
  fingerprint,
} from "../../domain/certified-fork-effect-canonical.js";
import {
  prismaRetainedFactSql,
  type RetainedFactSql,
} from "./certified-fork-proof-fact-store.js";
import {
  archiveCounter,
  archiveTime,
  archiveSnapshot,
  archiveReceipt,
  archiveComparison,
  archiveJson,
  sameArchive,
  checkpointComparison,
} from "./certified-fork-archive-codec.js";

export type ForkArchiveOperation =
  | "acquireClaim"
  | "renewClaim"
  | "releaseClaim"
  | "compareAndCommit";
export type ForkArchiveVersion = Readonly<{
  snapshot: ForkLedgerSnapshot;
  receipt: ForkCommandReceipt;
  operation: ForkArchiveOperation;
  comparison: ForkComparison;
  committedAt: number;
}>;
/** The owner must commit once BEFORE resolving, rollback on failure, never
 * reconnect/retry or return a result from an uncommitted caller transaction.
 * READ COMMITTED is required: current-scope locks precede family serialization.
 * Read transactions pin an immutable tip and restrict receipts to that tip. */
export interface ForkArchiveTransactions {
  run<T>(
    mode: "read" | "write",
    work: (sql: RetainedFactSql) => Promise<T>,
  ): Promise<T>;
}
export function prismaForkArchiveTransactions(
  prisma: Pick<PrismaClient, "$transaction">,
): ForkArchiveTransactions {
  return {
    run: (_mode, work) =>
      prisma.$transaction((tx) => work(prismaRetainedFactSql(tx)), {
        isolationLevel: "ReadCommitted",
      }),
  };
}

/** Required trusted integration, intentionally no implementation/default here.
 * Cryptographic principal preflight and immutable remote candidates are prepared
 * before invocation. Guard/control locks use the report's global/workspace/repo
 * order BEFORE the family lock, including read/recovery. lockScope does not apply
 * new-command admission; recovery checks the original principal without a lease.
 * authenticateHistory loads retained facts/predecessors and restores the proof
 * port's verified read set BEFORE build. It must verify provenance and all bytes,
 * including original command preimages, not just the structural indexes below.
 */
export interface ForkArchiveTrustedHooks {
  readonly proofs: CertifiedForkEffectProofPort;
  lockScope(
    sql: RetainedFactSql,
    familyKey: string,
  ): Promise<{
    assertRead(at: number, originalOwner: string | null): void;
    prepareCommand(
      sql: RetainedFactSql,
      command: Omit<ForkTransaction, "build">,
      current: ForkArchiveVersion | null,
      operation: ForkArchiveOperation,
    ): Promise<{
      /** Bind the SAME proof port used by the use-case closure to the locked
       * transaction view, check principal/admission at `at`, invoke once now,
       * and unbind in finally. No async work or history replay inside run. */
      run<T>(at: number, work: () => T): T;
      /** Retain new authority/checkpoint/command facts on THIS connection.
       * No staged record may authenticate committed reads before commit. */
      retain(sql: RetainedFactSql, version: ForkArchiveVersion): Promise<void>;
    }>;
    /** Nonthrowing, in-memory cleanup. For writes called after runner settles
     * (and after committed on acknowledged success), so pending verified facts
     * can be promoted first. Discard transient staging even on ambiguous errors;
     * this does not assert that the database rolled back. No SQL in close. */
    close(): void;
  }>;
  authenticateHistory(
    sql: RetainedFactSql,
    versions: readonly ForkArchiveVersion[],
  ): Promise<void>;
  /** Promote only successfully committed retained facts to the request read set.
   * On lost commit acknowledgement this is not invoked: caller recovers by read. */
  committed(loaded: ForkLoadedReview): void;
}

export const forkArchiveJoinedQuery = `SELECT v.*, r."commandId", r."commandHash", r."ownerHash", r."operation",
  c."proof", c."proofSha256", c."formatVersion" AS "checkpointFormat",
  c."prefixLength", c."prefixHash", c."anchorHash", c."positionCommandId",
  c."positionCommandHash", c."state"
  FROM public."CertifiedForkVersion" v
  LEFT JOIN public."CertifiedForkReceipt" r USING ("familyKey", "version", "reviewHash")
  LEFT JOIN public."CertifiedForkCheckpoint" c USING ("familyKey", "version", "reviewHash")`;
export function decodeForkArchiveJoinedRow(
  row: Record<string, unknown>,
): ForkArchiveVersion {
  requireFact(row.formatVersion === 1 && row.checkpointFormat === 1);
  const version = archiveCounter(row.version);
  const snapshot = archiveSnapshot({
    familyKey: row.familyKey,
    version,
    reviewHash: row.reviewHash,
    seed: row.seed,
    admissionProof: row.admissionProof,
    fence: archiveCounter(row.fence),
    claim:
      row.claimOwnerHash === null
        ? null
        : {
            ownerHash: row.claimOwnerHash,
            claimHash: row.claimHash,
            epoch: archiveCounter(row.claimEpoch),
            expiresAt: archiveTime(row.claimExpiresAtMs),
          },
    events: row.events,
    checkpoint: {
      proof: row.proof,
      prefixLength: row.prefixLength,
      prefixHash: row.prefixHash,
      anchorHash: row.anchorHash,
      position: {
        commandId: row.positionCommandId,
        commandHash: row.positionCommandHash,
      },
      state: row.state,
    },
  });
  requireFact(
    row.claimOwnerHash !== null ||
      [row.claimHash, row.claimEpoch, row.claimExpiresAtMs].every(
        (v) => v === null,
      ),
  );
  requireFact(
    snapshot.seed.facts.generation === archiveCounter(row.generation),
  );
  requireFact(
    row.proofSha256 instanceof Uint8Array &&
      Buffer.from(row.proofSha256).equals(
        createHash("sha256")
          .update(snapshot.checkpoint!.proof, "utf8")
          .digest(),
      ),
  );
  const receipt = archiveReceipt({
    ownerHash: row.ownerHash,
    commandId: row.commandId,
    commandHash: row.commandHash,
    reviewHash: row.reviewHash,
    version,
  });
  requireFact(
    snapshot.checkpoint!.position?.commandId === receipt.commandId &&
      snapshot.checkpoint!.position.commandHash === receipt.commandHash,
  );
  const indexed = archiveComparison({
    reviewHash: row.reviewHash,
    version,
    fence: snapshot.fence,
    claim: snapshot.claim,
    ledgerHash: row.ledgerHash,
    outcomeHash: row.outcomeHash,
    revisions: row.revisions,
  });
  requireFact(sameArchive(indexed, checkpointComparison(snapshot)));
  const operation = row.operation;
  requireFact(
    operation === "acquireClaim" ||
      operation === "renewClaim" ||
      operation === "releaseClaim" ||
      operation === "compareAndCommit",
  );
  const committedAt = archiveTime(row.committedAtMs);
  requireFact(snapshot.events.every((e) => e.at <= committedAt));
  return Object.freeze({
    snapshot,
    receipt,
    operation,
    comparison: indexed,
    committedAt,
  });
}
async function readVersion(
  sql: RetainedFactSql,
  family: string,
  version: string,
): Promise<ForkArchiveVersion> {
  const { rows } = await sql.query(
    `${forkArchiveJoinedQuery}
    WHERE v."familyKey"=$1 AND v."version"=$2::bigint`,
    [family, version],
  );
  requireFact(rows.length === 1); // Missing version/checkpoint/receipt fails closed.
  return decodeForkArchiveJoinedRow(rows[0]!);
}
async function storageTime(sql: RetainedFactSql): Promise<number> {
  const { rows } = await sql.query(
    `SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS "at"`,
    [],
  );
  requireFact(rows.length === 1);
  return archiveTime(rows[0]!.at);
}
async function insert(
  sql: RetainedFactSql,
  table: string,
  fields: Record<string, unknown>,
): Promise<void> {
  const names = Object.keys(fields);
  const bigint = new Set([
    "version",
    "generation",
    "fence",
    "claimEpoch",
    "claimExpiresAtMs",
    "committedAtMs",
  ]);
  const jsonb = new Set(["seed", "events", "revisions", "state"]);
  const cast = (name: string) =>
    bigint.has(name)
      ? "bigint"
      : jsonb.has(name)
        ? "jsonb"
        : name === "proofSha256"
          ? "bytea"
          : ["formatVersion", "prefixLength"].includes(name)
            ? "integer"
            : "text";
  // Table/column names come exclusively from literals below, values are parameters.
  await sql.query(
    `INSERT INTO public."${table}" (${names.map((n) => `"${n}"`).join(",")})
    VALUES (${names.map((name, i) => `$${i + 1}::${cast(name)}`).join(",")})`,
    Object.values(fields),
  );
}
async function persist(
  sql: RetainedFactSql,
  value: ForkArchiveVersion,
): Promise<void> {
  const s = value.snapshot,
    c = s.checkpoint!,
    r = value.receipt,
    index = value.comparison;
  await insert(sql, "CertifiedForkVersion", {
    familyKey: s.familyKey,
    version: s.version,
    formatVersion: 1,
    reviewHash: s.reviewHash,
    generation: s.seed.facts.generation,
    seed: archiveJson(s.seed),
    admissionProof: s.admissionProof,
    fence: s.fence,
    claimOwnerHash: s.claim?.ownerHash ?? null,
    claimHash: s.claim?.claimHash ?? null,
    claimEpoch: s.claim?.epoch ?? null,
    claimExpiresAtMs: s.claim ? String(s.claim.expiresAt) : null,
    events: archiveJson(s.events),
    ledgerHash: index.ledgerHash,
    outcomeHash: index.outcomeHash,
    revisions: archiveJson(index.revisions),
    committedAtMs: String(value.committedAt),
  });
  await insert(sql, "CertifiedForkReceipt", {
    familyKey: s.familyKey,
    ...r,
    operation: value.operation,
  });
  await insert(sql, "CertifiedForkCheckpoint", {
    familyKey: s.familyKey,
    version: s.version,
    reviewHash: s.reviewHash,
    proof: c.proof,
    proofSha256: createHash("sha256").update(c.proof, "utf8").digest(),
    formatVersion: 1,
    prefixLength: c.prefixLength,
    prefixHash: c.prefixHash,
    anchorHash: c.anchorHash,
    positionCommandId: r.commandId,
    positionCommandHash: r.commandHash,
    state: archiveJson(c.state),
  });
  if (s.version !== "1")
    await sql.query(
      `UPDATE public."CertifiedForkFamily" SET "tipVersion"=$2::bigint WHERE "familyKey"=$1`,
      [s.familyKey, s.version],
    );
}

/** Protected archive custody only; not composed into any enabled runtime. */
export class PrismaCertifiedForkEffectRepository implements CertifiedForkEffectRepositoryPort {
  constructor(
    private readonly transactions: ForkArchiveTransactions,
    private readonly trusted: ForkArchiveTrustedHooks,
  ) {}

  private async history(
    sql: RetainedFactSql,
    current: ForkArchiveVersion | null,
    commandId?: string,
  ) {
    let original: ForkArchiveVersion | null = null;
    if (current && commandId) {
      const { rows } = await sql.query(
        `SELECT "version" FROM public."CertifiedForkReceipt"
        WHERE "familyKey"=$1 AND "commandId"=$2 AND "version"<=$3::bigint`,
        [current.snapshot.familyKey, commandId, current.snapshot.version],
      );
      requireFact(rows.length <= 1);
      if (rows.length) {
        const version = archiveCounter(rows[0]!.version);
        original =
          version === current.snapshot.version
            ? current
            : await readVersion(sql, current.snapshot.familyKey, version);
        requireFact(original.receipt.commandId === commandId);
      }
    }
    return { current, original };
  }
  private async authenticate(
    sql: RetainedFactSql,
    current: ForkArchiveVersion | null,
    original: ForkArchiveVersion | null,
  ) {
    const versions = current
      ? original && original !== current
        ? [current, original]
        : [current]
      : [];
    await this.trusted.authenticateHistory(sql, Object.freeze(versions));
    for (const v of versions) {
      this.trusted.proofs.verifyLedger(v.snapshot);
      // Every stored version has a full checkpoint: no bounded ingress capture
      // of the entire durable history and no event replay inside build.
      const restored = this.trusted.proofs.restoreCheckpoint(
        v.snapshot.checkpoint!,
        v.snapshot,
      );
      authentic("review", restored.review);
      restored.states.forEach((state) => authentic("state", state));
      if (restored.inventory) authentic("inventory", restored.inventory);
      if (restored.outcome) authentic("outcome", restored.outcome);
      requireFact(
        sameArchive(restored, v.snapshot.checkpoint!.state) &&
          restored.review.familyKey === v.snapshot.familyKey &&
          fingerprint("fork-admission", restored.review) ===
            v.snapshot.reviewHash,
      );
      this.trusted.proofs.verifyReceipt(v.receipt, v.snapshot);
    }
  }
  async loadReview(
    familyKey: string,
    commandId?: string,
  ): Promise<ForkLoadedReview> {
    hash(familyKey);
    if (commandId !== undefined) opaqueId(commandId);
    return this.transactions.run("read", async (sql) => {
      const scope = await this.trusted.lockScope(sql, familyKey);
      try {
        const { rows } = await sql.query(
          `SELECT "tipVersion" FROM public."CertifiedForkFamily" WHERE "familyKey"=$1`,
          [familyKey],
        );
        requireFact(rows.length <= 1);
        // Pin once. All later reads are immutable and constrained to this tip;
        // concurrent later receipts cannot leak into the consistent read set.
        const current = rows.length
          ? await readVersion(
              sql,
              familyKey,
              archiveCounter(rows[0]!.tipVersion),
            )
          : null;
        const { original } = await this.history(sql, current, commandId);
        await this.authenticate(sql, current, original);
        scope.assertRead(
          await storageTime(sql),
          original?.receipt.ownerHash ?? null,
        );
        return Object.freeze({
          snapshot: current?.snapshot ?? null,
          receipt: original?.receipt ?? null,
        });
      } finally {
        scope.close();
      }
    });
  }
  acquireClaim = (tx: ForkTransaction) => this.transact("acquireClaim", tx);
  renewClaim = (tx: ForkTransaction) => this.transact("renewClaim", tx);
  releaseClaim = (tx: ForkTransaction) => this.transact("releaseClaim", tx);
  compareAndCommit = (tx: ForkTransaction) =>
    this.transact("compareAndCommit", tx);

  private async transact(
    operation: ForkArchiveOperation,
    tx: ForkTransaction,
  ): Promise<ForkLoadedReview> {
    const command = Object.freeze({
      familyKey: hash(tx.familyKey),
      commandId: opaqueId(tx.commandId),
      commandHash: hash(tx.commandHash),
      expected: tx.expected === null ? null : archiveComparison(tx.expected),
    });
    const build = tx.build;
    requireFact(typeof build === "function");
    let close: (() => void) | undefined;
    try {
      const loaded = await this.transactions.run("write", async (sql) => {
        const scope = await this.trusted.lockScope(sql, command.familyKey);
        close = () => scope.close();
        const inserted = await sql.query(
          `INSERT INTO public."CertifiedForkFamily" ("familyKey","tipVersion")
          VALUES ($1,1) ON CONFLICT ("familyKey") DO NOTHING RETURNING "familyKey"`,
          [command.familyKey],
        );
        const { rows } = await sql.query(
          `SELECT "tipVersion" FROM public."CertifiedForkFamily" WHERE "familyKey"=$1 FOR UPDATE`,
          [command.familyKey],
        );
        requireFact(rows.length === 1);
        // Only OUR successful insert can mean absence. A competing insert waits
        // on the exact PK, then reads its committed version on this connection.
        const current = inserted.rows.length
          ? null
          : await readVersion(
              sql,
              command.familyKey,
              archiveCounter(rows[0]!.tipVersion),
            );
        const { original } = await this.history(
          sql,
          current,
          command.commandId,
        );
        if (original)
          requireFact(original.receipt.commandHash === command.commandHash);
        await this.authenticate(sql, current, original);
        if (original) {
          scope.assertRead(await storageTime(sql), original.receipt.ownerHash);
          return Object.freeze({
            snapshot: current!.snapshot,
            receipt: original.receipt,
            replayed: true,
          });
        }
        requireFact(sameArchive(current?.comparison ?? null, command.expected));
        const binding = await scope.prepareCommand(
          sql,
          command,
          current,
          operation,
        );
        const at = await storageTime(sql); // after every potentially waiting lock/I/O
        requireFact(!current || at >= current.committedAt);
        const prior = current?.snapshot ?? null;
        requireFact(
          operation === "acquireClaim"
            ? !prior?.claim || prior.claim.expiresAt <= at
            : prior?.claim && prior.claim.expiresAt > at,
        );
        let invoked = false;
        const version = binding.run(at, () => {
          requireFact(!invoked);
          invoked = true;
          const built = build(prior, at);
          authentic("review", built.state.review);
          built.state.states.forEach((state) => authentic("state", state));
          if (built.state.inventory)
            authentic("inventory", built.state.inventory);
          if (built.state.outcome) authentic("outcome", built.state.outcome);
          const proposed = archiveSnapshot(built.snapshot);
          requireFact(
            proposed.familyKey === command.familyKey &&
              proposed.version === next(prior?.version ?? "0"),
          );
          requireFact(
            proposed.fence ===
              (operation === "acquireClaim"
                ? next(prior?.fence ?? "0")
                : prior?.fence),
          );
          if (operation !== "acquireClaim")
            requireFact(proposed.reviewHash === prior?.reviewHash);
          const owner =
            operation === "acquireClaim" ? proposed.claim : prior?.claim;
          requireFact(owner);
          const receipt = archiveReceipt({
            ownerHash: owner.ownerHash,
            commandId: command.commandId,
            commandHash: command.commandHash,
            reviewHash: proposed.reviewHash,
            version: proposed.version,
          });
          // Always replace caller checkpoint, including zero-event commands.
          const checkpoint = this.trusted.proofs.issueCheckpoint(
            proposed,
            built.state,
            { commandId: command.commandId, commandHash: command.commandHash },
          );
          const snapshot = archiveSnapshot({ ...proposed, checkpoint });
          requireFact(sameArchive(snapshot.checkpoint!.state, built.state));
          requireFact(
            sameArchive(snapshot.checkpoint!.position, {
              commandId: command.commandId,
              commandHash: command.commandHash,
            }),
          );
          return Object.freeze({
            snapshot,
            receipt,
            operation,
            comparison: checkpointComparison(snapshot),
            committedAt: at,
          });
        });
        requireFact(
          invoked &&
            version !== null &&
            typeof version === "object" &&
            !(version instanceof Promise),
        );
        await binding.retain(sql, version);
        await persist(sql, version);
        // Force the schema's full prefix, generation, claim and sibling guards
        // before returning from callback. COMMIT still belongs to the runner.
        await sql.query("SET CONSTRAINTS ALL IMMEDIATE", []);
        return Object.freeze({
          snapshot: version.snapshot,
          receipt: version.receipt,
        });
      });
      this.trusted.committed(loaded);
      return loaded;
    } finally {
      close?.();
    }
  }
}
