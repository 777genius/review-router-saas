import { requireFact } from "../../domain/certified-fork-effect-canonical.js";
import {
  canonicalRetainedBytes,
  factSha256,
  factSourceSha256,
  parseFactScope,
  parseRetainedFact,
  retainedKind,
  retainedReference,
  type RetainedFactInput,
  type RetainedFactKind,
  type RetainedFactScope,
} from "./certified-fork-proof-fact-types.js";

/** pg PoolClient/Client compatible; bind to the caller's transaction connection.
 * This layer never BEGINs, COMMITs, reconnects or retries. Protected writer custody
 * and producer validation are composition responsibilities, never a caller flag. */
export interface RetainedFactSql {
  query(
    sql: string,
    values: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
}
export function prismaRetainedFactSql(tx: {
  $queryRawUnsafe<T = unknown>(sql: string, ...values: unknown[]): Promise<T>;
}): RetainedFactSql {
  return {
    query: async (sql, values) => ({
      rows: await tx.$queryRawUnsafe<Record<string, unknown>[]>(sql, ...values),
    }),
  };
}
export type RetainedFact<K extends RetainedFactKind = RetainedFactKind> =
  Readonly<{
    fact: RetainedFactInput<K>;
    canonicalBytes: string;
    payloadHash: string;
    createdAtMs: number;
  }>;
const columns = [
  "proofSha256",
  "sourceSha256",
  "proofId",
  "formatVersion",
  "kind",
  "workspaceId",
  "repositoryConnectionId",
  "familyKey",
  "reviewHash",
  "producerKind",
  "producerId",
  "producerVersion",
  "sourceKey",
  "sourceRevision",
  "observedAtMs",
  "validUntilMs",
  "payload",
  "canonicalBytes",
  "payloadHash",
];
const selection = [...columns, "createdAtMs"].map((k) => `"${k}"`).join(",");
function milliseconds(value: unknown): number {
  requireFact(
    typeof value === "bigint" ||
      typeof value === "string" ||
      typeof value === "number",
  );
  requireFact(/^[1-9][0-9]*$/u.test(String(value)));
  const result = Number(value);
  requireFact(Number.isSafeInteger(result) && result > 0);
  return result;
}
function digestEqual(value: unknown, expected: Buffer) {
  requireFact(
    value instanceof Uint8Array && Buffer.from(value).equals(expected),
  );
}
function decode(row: Record<string, unknown>): RetainedFact {
  requireFact(row.formatVersion === 1);
  const fact = parseRetainedFact({
    proofId: row.proofId,
    kind: row.kind,
    scope: {
      workspaceId: row.workspaceId,
      repositoryConnectionId: row.repositoryConnectionId,
      familyKey: row.familyKey,
      reviewHash: row.reviewHash,
    },
    provenance: {
      producerKind: row.producerKind,
      producerId: row.producerId,
      producerVersion: row.producerVersion,
      sourceKey: row.sourceKey,
      sourceRevision: row.sourceRevision,
      observedAtMs: milliseconds(row.observedAtMs),
      validUntilMs:
        row.validUntilMs === null ? null : milliseconds(row.validUntilMs),
    },
    payload: row.payload,
  });
  const canonicalBytes = canonicalRetainedBytes(fact.payload);
  const payloadHash = factSha256(canonicalBytes).toString("hex");
  requireFact(
    row.canonicalBytes === canonicalBytes && row.payloadHash === payloadHash,
  );
  digestEqual(row.proofSha256, factSha256(fact.proofId));
  digestEqual(row.sourceSha256, factSourceSha256(fact));
  return Object.freeze({
    fact,
    canonicalBytes,
    payloadHash,
    createdAtMs: milliseconds(row.createdAtMs),
  });
}

/** Only for already authenticated feature-local producers. Methods distinguish
 * kinds but do not mint authority. No public route or runtime export is wired. */
export class CertifiedForkProofFactWriter {
  constructor(private readonly transaction: RetainedFactSql) {}
  admission(input: RetainedFactInput<"admission">) {
    return this.insert("admission", input);
  }
  authority(input: RetainedFactInput<"authority">) {
    return this.insert("authority", input);
  }
  evidence(input: RetainedFactInput<"evidence">) {
    return this.insert("evidence", input);
  }
  inventory(input: RetainedFactInput<"inventory">) {
    return this.insert("inventory", input);
  }
  output(input: RetainedFactInput<"output">) {
    return this.insert("output", input);
  }
  command(input: RetainedFactInput<"command">) {
    return this.insert("command", input);
  }
  private async insert<K extends RetainedFactKind>(
    kind: K,
    input: RetainedFactInput<K>,
  ): Promise<RetainedFact<K>> {
    const fact = parseRetainedFact(input);
    requireFact(fact.kind === kind);
    const bytes = canonicalRetainedBytes(fact.payload),
      p = fact.provenance,
      s = fact.scope;
    const proofDigest = factSha256(fact.proofId),
      sourceDigest = factSourceSha256(fact);
    const values: unknown[] = [
      proofDigest,
      sourceDigest,
      fact.proofId,
      1,
      kind,
      s.workspaceId,
      s.repositoryConnectionId,
      s.familyKey,
      s.reviewHash,
      p.producerKind,
      p.producerId,
      p.producerVersion,
      p.sourceKey,
      p.sourceRevision,
      String(p.observedAtMs),
      p.validUntilMs === null ? null : String(p.validUntilMs),
      bytes,
      bytes,
      factSha256(bytes).toString("hex"),
    ];
    const inserted = await this.transaction.query(
      `INSERT INTO public."CertifiedForkProofFact"
      (${columns.map((k) => `"${k}"`).join(",")}) VALUES
      (${values.map((_, i) => `$${i + 1}${i === 16 ? "::jsonb" : ""}`).join(",")})
      ON CONFLICT DO NOTHING RETURNING ${selection}`,
      values,
    );
    // Separate READ COMMITTED statement sees the competing committed insert
    // after the unique index wait. Higher isolation may fail; no internal retry.
    const rows = inserted.rows.length
      ? inserted.rows
      : (
          await this.transaction.query(
            `SELECT ${selection} FROM public."CertifiedForkProofFact" WHERE "proofSha256"=$1 OR "sourceSha256"=$2`,
            [proofDigest, sourceDigest],
          )
        ).rows;
    requireFact(rows.length === 1);
    const retained = decode(rows[0]!);
    // Full identity/provenance/bytes comparison, never hash-only replay. Includes
    // scope, observed/valid times, producer version, proofId and source revision.
    requireFact(
      canonicalRetainedBytes(retained.fact) === canonicalRetainedBytes(fact),
    );
    return retained as RetainedFact<K>; // Discriminant checked above and in decode.
  }
}

/** Composition must supply a committed reader connection in protected custody,
 * scoped to an authenticated principal. No warm cache or expiring source lookup.
 * Reading through an uncommitted writer connection is NOT a durability receipt. */
export class CertifiedForkProofFactReader {
  constructor(private readonly committedReader: RetainedFactSql) {}
  async read<K extends RetainedFactKind>(
    kind: K,
    proofId: string,
    scope: RetainedFactScope,
  ): Promise<RetainedFact<K> | null> {
    retainedKind(kind);
    retainedReference(proofId);
    const expected = parseFactScope(scope);
    const { rows } = await this.committedReader.query(
      `SELECT ${selection} FROM public."CertifiedForkProofFact" WHERE "proofSha256"=$1`,
      [factSha256(proofId)],
    );
    if (!rows.length) return null;
    requireFact(rows.length === 1);
    const retained = decode(rows[0]!);
    requireFact(
      retained.fact.proofId === proofId &&
        retained.fact.kind === kind &&
        canonicalRetainedBytes(retained.fact.scope) ===
          canonicalRetainedBytes(expected),
    );
    return retained as RetainedFact<K>;
  }
}
