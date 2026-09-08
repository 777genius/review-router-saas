import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  CertifiedForkHistoryLoader,
  loadCommittedForkHistory,
  type ForkHistoryProducers,
} from "../infrastructure/prisma/certified-fork-history-loader.js";
import {
  canonicalRetainedBytes,
  factSha256,
  factSourceSha256,
  type AnyRetainedFactInput,
} from "../infrastructure/prisma/certified-fork-proof-fact-types.js";
import { restoreCertifiedForkCheckpoint } from "../infrastructure/proofs/restore-certified-fork-checkpoint.js";
import { archiveRow } from "./support/certified-fork-archive-fixture.js";
import {
  coldHistoryFixture,
  controlledColdSource,
} from "./support/certified-fork-cold-history.js";

let fixture: Awaited<ReturnType<typeof coldHistoryFixture>>;
beforeAll(async () => {
  fixture = await coldHistoryFixture();
});
function factRow(fact: AnyRetainedFactInput): Record<string, unknown> {
  const canonicalBytes = canonicalRetainedBytes(fact.payload);
  return {
    ...fact,
    ...fact.scope,
    ...fact.provenance,
    formatVersion: 1,
    proofSha256: factSha256(fact.proofId),
    sourceSha256: factSourceSha256(fact),
    canonicalBytes,
    payloadHash: factSha256(canonicalBytes).toString("hex"),
    createdAtMs: "1",
  };
}
function controlled() {
  const rows = fixture.disk.versions.map((v) => ({
    ...archiveRow(v),
    proofSha256: factSha256(v.snapshot.checkpoint!.proof),
  }));
  const state = {
    family: [{ tipVersion: String(rows.length) }] as Record<string, unknown>[],
    rows: rows as Record<string, unknown>[],
    facts: Object.values(fixture.disk.facts).map(factRow),
  };
  const query = vi.fn(async (sql: string, values: unknown[]) => {
    if (sql.includes('FROM public."CertifiedForkFamily"'))
      return { rows: state.family };
    if (sql.includes('FROM public."CertifiedForkVersion"'))
      return { rows: state.rows };
    if (sql.includes('FROM public."CertifiedForkProofFact"'))
      return {
        rows: state.facts.filter((r) =>
          Buffer.from(r.proofSha256 as Uint8Array).equals(values[0] as Buffer),
        ),
      };
    throw new Error(`unexpected SQL: ${sql}`);
  });
  const guard = vi.fn(async (sql, family) => {
    expect(sql).toBe(connection);
    expect(family).toBe(fixture.familyKey);
  });
  const connection = { query };
  return { state, connection, guard };
}

describe("committed SQL history loading (controlled SQL results)", () => {
  it("pins once and reads complete nonempty history through the joined decoder", async () => {
    const db = controlled();
    const opened = await loadCommittedForkHistory(
      db.connection,
      fixture.familyKey,
      db.guard,
    );
    expect(opened.versions).toEqual(fixture.disk.versions);
    expect(opened.versions.some((v) => v.snapshot.events.length > 0)).toBe(
      true,
    );
    expect(Object.isFrozen(opened.versions)).toBe(true);
    const [query, values] = db.connection.query.mock.calls[1]!;
    expect(query).toContain('LEFT JOIN public."CertifiedForkReceipt"');
    expect(query).toContain('LEFT JOIN public."CertifiedForkCheckpoint"');
    expect(query).toContain('v."version"<=$2::bigint');
    expect(query).toContain('ORDER BY v."version" ASC');
    expect(values).toEqual([fixture.familyKey, opened.tipVersion]);
    db.state.family = [{ tipVersion: String(Number(opened.tipVersion) + 1) }];
    expect(opened.tipVersion).toBe(String(fixture.disk.versions.length));
    expect(db.guard.mock.invocationCallOrder[0]).toBeLessThan(
      db.connection.query.mock.invocationCallOrder[0]!,
    );
  });

  it.each([
    [],
    [{ tipVersion: "0" }],
    [{ tipVersion: "10001" }],
    [{ tipVersion: "01" }],
    [{ tipVersion: "1" }, { tipVersion: "1" }],
  ])("rejects missing/empty/invalid family %j", async (...family) => {
    const db = controlled();
    db.state.family = family as Record<string, unknown>[];
    await expect(
      loadCommittedForkHistory(db.connection, fixture.familyKey, db.guard),
    ).rejects.toThrow();
  });

  it.each([
    "gap",
    "empty",
    "duplicate",
    "reordered",
    "cross-family",
    "later-row",
    "receipt",
    "checkpoint",
    "digest",
    "events",
    "command-duplicate",
    "proof-duplicate",
  ])("rejects %s instead of returning partial history", async (fault) => {
    const db = controlled(),
      rows = db.state.rows;
    const first = rows[0]!;
    if (fault === "gap") rows.splice(1, 1);
    if (fault === "empty") rows.length = 0;
    if (fault === "duplicate") rows[1] = first;
    if (fault === "reordered") rows.reverse();
    if (fault === "cross-family") first.familyKey = "f".repeat(64);
    if (fault === "later-row") rows.push(first);
    if (fault === "receipt") first.commandId = null;
    if (fault === "checkpoint") first.checkpointFormat = null;
    if (fault === "digest") first.proofSha256 = Buffer.alloc(32);
    if (fault === "events") first.events = {};
    if (fault === "command-duplicate") {
      rows[1]!.commandId = first.commandId;
      rows[1]!.positionCommandId = first.commandId;
    }
    if (fault === "proof-duplicate") {
      rows[1]!.proof = first.proof;
      rows[1]!.proofSha256 = first.proofSha256;
    }
    await expect(
      loadCommittedForkHistory(db.connection, fixture.familyKey, db.guard),
    ).rejects.toThrow();
  });

  it("denies before any SQL, and propagates SQL failures", async () => {
    const db = controlled();
    db.guard.mockRejectedValueOnce(new Error("read_denied"));
    await expect(
      loadCommittedForkHistory(db.connection, fixture.familyKey, db.guard),
    ).rejects.toThrow("read_denied");
    expect(db.connection.query).not.toHaveBeenCalled();
    db.connection.query.mockRejectedValueOnce(new Error("connection_lost"));
    await expect(
      loadCommittedForkHistory(db.connection, fixture.familyKey, db.guard),
    ).rejects.toThrow("connection_lost");
  });

  it.each(["missing", "kind", "scope", "hash", "bytes", "duplicate", "denial"])(
    "retained reader rejects %s on the same connection",
    async (fault) => {
      const db = controlled();
      const opened = await loadCommittedForkHistory(
        db.connection,
        fixture.familyKey,
        db.guard,
      );
      const input = Object.values(fixture.disk.facts)[0]!;
      const row = db.state.facts[0]!;
      if (fault === "missing") db.state.facts = [];
      if (fault === "kind") row.kind = "output";
      if (fault === "scope") row.workspaceId = "another-tenant";
      if (fault === "hash") row.payloadHash = "f".repeat(64);
      if (fault === "bytes") row.canonicalBytes = "{}";
      if (fault === "duplicate") db.state.facts.push(row);
      if (fault === "denial")
        db.guard.mockRejectedValueOnce(new Error("revoked"));
      await expect(
        opened.readFact(input.kind, input.proofId, input.scope),
      ).rejects.toThrow();
      if (fault === "denial")
        expect(db.connection.query).toHaveBeenCalledTimes(2);
    },
  );

  it("requires the guard and rejects requested kind/scope substitutions", async () => {
    const db = controlled();
    await expect(
      loadCommittedForkHistory(
        db.connection,
        fixture.familyKey,
        undefined as unknown as typeof db.guard,
      ),
    ).rejects.toThrow();
    expect(db.connection.query).not.toHaveBeenCalled();
    const opened = await loadCommittedForkHistory(
      db.connection,
      fixture.familyKey,
      db.guard,
    );
    const input = Object.values(fixture.disk.facts)[0]!;
    expect(
      (await opened.readFact(input.kind, input.proofId, input.scope)).fact,
    ).toEqual(input);
    await expect(
      opened.readFact(
        input.kind === "output" ? "inventory" : "output",
        input.proofId,
        input.scope,
      ),
    ).rejects.toThrow();
    for (const scope of [
      { ...input.scope, familyKey: "f".repeat(64) },
      { ...input.scope, reviewHash: "f".repeat(64) },
      { ...input.scope, repositoryConnectionId: "other" },
    ])
      await expect(
        opened.readFact(input.kind, input.proofId, scope),
      ).rejects.toThrow();
  });

  it("composes all six mandatory TEST producers and restores all versions from SQL rows", async () => {
    const db = controlled();
    const source = await controlledColdSource(fixture.disk).open(
      fixture.familyKey,
    );
    // Explicit test custody remains separate from SQL decoding; use the existing
    // controlled producer checks, including command-specific output endorsement.
    const producers: ForkHistoryProducers = {
      admission: (_h, r) => source.admission(r.fact.scope, r.fact.proofId),
      command: (_h, r) => source.command(r.fact.scope, r.fact.proofId),
      authority: (_h, r) => source.authority(r.fact.scope, r.fact.proofId),
      evidence: (_h, r, origin) =>
        source.evidence(r.fact.scope, r.fact.proofId, origin),
      inventory: (_h, r, event) =>
        source.inventory(r.fact.scope, r.fact.proofId, event),
      output: (_h, r, command) =>
        source.output(r.fact.scope, r.fact.proofId, command),
    };
    const loader = new CertifiedForkHistoryLoader(
      db.connection,
      db.guard,
      producers,
    );
    const restored = await restoreCertifiedForkCheckpoint(
      loader,
      fixture.familyKey,
    );
    expect(restored.versions.map((v) => v.archive)).toEqual(
      fixture.disk.versions,
    );
    producers.command = async () => {
      throw new Error("producer_not_authenticated");
    };
    await expect(
      restoreCertifiedForkCheckpoint(loader, fixture.familyKey),
    ).rejects.toThrow("producer_not_authenticated");
  });
});
