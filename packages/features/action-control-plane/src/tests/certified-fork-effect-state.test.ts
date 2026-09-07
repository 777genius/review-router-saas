import {
  assertForkStateExtension,
  createForkStateVerifier,
} from "../domain/certified-fork-effect-state.js";
import { describe, expect, it, vi } from "vitest";
import {
  fingerprint,
  list,
  record,
  hash,
} from "../domain/certified-fork-effect-canonical.js";
import {
  createForkReview as makeReview,
  createForkEffect as makeEffect,
  createForkRequest as makeRequest,
} from "../index.js";
import {
  type ForkAuthority,
  forkAuthorityHash,
  prepareForkEffect as prepare,
  transitionForkEffect as transition,
  type ForkEffectState,
  type ForkEvidence,
} from "../index.js";
// Simulated authenticated adapter: only issued opaque handles resolve to facts.
const proofs = new WeakMap<object, ForkAuthority | ForkEvidence>();
const verifier = createForkStateVerifier({
  authority: (proof: object) => {
    if (!proofs.has(proof)) throw new Error("unverified");
    return proofs.get(proof) as ForkAuthority;
  },
  evidence: (proof: object) => {
    if (!proofs.has(proof)) throw new Error("unverified");
    return proofs.get(proof) as ForkEvidence;
  },
});
function issue<T extends ForkAuthority | ForkEvidence>(facts: T) {
  const proof = {};
  proofs.set(proof, facts);
  return proof;
}
const makeAuthority = (facts: ForkAuthority) =>
  verifier.authority(issue(facts));
const makeEvidence = (facts: ForkEvidence) => verifier.evidence(issue(facts));
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
const authority = (
  revision = "0",
  epoch = "1",
  mode: "execute" | "reconcile" = "execute",
) =>
  makeAuthority({
    logicalKey: review.logicalKey,
    reviewHash: fingerprint("fork-admission", review),
    epoch,
    revision,
    mode,
    claimHash: h(12),
    ownerHash: h(13),
    validUntilHash: h(14),
  });
const prepared = () => prepare(request, authority());
const begin = (state: ForkEffectState) =>
  transition(state, authority(state.revision), {
    kind: "begin",
    inventory: null,
    states: [],
  });
function evidence(
  state: ForkEffectState,
  changes: Partial<ForkEvidence> = {},
  epoch = "1",
  mode: "execute" | "reconcile" = "execute",
) {
  const a = authority(state.revision, epoch, mode);
  const e = makeEvidence({
    logicalKey: review.logicalKey,
    effectKey: state.request.effect.effectKey,
    requestHash: state.request.requestHash,
    attempt: state.attempts.at(-1)!.ordinal,
    originEpoch: state.attempts.at(-1)!.originEpoch,
    remoteScopeHash: state.request.remoteScopeHash,
    authorityHash: forkAuthorityHash(a),
    kind: "success",
    source: "provider_receipt",
    verifierHash: h(15),
    evidenceHash: h(16),
    externalRefHash: h(17),
    resultHash: h(18),
    disposition: "authenticated_success",
    senderClosure: "closed",
    reason: "confirmed",
    ...changes,
  });
  return { a, e };
}
function settle(
  state: ForkEffectState,
  changes: Partial<ForkEvidence> = {},
  epoch = "1",
  mode: "execute" | "reconcile" = "execute",
) {
  const { a, e } = evidence(state, changes, epoch, mode);
  return transition(state, a, { kind: "evidence", evidence: e });
}
const noEffect: Partial<ForkEvidence> = {
  kind: "no_effect",
  source: "dispatch_journal",
  disposition: "definitive_no_effect",
  reason: "never_dispatched",
  externalRefHash: null,
  resultHash: null,
};
const uncertain: Partial<ForkEvidence> = {
  kind: "unknown",
  source: "observation",
  disposition: "indeterminate",
  reason: "timeout",
  externalRefHash: null,
  resultHash: null,
  senderClosure: "open",
};
const stop = (s: ForkEffectState) =>
  transition(s, authority(s.revision, s.authority.epoch, s.authority.mode), {
    kind: "stop",
    reason: "cancelled",
  });
it.each([false, true])(
  "saturation fences late contradiction (prepared retry: %s)",
  (retryPrepared) => {
    let state = settle(prepared(), noEffect);
    for (let i = 1; i < 255; i++)
      state = settle(
        state,
        { ...noEffect, evidenceHash: h(i + 100) },
        "1",
        "reconcile",
      );
    expect(state.integrityHold).toBe(false);
    if (retryPrepared)
      state = transition(state, authority(state.revision), { kind: "retry" });
    const before = state;
    // Both a contradiction in the final slot and benign saturation must fence sends.
    for (const terminal of [noEffect, {}]) {
      const full = settle(
        before,
        { ...terminal, attempt: "0", originEpoch: "1", evidenceHash: h(900) },
        "1",
        "reconcile",
      );
      expect(full.integrityHold).toBe(true);
      expect(full.attempts[0]!.evidence).toHaveLength(256);
      expect(
        full.attempts[0]!.evidence.some((e) => e.evidenceHash === h(900)),
      ).toBe(true);
      assertForkStateExtension(before, full);
      expect(
        settle(
          before,
          { ...terminal, attempt: "0", originEpoch: "1", evidenceHash: h(900) },
          "1",
          "reconcile",
        ),
      ).toEqual(full);
      // The 257th authenticated success is explicitly rejected; no executable
      // prior ledger is left behind, including a previously prepared retry.
      rejects(() =>
        settle(full, { attempt: "0", originEpoch: "1" }, "1", "reconcile"),
      );
      const replay = full.attempts[0]!.evidence.find(
        (e) => e.evidenceHash === h(900),
      )!;
      expect(
        transition(full, full.authority, {
          kind: "evidence",
          evidence: replay,
        }),
      ).toBe(full);
      const sealed = transition(
        full,
        authority(full.revision, "1", "reconcile"),
        { kind: "seal" },
      );
      assertForkStateExtension(full, sealed);
      for (const held of [full, sealed]) {
        expect(held.integrityHold).toBe(true);
        for (const command of [
          { kind: "retry" },
          { kind: "begin", inventory: null, states: [] },
        ] as const)
          rejects(() => transition(held, authority(held.revision), command));
      }
    }
  },
  60_000, // Replay genuine capabilities through all 256 ledger positions.
);

it("rejects hostile own keys before descriptor materialization or callbacks", () => {
  const callbacks = vi.fn(() => {
    throw new Error("callback invoked");
  });
  const parseRecord = record({ value: hash });
  const parseList = list(hash);
  const array = [h(1)];
  const object = { value: h(1) };
  for (let i = 0; i < 10_000; i++)
    for (const target of [array, object])
      Object.defineProperty(target, `extra${i}`, { get: callbacks });
  const descriptors = vi.spyOn(Object, "getOwnPropertyDescriptors");
  const rejectsBeforeDescriptors = (run: () => unknown, count = 0) => {
    descriptors.mockClear();
    let error: unknown;
    try {
      run();
    } catch (caught) {
      error = caught;
    }
    // Capture before assertions: Vitest also uses the descriptor builtin.
    const calls = descriptors.mock.calls.length;
    expect(error).toBeInstanceOf(Error);
    expect(calls).toBe(count);
  };
  try {
    for (const [parse, target] of [
      [parseRecord, object],
      [parseList, array],
    ] as const) {
      rejectsBeforeDescriptors(() => parse(target));
      rejectsBeforeDescriptors(() =>
        parse(
          new Proxy(target, {
            ownKeys: callbacks,
            getOwnPropertyDescriptor: callbacks,
            getPrototypeOf: callbacks,
            get: callbacks,
          }),
        ),
      );
    }
    // Same key count but wrong membership must also fail before descriptors.
    rejectsBeforeDescriptors(() => parseRecord({ other: h(1) }));
    const sparse = new Array<string>(1);
    Object.defineProperty(sparse, "extra", { get: callbacks });
    rejectsBeforeDescriptors(() => parseList(sparse));
    // Only the fixed fingerprint envelope was materialized.
    rejectsBeforeDescriptors(() => fingerprint("hostile", object), 1);
    expect(callbacks).not.toHaveBeenCalled();
  } finally {
    descriptors.mockRestore();
  }
  const accessor = Object.defineProperty({}, "value", { get: callbacks });
  rejects(() => parseRecord(accessor));
  expect(callbacks).not.toHaveBeenCalled();
  expect(parseList(Array.from({ length: 256 }, () => h(1)))).toHaveLength(256);
  expect(parseRecord({ value: h(1) })).toEqual({ value: h(1) });
});

describe("certified fork effect state", () => {
  it("records success and identical evidence replay, never retries success", () => {
    const running = begin(prepared());
    const { a, e } = evidence(running);
    const success = transition(running, a, { kind: "evidence", evidence: e });
    expect(success.attempts[0]!.status).toBe("succeeded");
    expect(transition(success, a, { kind: "evidence", evidence: e })).toBe(
      success,
    );
    rejects(() =>
      transition(success, authority(success.revision), { kind: "retry" }),
    );
  });
  it("dropped response and empty GitHub observation remain unknown without resend", () => {
    for (const reason of ["timeout", "absent", "listing_empty"] as const) {
      const unknown = settle(begin(prepared()), { ...uncertain, reason });
      expect(unknown.attempts[0]!.status).toBe("unknown");
      rejects(() =>
        transition(unknown, authority(unknown.revision), { kind: "retry" }),
      );
      rejects(() => settle(unknown));
      const still = settle(
        unknown,
        { ...uncertain, reason, evidenceHash: h(22) },
        "2",
        "reconcile",
      );
      expect(still.attempts[0]!.status).toBe("unknown");
    }
  });
  it("reconciles under new authority without changing origin and preserves stops", () => {
    const unknown = stop(settle(begin(prepared()), uncertain));
    const reconciled = settle(unknown, {}, "2", "reconcile");
    expect(reconciled.attempts[0]!.originEpoch).toBe("1");
    expect(reconciled.authority.epoch).toBe("2");
    expect(reconciled.stops).toEqual(["cancelled"]);
    expect(reconciled.attempts[0]!.evidence).toHaveLength(2);
    const negative = settle(unknown, noEffect, "2", "reconcile");
    rejects(() =>
      transition(negative, authority(negative.revision, "3"), {
        kind: "retry",
      }),
    );
  });
  it("requires definitive no-effect AND sender closure and retains proof on consecutive retry", () => {
    const unknown = settle(begin(prepared()), {
      ...noEffect,
      senderClosure: "open",
    });
    expect(unknown.attempts[0]!.status).toBe("unknown");
    const negative = settle(prepared(), noEffect);
    const retry = transition(negative, authority(negative.revision, "2"), {
      kind: "retry",
    });
    expect(retry.attempts.map((a) => a.ordinal)).toEqual(["0", "1"]);
    expect(retry.attempts[0]).toEqual(negative.attempts[0]);
    expect(retry.attempts[1]!.originEpoch).toBe("2");
    rejects(() =>
      transition(negative, authority(negative.revision, "2", "reconcile"), {
        kind: "retry",
      }),
    );
  });
  it("fences stale revisions, claims and epochs, including prepared execution", () => {
    const p = prepared();
    rejects(() => transition(p, authority(), { kind: "seal" }));
    rejects(() => transition(p, authority(p.revision, "0"), { kind: "seal" }));
    rejects(() =>
      transition(
        p,
        makeAuthority({ ...authority(p.revision), claimHash: h(90) }),
        { kind: "seal" },
      ),
    );
    rejects(() =>
      transition(p, authority(p.revision, "2"), {
        kind: "begin",
        inventory: null,
        states: [],
      }),
    );
    rejects(() =>
      transition(p, authority(p.revision, "1", "reconcile"), {
        kind: "begin",
        inventory: null,
        states: [],
      }),
    );
    rejects(() => settle(p));
  });
  it("rejects every mismatched evidence scope and raw/boolean proof", () => {
    const running = begin(prepared());
    for (const key of [
      "logicalKey",
      "effectKey",
      "requestHash",
      "remoteScopeHash",
      "authorityHash",
    ])
      rejects(() => settle(running, { [key]: h(99) }));
    for (const key of ["attempt", "originEpoch"])
      rejects(() => settle(running, { [key]: "9" }));
    const { e } = evidence(running);
    rejects(() => makeEvidence({ ...e, authenticated: true } as ForkEvidence));
    rejects(() =>
      makeEvidence({ ...e, rawError: "provider message" } as ForkEvidence),
    );
    expect(settle(running, { source: "observation" }).attempts[0]!.status).toBe(
      "unknown",
    );
  });
  it("holds conflicting and duplicate remote effects permanently", () => {
    const success = settle(begin(prepared()));
    const conflict = settle(success, {
      evidenceHash: h(23),
      externalRefHash: h(24),
    });
    expect(conflict.integrityHold).toBe(true);
    expect(conflict.attempts[0]!.status).toBe("unknown");
    const negative = settle(conflict, noEffect, "2", "reconcile");
    expect(negative.integrityHold).toBe(true);
    rejects(() =>
      transition(negative, authority(negative.revision, "3"), {
        kind: "retry",
      }),
    );
  });
  it("does not interpret changed lease commitments as no-effect; seals are monotone", () => {
    const running = begin(prepared());
    const sealed = transition(
      running,
      makeAuthority({ ...authority(running.revision), validUntilHash: h(30) }),
      { kind: "seal" },
    );
    expect(sealed.attempts[0]!.status).toBe("in_flight");
    const negative = settle(sealed, noEffect, "2", "reconcile");
    expect(negative.sealed).toBe(true);
    rejects(() =>
      transition(negative, authority(negative.revision, "3"), {
        kind: "retry",
      }),
    );
    expect(Object.isFrozen(negative.attempts[0]!.evidence[0])).toBe(true);
    rejects(() =>
      transition({ ...negative }, authority(negative.revision), {
        kind: "seal",
      }),
    );
  });
});

it("retains late contradiction on its original attempt and fences prepared retries", () => {
  const negative = settle(begin(prepared()), noEffect);
  for (const state of [
    negative,
    transition(negative, authority(negative.revision, "2"), { kind: "retry" }),
  ]) {
    const held = settle(
      state,
      { attempt: "0", originEpoch: "1" },
      "3",
      "reconcile",
    );
    expect(held.integrityHold).toBe(true);
    expect(held.attempts[0]!.evidence).toHaveLength(2);
    expect(held.attempts[0]!.originEpoch).toBe("1");
    assertForkStateExtension(state, held);
    for (const command of [
      { kind: "retry" },
      { kind: "begin", inventory: null, states: [] },
    ] as const)
      rejects(() => transition(held, authority(held.revision, "3"), command));
  }
});
it("rejects lower-epoch and same-epoch different-owner state extensions", () => {
  const base = settle(begin(prepared()), uncertain);
  const high = transition(base, authority(base.revision, "10", "reconcile"), {
    kind: "seal",
  });
  const low = settle(
    transition(base, authority(base.revision, "2", "reconcile"), {
      kind: "seal",
    }),
    noEffect,
    "2",
    "reconcile",
  );
  rejects(() => assertForkStateExtension(high, low));
  const other = transition(
    base,
    makeAuthority({
      ...authority(base.revision, "10", "reconcile"),
      ownerHash: h(90),
    }),
    { kind: "seal" },
  );
  rejects(() => assertForkStateExtension(high, other));
});

it("rejects fabricated retry capabilities and requires trusted ledger replay", () => {
  const unknown = settle(begin(prepared()), uncertain);
  const { a, e } = evidence(unknown, noEffect, "2", "reconcile");
  rejects(() => verifier.authority({ ...a }));
  rejects(() => verifier.evidence({ ...e }));
  rejects(() =>
    transition(unknown, { ...a }, { kind: "evidence", evidence: e }),
  );
  for (const forged of [{ ...e }, JSON.parse(JSON.stringify(e))])
    rejects(() =>
      transition(unknown, a, { kind: "evidence", evidence: forged }),
    );
  const snapshot = JSON.parse(JSON.stringify(unknown));
  rejects(() => transition(snapshot, a, { kind: "evidence", evidence: e }));
  // Trusted replay restores provenance without treating the serialized ledger as authority.
  const replayed = settle(begin(prepared()), uncertain);
  expect(replayed).toEqual(snapshot);
  const negative = transition(replayed, a, { kind: "evidence", evidence: e });
  const retry = transition(negative, authority(negative.revision, "3"), {
    kind: "retry",
  });
  expect(
    transition(retry, authority(retry.revision, "3"), {
      kind: "begin",
      inventory: null,
      states: [],
    }).attempts.at(-1)!.status,
  ).toBe("in_flight");
});

it("rejects legacy authority proofs without the complete review commitment", () => {
  const { reviewHash: omitted, ...legacy } = authority();
  expect(omitted).toBe(fingerprint("fork-admission", review));
  rejects(() => makeAuthority(legacy as ForkAuthority));
  rejects(() => prepare(request, { ...authority(), reviewHash: h(99) }));
});
