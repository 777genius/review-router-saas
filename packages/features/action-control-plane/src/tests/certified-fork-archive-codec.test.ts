import { describe, expect, it } from "vitest";
import { authentic } from "../domain/certified-fork-effect-canonical.js";
import {
  archiveCounter,
  archiveTime,
  archiveJson,
  archiveSnapshot,
  archiveState,
  archiveArray,
  archiveComparison,
} from "../infrastructure/prisma/certified-fork-archive-codec.js";
import {
  archiveCommand,
  archiveReview,
  fixtureStates,
  fixtureHistory,
} from "./support/certified-fork-archive-fixture.js";

describe("certified fork archive data codec", () => {
  it("keeps 18-digit counters exact and checks timestamps before Number conversion", () => {
    expect(archiveCounter(999999999999999999n)).toBe("999999999999999999");
    expect(archiveCounter("9007199254740993")).toBe("9007199254740993");
    for (const invalid of [
      Number("9007199254740993"),
      1,
      "01",
      "-1",
      "1e2",
      "1000000000000000000",
    ])
      expect(() => archiveCounter(invalid)).toThrow();
    expect(archiveTime("9007199254740991")).toBe(Number.MAX_SAFE_INTEGER);
    for (const invalid of ["9007199254740992", "0", "01", -1, 1.5, Infinity])
      expect(() => archiveTime(invalid)).toThrow();
  });
  it("rejects lossy JSON rather than silently coercing it", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const value of [
      1n,
      undefined,
      NaN,
      Infinity,
      -0,
      9007199254740992,
      "\0",
      "\ud800",
      "\udc00",
      new Date(),
      cyclic,
      {
        get hidden() {
          throw new Error("accessor ran");
        },
      },
      new Proxy({}, {}),
      Array(2),
      { [Symbol()]: 1 },
    ])
      expect(() => archiveJson(value)).toThrow();
    expect(archiveJson({ z: "😀", a: "9007199254740993" })).toBe(
      '{"a":"9007199254740993","z":"😀"}',
    );
  });
  it("deeply copies/freezes snapshot data and never mints capabilities", () => {
    const built = archiveCommand("acquireClaim", "codec").build(null, 100);
    const parsed = archiveSnapshot(built.snapshot);
    expect(parsed).toEqual(built.snapshot);
    expect(parsed).not.toBe(built.snapshot);
    expect(Object.isFrozen(parsed.seed.facts)).toBe(true);
    expect(() =>
      Object.assign(parsed.claim!, { ownerHash: "changed" }),
    ).toThrow();
    const data = archiveState({
      review: archiveReview,
      states: fixtureStates(),
      inventory: null,
      outcome: null,
    });
    expect(Object.isFrozen(data.states[0]!.attempts[0]!.evidence)).toBe(true);
    expect(() => authentic("review", data.review)).toThrow();
    expect(() => authentic("state", data.states[0]!)).toThrow();
  });
  it("validates exact nested state fields and discriminants", () => {
    const state = {
      review: archiveReview,
      states: fixtureStates(),
      inventory: null,
      outcome: null,
    };
    for (const edit of [
      (v: typeof state) =>
        Object.assign(v.states[0]!.request.facts, { extra: true }),
      (v: typeof state) =>
        Object.assign(v.states[0]!.attempts[0]!, { status: "success" }),
      (v: typeof state) =>
        Object.assign(v.states[1]!, { revision: Number("9007199254740993") }),
      (v: typeof state) => Object.assign(v.review.facts, { generation: "01" }),
    ]) {
      const bad = structuredClone(state);
      edit(bad);
      expect(() => archiveState(bad)).toThrow();
    }
    expect(() => archiveComparison({ reviewHash: "bad" })).toThrow();
  });
  it("does not add a total durable history or attempt limit", () => {
    expect(archiveArray(archiveCounter)(Array(100_001).fill("1"))).toHaveLength(
      100_001,
    );
    const states = fixtureStates();
    const first = states[0]!;
    const data = archiveState({
      review: archiveReview,
      states: [{ ...first, attempts: Array(300).fill(first.attempts[0]) }],
      inventory: null,
      outcome: null,
    });
    expect(data.states[0]!.attempts).toHaveLength(300);
  });
});

describe("complete domain checkpoint codec", () => {
  it("round-trips nonempty history, evidence, inventory, output, durability and outcome without minting trust", () => {
    const history = fixtureHistory();
    expect(history.state.outcome!.status).toBe("completed");
    expect(history.events.map((e) => e.input.kind)).toEqual([
      "prepare",
      "begin",
      "evidence",
      "inventory",
      "seal",
      "outcome",
    ]);
    const parsed = archiveState(JSON.parse(archiveJson(history.state)));
    expect(parsed).toEqual(history.state);
    expect(parsed.inventory!.output).toEqual(history.state.outcome!.output);
    expect(parsed.states[0]!.attempts[0]!.evidence).toHaveLength(1);
    for (const [kind, value] of [
      ["inventory", parsed.inventory],
      ["outcome", parsed.outcome],
      ["output", parsed.inventory!.output],
      ["durability", parsed.inventory!.durability],
    ] as const)
      expect(() => authentic(kind, value!)).toThrow();
    for (const edit of [
      (s: typeof parsed) =>
        Object.assign(s.inventory!.output!, { canonicalOutputHash: "bad" }),
      (s: typeof parsed) =>
        Object.assign(s.inventory!.durability!, { disposition: "available" }),
      (s: typeof parsed) =>
        Object.assign(s.outcome!.states[0]!.attempts[0]!.evidence[0]!, {
          senderClosure: "invalid",
        }),
      (s: typeof parsed) =>
        Object.assign(s.outcome!.inventory.entries[0]!.request.facts, {
          extra: true,
        }),
    ]) {
      const bad = structuredClone(parsed);
      edit(bad);
      expect(() => archiveState(bad)).toThrow();
    }
  });
});
