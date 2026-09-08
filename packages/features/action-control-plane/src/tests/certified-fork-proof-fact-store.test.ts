import { describe, expect, it, vi } from "vitest";
import {
  CertifiedForkProofFactReader as Reader,
  CertifiedForkProofFactWriter as Writer,
  prismaRetainedFactSql,
} from "../infrastructure/prisma/certified-fork-proof-fact-store.js";
import {
  canonicalRetainedBytes,
  captureRetainedJson,
  factSha256,
  factSourceSha256,
  parseRetainedFact,
} from "../infrastructure/prisma/certified-fork-proof-fact-types.js";
import {
  fixtureHash,
  inventoryFact,
  outputFact,
} from "./certified-fork-proof-fact-fixtures.js";

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
// Controlled SQL RESULTS, not a database simulation or concurrency proof. Execute
// the actual store and inspect its SQL/parameters/decoding, including conflict reads.
function controlled() {
  let row: Record<string, unknown>;
  const query = vi.fn(async (sql: string, values: unknown[]) => {
    expect(sql).toMatch(/^INSERT INTO public\."CertifiedForkProofFact"/u);
    expect(sql).toContain("ON CONFLICT DO NOTHING RETURNING");
    expect(values).toHaveLength(columns.length);
    row = Object.fromEntries(columns.map((key, i) => [key, values[i]]));
    row.payload = JSON.parse(String(row.payload));
    row.createdAtMs = "123";
    return { rows: [row] };
  });
  return { query, row: () => structuredClone(row) };
}
const rejected = /certified_fork_effect_contract_rejected/u;
describe("retained fact actual store with controlled SQL results", () => {
  it("retains exact benign credential-related model keys and large output bytes; cold reader has only SQL", async () => {
    const db = controlled(),
      input = outputFact();
    const stored = await new Writer(db).output(input);
    const query = vi.fn().mockResolvedValue({ rows: [db.row()] });
    const cold = await new Reader({ query }).read(
      "output",
      input.proofId,
      input.scope,
    );
    expect(cold).toEqual(stored);
    expect(cold?.fact.payload.outputBytes).toBe(input.payload.outputBytes);
    expect(cold?.fact.payload.modelOutput).toEqual(input.payload.modelOutput);
    expect(stored.canonicalBytes).toBe(canonicalRetainedBytes(input.payload));
    expect(stored.payloadHash).toBe(
      factSha256(stored.canonicalBytes).toString("hex"),
    );
    expect(query.mock.calls[0]?.[1]).toEqual([factSha256(input.proofId)]);
    expect(Object.hasOwn(stored.fact.payload.modelOutput, "__proto__")).toBe(
      true,
    );
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
  it("replays only an identical full fact after a conflict, without updates or transaction management", async () => {
    const db = controlled(),
      input = inventoryFact();
    const original = await new Writer(db).inventory(input);
    db.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [db.row()] });
    expect(await new Writer(db).inventory(input)).toEqual(original);
    expect(db.query.mock.calls[2]?.[0]).toContain(
      'WHERE "proofSha256"=$1 OR "sourceSha256"=$2',
    );
    expect(db.query.mock.calls[2]?.[1]).toEqual([
      factSha256(input.proofId),
      factSourceSha256(input),
    ]);
    expect(db.query).toHaveBeenCalledTimes(3);
  });
  it("rejects proof/source collisions, changed provenance, and every scope substitution", async () => {
    const db = controlled(),
      original = inventoryFact();
    await new Writer(db).inventory(original);
    const variants = [
      { ...original, proofId: "other" },
      {
        ...original,
        payload: { ...original.payload, outputProof: "different" },
      },
      ...Object.keys(original.scope).map((key) => ({
        ...original,
        scope: {
          ...original.scope,
          [key]: key.endsWith("Id") ? "other" : fixtureHash(9),
        },
      })),
      ...Object.keys(original.provenance).map((key) => ({
        ...original,
        provenance: {
          ...original.provenance,
          [key]:
            key === "observedAtMs" ? 2 : key === "validUntilMs" ? 3 : "other",
        },
      })),
    ];
    for (const variant of variants) {
      db.query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [db.row()] });
      await expect(new Writer(db).inventory(variant)).rejects.toThrow(rejected);
    }
    for (const rows of [[], [db.row(), db.row()]]) {
      db.query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows });
      await expect(new Writer(db).inventory(original)).rejects.toThrow(
        rejected,
      );
    }
  });
  it("checks all reader scope fields, kind and full proof identity; absent read is null", async () => {
    const db = controlled(),
      input = inventoryFact();
    await new Writer(db).inventory(input);
    const query = vi.fn().mockResolvedValue({ rows: [db.row()] }),
      reader = new Reader({ query });
    for (const key of Object.keys(input.scope))
      await expect(
        reader.read("inventory", input.proofId, {
          ...input.scope,
          [key]: key.endsWith("Id") ? "other" : fixtureHash(9),
        }),
      ).rejects.toThrow(rejected);
    await expect(
      reader.read("output", input.proofId, input.scope),
    ).rejects.toThrow(rejected);
    await expect(
      reader.read("inventory", "different", input.scope),
    ).rejects.toThrow(rejected);
    query.mockResolvedValueOnce({ rows: [] });
    expect(await reader.read("inventory", "missing", input.scope)).toBeNull();
  });
  it("rejects corrupt SQL rows, including digest, bytes, timestamps and format", async () => {
    const db = controlled(),
      input = inventoryFact();
    await new Writer(db).inventory(input);
    for (const [key, value] of Object.entries({
      proofSha256: Buffer.alloc(32),
      sourceSha256: Buffer.alloc(32),
      payloadHash: fixtureHash(0),
      canonicalBytes: "{}",
      payload: {},
      createdAtMs: "9007199254740992",
      observedAtMs: "1.0",
      formatVersion: 2,
    })) {
      const query = vi
        .fn()
        .mockResolvedValue({ rows: [{ ...db.row(), [key]: value }] });
      await expect(
        new Reader({ query }).read("inventory", input.proofId, input.scope),
      ).rejects.toThrow(rejected);
    }
  });
  it("uses each closed kind's actual writer and retains full nested source material", async () => {
    const db = controlled(),
      writer = new Writer(db),
      base = inventoryFact("typed");
    const inputs = [
      {
        ...base,
        kind: "admission",
        payload: {
          seed: { sourceBytes: "source" },
          binding: {},
          packet: {},
          requests: [],
          remoteScopes: [],
          decisions: {},
          gatewayObservation: {},
          observationDeadlineMs: 3,
          policyVersion: "1",
          predecessor: null,
        },
      },
      {
        ...base,
        kind: "authority",
        payload: {
          authority: {},
          transactionTimeMs: 1,
          expiresAtMs: 3,
          claim: {},
          fence: "1",
          version: "1",
          commandId: "c",
          admissionProof: "a",
          principal: { subject: "fixture" },
        },
      },
      {
        ...base,
        kind: "evidence",
        payload: {
          evidence: {},
          authorityProof: "a",
          response: {},
          bodyBytes: "body ".repeat(1000),
          senderClosure: {},
          originalScope: {},
        },
      },
      {
        ...base,
        kind: "command",
        payload: {
          operation: "compareAndCommit",
          preimage: {},
          comparison: {},
          principal: {},
          claim: null,
          version: "1",
          commandId: "c",
          commandHash: fixtureHash(3),
          admissionProof: "a",
          authorityProofs: ["a"],
        },
      },
    ];
    for (const input of inputs) {
      const parsed = parseRetainedFact(input);
      let stored;
      switch (parsed.kind) {
        case "admission":
          stored = await writer.admission(parsed);
          break;
        case "authority":
          stored = await writer.authority(parsed);
          break;
        case "evidence":
          stored = await writer.evidence(parsed);
          break;
        case "command":
          stored = await writer.command(parsed);
          break;
        default:
          throw new Error("unexpected fixture kind");
      }
      expect(stored.fact).toEqual(parsed);
    }
  });
  it("length-prefixes source identities unambiguously and checks producer provenance on replay", () => {
    const base = inventoryFact();
    const left = {
      ...base,
      provenance: { ...base.provenance, sourceKey: "x:1", sourceRevision: "y" },
    };
    const right = {
      ...base,
      provenance: { ...base.provenance, sourceKey: "x", sourceRevision: "1:y" },
    };
    expect(factSourceSha256(left).equals(factSourceSha256(right))).toBe(false);
  });
  it("propagates transaction errors once and forwards SQL through caller's Prisma transaction", async () => {
    const error = new Error("transaction aborted"),
      query = vi.fn().mockRejectedValue(error);
    await expect(new Writer({ query }).inventory(inventoryFact())).rejects.toBe(
      error,
    );
    expect(query).toHaveBeenCalledTimes(1);
    const $queryRawUnsafe = vi.fn().mockResolvedValue([{ n: 1 }]);
    expect(
      await prismaRetainedFactSql({ $queryRawUnsafe }).query("SELECT $1", [1]),
    ).toEqual({ rows: [{ n: 1 }] });
    expect($queryRawUnsafe).toHaveBeenCalledExactlyOnceWith("SELECT $1", 1);
  });
});
describe("bounded retained JSON and typed capture", () => {
  it("separates 4096-byte proof references from larger source identities and output", () => {
    const base = inventoryFact("é".repeat(2048));
    const input = {
      ...base,
      provenance: {
        ...base.provenance,
        sourceKey: "x".repeat(6000),
        sourceRevision: "y".repeat(6000),
      },
    };
    expect(parseRetainedFact(input)).toEqual(input);
    for (const bad of [
      { ...input, proofId: input.proofId + "x" },
      {
        ...input,
        payload: { ...input.payload, outputProof: "x".repeat(4097) },
      },
      {
        ...input,
        provenance: { ...input.provenance, sourceKey: "x".repeat(1048577) },
      },
    ])
      expect(() => parseRetainedFact(bad)).toThrow(rejected);
    expect(outputFact().payload.outputBytes.length).toBeGreaterThan(4096);
  });
  it("preserves own constructor/prototype/__proto__ safely and detaches/freeze copies", () => {
    const input = Object.assign(
      Object.create(null),
      JSON.parse(
        '{"__proto__":{"safe":1},"constructor":2,"prototype":3,"token":4,"authorization":"Bearer documentation"}',
      ),
    );
    const captured = captureRetainedJson(input);
    expect(JSON.stringify(captured)).toContain('"__proto__":{"safe":1}');
    input.__proto__.safe = 7;
    expect(JSON.stringify(captured)).toContain('"safe":1');
    expect(Object.isFrozen(captured)).toBe(true);
  });
  it("rejects getters, proxies, toJSON, cycles, sparse/exotic objects and resource bombs without evaluation", () => {
    const invoked = vi.fn(() => {
      throw new Error("must not execute");
    });
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    let deep: unknown = 1;
    for (let i = 0; i < 50; i++) deep = { deep };
    for (const bad of [
      Object.defineProperty({}, "x", { get: invoked, enumerable: true }),
      new Proxy({}, { ownKeys: invoked }),
      { toJSON: invoked },
      cycle,
      new Array(2),
      new Date(),
      { [Symbol("x")]: 1 },
      NaN,
      Infinity,
      -0,
      9007199254740992,
      "\0",
      "\ud800",
      deep,
      new Array(100001).fill(null),
      "x".repeat(8388609),
    ])
      expect(() => captureRetainedJson(bad)).toThrow(rejected);
    expect(invoked).not.toHaveBeenCalled();
  });
  it("rejects wrong kind/payload shape before SQL", async () => {
    const query = vi.fn();
    await expect(
      new Writer({ query }).output(inventoryFact() as never),
    ).rejects.toThrow(rejected);
    expect(() =>
      parseRetainedFact({ ...inventoryFact(), kind: "unknown" }),
    ).toThrow(rejected);
    expect(() =>
      parseRetainedFact({
        ...inventoryFact(),
        payload: { ...inventoryFact().payload, extra: true },
      }),
    ).toThrow(rejected);
    expect(query).not.toHaveBeenCalled();
  });
});
