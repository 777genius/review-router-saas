import { readFileSync } from "node:fs";
import { list, hash } from "../domain/certified-fork-effect-canonical.js";
import { describe, expect, it, vi } from "vitest";
import {
  createForkReview as makeReview,
  createForkEffect as makeEffect,
  createForkRequest as makeRequest,
  assertSameForkReview as sameReview,
  assertSameForkRequest as sameRequest,
} from "../domain/certified-fork-effect-identity.js";
const rejects = (fn: () => unknown) => expect(fn).toThrow();
const h = (n: number) => n.toString(16).padStart(64, "0");
const logical = {
  workspaceId: "w",
  repositoryId: "r",
  sourceRepositoryId: "12",
  baseRepositoryId: "34",
  pullRequest: 1,
  headSha: "a".repeat(40),
  baseSha: "b".repeat(40),
  trustDomain: "fork" as const,
  generation: "0",
};
const review = makeReview(logical, h(1));
const effect = makeEffect(review, {
  stage: "provider",
  role: "review",
  slot: 1,
});
const facts = {
  contextHash: h(2),
  adapterContractHash: h(3),
  schemaHash: h(4),
  providerInstanceId: "instance",
  accountScopeHash: h(5),
  modelHash: h(6),
  settingsHash: h(7),
  trustedInstructionsHash: h(8),
  effectiveInputHash: h(9),
  toolsOutputSchemaHash: h(10),
  executionPolicyHash: h(11),
};
const request = makeRequest(review, effect, facts);
describe("certified fork effect identity", () => {
  it("deduplicates ingress without dispatch/run identifiers and pins binding separately", () => {
    const duplicate = makeReview({ ...logical }, h(1));
    expect(sameReview(review, duplicate)).toBe(review);
    rejects(() => sameReview(review, makeReview(logical, h(22))));
    rejects(() =>
      makeReview({ ...logical, dispatchId: "run" } as typeof logical, h(1)),
    );
    expect(
      makeReview({ ...logical, workspaceId: "other" }, h(1)).logicalKey,
    ).not.toBe(review.logicalKey);
  });
  it("commits every effective provider field and rejects request mutation", () => {
    expect(
      sameRequest(request, makeRequest(review, effect, { ...facts })),
    ).toBe(request);
    for (const key of Object.keys(facts)) {
      const changed = {
        ...facts,
        [key]: key === "providerInstanceId" ? "different" : h(99),
      };
      rejects(() => sameRequest(request, makeRequest(review, effect, changed)));
    }
    rejects(() =>
      makeEffect(review, { stage: "provider", role: "review", slot: 2 }),
    );
    rejects(() =>
      makeEffect(review, {
        stage: "provider",
        role: "review",
        slot: 1,
        retry: 2,
      } as Parameters<typeof makeEffect>[1]),
    );
  });
  it("uses deterministic ASCII key ordering and detached deep freezing", () => {
    const reversed = Object.fromEntries(
      Object.entries(facts).reverse(),
    ) as typeof facts;
    expect(makeRequest(review, effect, reversed).requestHash).toBe(
      request.requestHash,
    );
    reversed.settingsHash = h(90);
    expect(request.facts).toEqual(facts);
  });
  it.each([
    undefined,
    NaN,
    Infinity,
    -1,
    0,
    1.1,
    Number.MAX_SAFE_INTEGER + 1,
    "1",
    { valueOf: () => 1 },
  ])("rejects invalid PR without coercion: %s", (pullRequest) => {
    rejects(() =>
      makeReview({ ...logical, pullRequest } as typeof logical, h(1)),
    );
  });
  it.each(["00", "01", "-1", "1.0", "1000000000000000000", 1])(
    "rejects noncanonical counters: %s",
    (generation) => {
      rejects(() =>
        makeReview({ ...logical, generation } as typeof logical, h(1)),
      );
    },
  );
  it("rejects raw metadata, accessors, proxies and custom prototypes without invoking them", () => {
    for (const key of [
      "patch",
      "prompt",
      "prose",
      "credential",
      "bearerToken",
      "rawError",
    ]) {
      rejects(() => makeRequest(review, effect, { ...facts, [key]: "secret" }));
    }
    let calls = 0;
    const getter = {
      ...facts,
      get settingsHash() {
        calls++;
        return h(7);
      },
    };
    const proxy = new Proxy(facts, {
      ownKeys() {
        calls++;
        return [];
      },
    });
    for (const bad of [
      getter,
      proxy,
      Object.assign(Object.create(null), facts),
      Object.assign(Object.create({ inherited: true }), facts),
      { ...facts, settingsHash: undefined },
      { ...facts, settingsHash: "A".repeat(64) },
    ])
      rejects(() => makeRequest(review, effect, bad));
    expect(calls).toBe(0);
  });
});

it("rejects oversized arrays before descriptor materialization without callbacks", () => {
  let calls = 0;
  const oversized = new Array(257).fill(h(1));
  Object.defineProperty(oversized, "0", {
    get() {
      calls++;
      return h(1);
    },
  });
  const descriptors = vi.spyOn(Object, "getOwnPropertyDescriptors");
  try {
    rejects(() => list(hash)(oversized));
    rejects(() =>
      list(hash)(
        new Proxy(oversized, {
          getPrototypeOf() {
            calls++;
            return Array.prototype;
          },
          get() {
            calls++;
            return 0;
          },
          ownKeys() {
            calls++;
            return [];
          },
        }),
      ),
    );
    expect(
      descriptors.mock.calls.filter(([value]) => Array.isArray(value)),
    ).toHaveLength(0);
    expect(calls).toBe(0);
  } finally {
    descriptors.mockRestore();
  }
});
it("keeps trust injection and provenance constructors out of package exports", () => {
  const root = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
  for (const internal of [
    "createForkStateVerifier",
    "createForkDurabilityVerifier",
    "createForkAuthority",
    "createForkEvidence",
    "certified-fork-effect-canonical",
  ])
    expect(root).not.toContain(internal);
  expect(root).not.toMatch(/export\s+\*[^;]*certified-fork-effect/u);
});

const resolvedStatuses = [
  "completed",
  "stopped_no_effect",
  "stopped_with_effect",
  "output_unavailable",
] as const;
const predecessor = {
  review,
  outcomeHash: h(30),
  status: "completed" as const,
};
const admission = { admissionHash: h(31) };
const generationOne = { ...logical, generation: "1" };
const advance = (prior: unknown = predecessor, admitted = admission) =>
  makeReview(generationOne, h(1), prior as typeof predecessor, admitted);
it.each(resolvedStatuses)(
  "admits and deduplicates generation 1: %s",
  (status) => {
    const prior = { ...predecessor, status };
    const first = advance(prior);
    expect(first.facts.generation).toBe("1");
    expect(first.logicalKey).not.toBe(review.logicalKey);
    expect(first.familyKey).toBe(review.familyKey);
    expect(first.bindingHash).toBe(review.bindingHash);
    expect(first.admissionHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(sameReview(first, advance({ ...prior }))).toBe(first);
    const slot = { stage: "provider", role: "review", slot: 1 } as const;
    expect(makeEffect(first, slot).effectKey).toBe(
      makeEffect(advance({ ...prior }), slot).effectKey,
    );
    expect(makeEffect(first, slot).effectKey).not.toBe(effect.effectKey);
    rejects(() => sameReview(first, advance({ ...prior, outcomeHash: h(32) })));
    rejects(() => sameReview(first, advance(prior, { admissionHash: h(32) })));
    for (const other of resolvedStatuses.filter((value) => value !== status))
      rejects(() => sameReview(first, advance({ ...prior, status: other })));
    const second = makeReview(
      { ...logical, generation: "2" },
      h(1),
      { ...prior, review: first },
      admission,
    );
    expect(second.facts.generation).toBe("2");
    const substituted = advance(prior, { admissionHash: h(33) });
    rejects(() =>
      sameReview(
        second,
        makeReview(
          { ...logical, generation: "2" },
          h(1),
          { ...prior, review: substituted },
          admission,
        ),
      ),
    );
  },
);
it("rejects missing, unresolved, malformed and substituted predecessors", () => {
  for (const bad of [
    null,
    {},
    { ...predecessor, status: "unresolved" },
    { ...predecessor, status: "unknown" },
    { ...predecessor, status: undefined },
    { ...predecessor, outcomeHash: "A".repeat(64) },
    { ...predecessor, outcomeHash: undefined },
    { ...predecessor, extra: "untrusted" },
    { ...predecessor, review: { ...review } },
    { ...predecessor, review: JSON.parse(JSON.stringify(review)) },
    { ...predecessor, review: { ...review, logicalKey: h(99) } },
    {
      ...predecessor,
      review: makeReview({ ...logical, headSha: "c".repeat(40) }, h(1)),
    },
    { ...predecessor, review: makeReview(logical, h(99)) },
    { ...predecessor, review: advance() },
  ])
    rejects(() => advance(bad));
  rejects(() => makeReview(generationOne, h(1), predecessor));
  rejects(() =>
    makeReview(generationOne, h(1), predecessor, { admissionHash: "bad" }),
  );
  rejects(() => makeReview(logical, h(1), predecessor, admission));
  for (const generation of ["2", "3"])
    rejects(() =>
      makeReview({ ...logical, generation }, h(1), predecessor, admission),
    );
  for (const clone of [{ ...review }, JSON.parse(JSON.stringify(review))]) {
    rejects(() => sameReview(review, clone));
    rejects(() => makeEffect(clone, effect.slot));
    rejects(() => makeRequest(clone, effect, facts));
  }
});
it("rejects hostile predecessor metadata without invoking callbacks", () => {
  let calls = 0;
  const trap = () => {
    calls++;
    throw new Error("must not execute");
  };
  for (const bad of [
    {
      ...predecessor,
      get review() {
        return trap();
      },
    },
    {
      ...predecessor,
      get status() {
        return trap();
      },
    },
    {
      ...predecessor,
      get outcomeHash() {
        return trap();
      },
    },
    new Proxy(predecessor, { get: trap, ownKeys: trap, getPrototypeOf: trap }),
    { ...predecessor, review: new Proxy(review, { get: trap, ownKeys: trap }) },
    Object.assign(Object.create(null), predecessor),
    Object.assign(Object.create({ inherited: true }), predecessor),
    { ...predecessor, [Symbol("extra")]: true },
    { ...predecessor, outcomeHash: { toString: trap } },
  ])
    rejects(() => advance(bad));
  expect(calls).toBe(0);
});
