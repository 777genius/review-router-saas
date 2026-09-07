import { fingerprint } from "../domain/certified-fork-effect-canonical.js";
import { createForkStateVerifier } from "../domain/certified-fork-effect-state.js";
import { createForkDurabilityVerifier } from "../domain/certified-fork-effect-outcome.js";
import { describe, expect, it } from "vitest";
import {
  createForkReview as makeStructuralReview,
  assertSameForkReview,
  createForkEffect as makeEffect,
  createForkRequest as makeRequest,
  assertSameForkRequest as sameRequest,
} from "../index.js";
import {
  type ForkAuthority,
  forkAuthorityHash,
  prepareForkEffect as prepare,
  transitionForkEffect as transition,
  type ForkEffectState,
  type ForkEvidence,
} from "../index.js";
import {
  createForkReviewFromOutcome as makeReview,
  type ForkOutcome,
  type ForkDurability,
  createForkOutput as makeOutput,
  freezeForkInventory as freezeInventory,
  createForkOutcome as makeOutcome,
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
function settle(
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
const seal = (s: ForkEffectState) =>
  transition(s, authority(s.revision, s.authority.epoch, s.authority.mode), {
    kind: "seal",
  });
const stop = (s: ForkEffectState) =>
  transition(s, authority(s.revision, s.authority.epoch, s.authority.mode), {
    kind: "stop",
    reason: "cancelled",
  });
const inventory = () =>
  freezeInventory(
    review,
    [{ request, dependencies: [] }],
    [effect.effectKey],
    null,
    null,
  );
function publication() {
  const success = settle(begin(prepared()));
  const output = makeOutput(success, {
    bindingHash: h(1),
    contextHash: h(2),
    canonicalOutputHash: h(18),
  });
  const pub = makeEffect(review, {
    stage: "publication",
    role: "inline",
    slot: 1,
  });
  const pubFacts = {
    contextHash: h(2),
    adapterContractHash: h(3),
    schemaHash: h(4),
    outputCommitmentHash: output.outputHash,
    frozenPlanHash: h(30),
    appId: "app",
    installationId: "installation",
    baseRepositoryId: "34",
    pullRequest: 1,
    commitSha: logical.headSha,
    objectTargetHash: h(31),
    renderPolicyHash: h(32),
    payloadHashes: [h(33), h(34)],
    markerHash: h(35),
  };
  const pubRequest = makeRequest(review, pub, pubFacts);
  const entries = [
    { request, dependencies: [] },
    { request: pubRequest, dependencies: [effect.effectKey] },
  ];
  const keys = entries.map((e) => e.request.effect.effectKey);
  const receipts = new WeakMap<object, ForkDurability>();
  const proof = {};
  receipts.set(proof, {
    disposition: "durably_committed" as const,
    outputCommitmentHash: output.outputHash,
    commitReceiptHash: h(36),
  });
  const receipt = createForkDurabilityVerifier((p: object) => {
    const facts = receipts.get(p);
    if (!facts) throw new Error("unverified");
    return facts;
  })(proof);
  const inventory = freezeInventory(review, entries, keys, output, receipt);
  const p = prepare(pubRequest, authority());
  const running = transition(p, authority(p.revision), {
    kind: "begin",
    inventory,
    states: [success, p],
  });
  return {
    success,
    output,
    pub,
    pubFacts,
    pubRequest,
    entries,
    keys,
    receipt,
    inventory,
    p,
    running,
  };
}
describe("certified fork effect outcomes", () => {
  it.each([h(18), h(91)])(
    "rejects publication from another genuine provider success (result %s)",
    (resultHash) => {
      const f = publication();
      const branch = settle(begin(prepared()), {
        evidenceHash: h(90),
        externalRefHash: h(92),
        resultHash,
      });
      expect(branch.request).toEqual(f.success.request);
      expect(branch.attempts.at(-1)!.status).toBe("succeeded");
      expect(branch.integrityHold).toBe(false);
      rejects(() =>
        transition(f.p, authority(f.p.revision), {
          kind: "begin",
          inventory: f.inventory,
          states: [branch, f.p],
        }),
      );
      expect(f.running.attempts.at(-1)!.status).toBe("in_flight");
    },
  );
  it("binds verified provider output to exact request, binding and context", () => {
    const success = settle(begin(prepared()));
    const outputFacts = {
      bindingHash: h(1),
      contextHash: h(2),
      canonicalOutputHash: h(18),
    };
    for (const changed of [
      { contextHash: h(99) },
      { bindingHash: h(99) },
      { canonicalOutputHash: h(99) },
    ])
      rejects(() => makeOutput(success, { ...outputFacts, ...changed }));
    rejects(() => makeOutput(begin(prepared()), outputFacts));
  });
  it("requires complete frozen inventory and durable commitment before publication", () => {
    const f = publication();
    const { entries, keys, output, receipt } = f;
    rejects(() =>
      freezeInventory(review, entries.slice(0, 1), keys, output, receipt),
    );
    rejects(() => freezeInventory(review, f.entries, f.keys, f.output, null));
    rejects(() =>
      freezeInventory(review, f.entries, f.keys, f.output, {
        ...f.receipt,
        outputCommitmentHash: h(99),
      }),
    );
    for (const [inventory, states] of [
      [null, [f.success, f.p]],
      [f.inventory, []],
      [f.inventory, [prepared(), f.p]],
      [f.inventory, [stop(f.success), f.p]],
    ] as const)
      rejects(() =>
        transition(f.p, authority(f.p.revision), {
          kind: "begin",
          inventory,
          states,
        }),
      );
    expect(Object.isFrozen(f.inventory.entries[0]!.dependencies)).toBe(true);
  });
  it("rejects duplicate/missing/cyclic dependencies and sparse or accessor arrays", () => {
    const f = publication();
    for (const entries of [
      [...f.entries, f.entries[0]!],
      [{ request, dependencies: [f.pub.effectKey] }, f.entries[1]!],
      [f.entries[0]!, { request: f.pubRequest, dependencies: [h(99)] }],
      [
        f.entries[0]!,
        {
          request: f.pubRequest,
          dependencies: [effect.effectKey, effect.effectKey],
        },
      ],
    ])
      rejects(() =>
        freezeInventory(review, entries, f.keys, f.output, f.receipt),
      );
    const sparse = new Array<string>(2);
    sparse[0] = h(33);
    const accessor = [h(33)];
    Object.defineProperty(accessor, "0", {
      get() {
        throw new Error("getter invoked");
      },
    });
    for (const payloadHashes of [sparse, accessor, new Proxy([h(33)], {})])
      rejects(() =>
        makeRequest(review, f.pub, { ...f.pubFacts, payloadHashes }),
      );
  });
  it("commits payload order, target/inline position, policy and remote account", () => {
    const f = publication();
    for (const change of [
      { objectTargetHash: h(99) },
      { installationId: "other" },
      { appId: "other" },
      { contextHash: h(99) },
      { renderPolicyHash: h(99) },
      { payloadHashes: [...f.pubFacts.payloadHashes].reverse() },
      { markerHash: h(99) },
      { frozenPlanHash: h(99) },
    ])
      rejects(() =>
        sameRequest(
          f.pubRequest,
          makeRequest(review, f.pub, { ...f.pubFacts, ...change }),
        ),
      );
    rejects(() =>
      makeRequest(review, f.pub, { ...f.pubFacts, pullRequest: 2 }),
    );
    rejects(() =>
      makeRequest(review, f.pub, {
        ...f.pubFacts,
        body: "raw prose",
      } as typeof f.pubFacts),
    );
    rejects(() =>
      freezeInventory(
        review,
        [
          f.entries[0]!,
          {
            request: makeRequest(review, f.pub, {
              ...f.pubFacts,
              contextHash: h(99),
            }),
            dependencies: [effect.effectKey],
          },
        ],
        f.keys,
        f.output,
        f.receipt,
      ),
    );
  });
  it("produces deterministic completed outcomes with sorted complete evidence", () => {
    const f = publication();
    const done = settle(f.running, {
      source: "github_app_receipt",
      externalRefHash: h(50),
    });
    const states = [seal(f.success), seal(done)];
    const result = makeOutcome(review, f.inventory, states, "available");
    expect(result.status).toBe("completed");
    const reordered = freezeInventory(
      review,
      [...f.entries].reverse(),
      [...f.keys].reverse(),
      f.output,
      f.receipt,
    );
    expect(reordered.inventoryHash).toBe(f.inventory.inventoryHash);
    expect(
      makeOutcome(review, reordered, [...states].reverse(), "available")
        .outcomeHash,
    ).toBe(result.outcomeHash);
    expect(Object.isFrozen(result.states[0]!.attempts)).toBe(true);
    rejects(() => makeOutcome(review, f.inventory, [states[0]!], "available"));
    rejects(() =>
      makeOutcome(review, f.inventory, [f.success, done], "available"),
    );
  });
  it("lost successful output is output_unavailable and cannot rerun", () => {
    const success = seal(settle(begin(prepared())));
    const outcome = makeOutcome(review, inventory(), [success], "unavailable");
    expect(outcome.status).toBe("output_unavailable");
    expect(outcome.output).toBeNull();
    rejects(() =>
      transition(success, authority(success.revision), { kind: "retry" }),
    );
  });
  it("reconciliation references predecessor and cannot drop uncertainty or reopen execution", () => {
    const f = publication();
    const unknown = seal(
      settle(f.running, { ...uncertain, reason: "listing_empty" }),
    );
    const provider = seal(f.success);
    const old = makeOutcome(
      review,
      f.inventory,
      [provider, unknown],
      "available",
    );
    expect(old.status).toBe("unresolved");
    const reconciled = settle(
      unknown,
      { source: "github_app_receipt", externalRefHash: h(50) },
      "2",
      "reconcile",
    );
    const newer = makeOutcome(
      review,
      f.inventory,
      [provider, reconciled],
      "available",
      old,
    );
    expect(newer.status).toBe("completed");
    expect(newer.predecessorHash).toBe(old.outcomeHash);
    expect(newer.outcomeHash).not.toBe(old.outcomeHash);
    expect(reconciled.attempts[0]!.evidence).toHaveLength(2);
    rejects(() =>
      makeOutcome(
        review,
        f.inventory,
        [provider, seal(settle(f.running, { source: "github_app_receipt" }))],
        "available",
        old,
      ),
    );
    rejects(() =>
      transition(reconciled, authority(reconciled.revision, "3"), {
        kind: "retry",
      }),
    );
  });
  it("retains duplicate remote effect integrity holds in outcomes", () => {
    const f = publication();
    const duplicate = seal(
      settle(f.running, {
        kind: "conflict",
        disposition: "duplicate_effects",
        reason: "duplicate_remote_effects",
        source: "github_app_receipt",
      }),
    );
    const outcome = makeOutcome(
      review,
      f.inventory,
      [seal(f.success), duplicate],
      "available",
    );
    expect(outcome.status).toBe("unresolved");
    expect(outcome.states.some((s) => s.integrityHold)).toBe(true);
    rejects(() =>
      makeReview({ ...logical, generation: "1" }, h(1), outcome, {
        admissionHash: h(99),
      }),
    );
  });
  it("classifies stopped_with_effect without hiding no-effect evidence", () => {
    const f = publication();
    const negative = seal(stop(settle(f.p, noEffect)));
    const outcome = makeOutcome(
      review,
      f.inventory,
      [seal(f.success), negative],
      "available",
    );
    expect(outcome.status).toBe("stopped_with_effect");
    expect(outcome.stops).toEqual(["cancelled"]);
    expect(
      outcome.states
        .flatMap((s) => s.attempts)
        .some((a) => a.status === "no_effect" && a.evidence.length === 1),
    ).toBe(true);
  });
  it("admits only explicit consecutive resolved generations, idempotently", () => {
    const unresolved = makeOutcome(
      review,
      inventory(),
      [seal(settle(begin(prepared()), uncertain))],
      "unavailable",
    );
    rejects(() =>
      makeReview({ ...logical, generation: "1" }, h(1), unresolved, {
        admissionHash: h(20),
      }),
    );
    const resolved = makeOutcome(
      review,
      inventory(),
      [seal(stop(settle(prepared(), noEffect)))],
      "unavailable",
    );
    expect(resolved.status).toBe("stopped_no_effect");
    const admit = (generation = "1", admissionHash = h(20)) =>
      makeReview({ ...logical, generation }, h(1), resolved, { admissionHash });
    const next = admit();
    expect(assertSameForkReview(next, admit())).toBe(next);
    rejects(() => assertSameForkReview(next, admit("1", h(21))));
    rejects(() => makeReview({ ...logical, generation: "1" }, h(1)));
    rejects(() => admit("2"));
  });
});

it("binds output only to the receipt which established success", () => {
  for (let n = 40; n < 56; n++) {
    const observed = settle(begin(prepared()), {
      source: "observation",
      reason: "timeout",
      resultHash: h(n),
    });
    const success = settle(observed, {}, "2", "reconcile");
    const input = {
      bindingHash: h(1),
      contextHash: h(2),
      canonicalOutputHash: h(18),
    };
    expect(makeOutput(success, input).canonicalOutputHash).toBe(h(18));
    rejects(() => makeOutput(success, { ...input, canonicalOutputHash: h(n) }));
  }
});
it("rejects review binding substitution in an outcome", () => {
  const state = seal(stop(settle(prepared(), noEffect)));
  rejects(() =>
    makeOutcome(
      makeReview(logical, h(99)),
      inventory(),
      [state],
      "unavailable",
    ),
  );
});
it("rejects mixed dependency inventories before publication begins", () => {
  const f = publication();
  const second = makeRequest(
    review,
    makeEffect(review, { stage: "publication", role: "inline", slot: 2 }),
    { ...f.pubFacts, objectTargetHash: h(60) },
  );
  const entries = [
    ...f.entries,
    { request: second, dependencies: [effect.effectKey] },
  ];
  const keys = entries.map((e) => e.request.effect.effectKey);
  const firstInventory = freezeInventory(
    review,
    entries,
    keys,
    f.output,
    f.receipt,
  );
  const secondInventory = freezeInventory(
    review,
    [
      entries[0]!,
      entries[1]!,
      { request: second, dependencies: [effect.effectKey, f.pub.effectKey] },
    ],
    keys,
    f.output,
    f.receipt,
  );
  const p2 = prepare(second, authority());
  const running = transition(f.p, authority(f.p.revision), {
    kind: "begin",
    inventory: firstInventory,
    states: [f.success, f.p, p2],
  });
  const done = settle(running, {
    source: "github_app_receipt",
    externalRefHash: h(50),
  });
  rejects(() =>
    transition(p2, authority(p2.revision), {
      kind: "begin",
      inventory: secondInventory,
      states: [f.success, done, p2],
    }),
  );
});

it("rejects copied durability facts and distinct admitted review generations", () => {
  const f = publication();
  rejects(() =>
    freezeInventory(review, f.entries, f.keys, f.output, { ...f.receipt }),
  );
  const resolved = makeOutcome(
    review,
    inventory(),
    [seal(stop(settle(prepared(), noEffect)))],
    "unavailable",
  );
  const first = makeReview({ ...logical, generation: "1" }, h(1), resolved, {
    admissionHash: h(70),
  });
  const second = makeReview({ ...logical, generation: "1" }, h(1), resolved, {
    admissionHash: h(71),
  });
  const req = makeRequest(first, makeEffect(first, effect.slot), facts);
  const inv = freezeInventory(
    first,
    [{ request: req, dependencies: [] }],
    [req.effect.effectKey],
    null,
    null,
  );
  rejects(() =>
    freezeInventory(second, inv.entries, [req.effect.effectKey], null, null),
  );
  const a = makeAuthority({
    ...authority(),
    logicalKey: first.logicalKey,
    reviewHash: fingerprint("fork-admission", first),
  });
  const p = prepare(req, a);
  const sealed = transition(p, makeAuthority({ ...a, revision: p.revision }), {
    kind: "seal",
  });
  rejects(() => makeOutcome(second, inv, [sealed], "unavailable"));
});

it("cannot replace epoch-ten unresolved outcome with epoch-two no-effect", () => {
  const base = seal(stop(settle(begin(prepared()), uncertain)));
  const high = transition(base, authority(base.revision, "10", "reconcile"), {
    kind: "seal",
  });
  const frozen = inventory();
  const predecessor = makeOutcome(review, frozen, [high], "unavailable");
  const low = settle(base, noEffect, "2", "reconcile");
  expect(makeOutcome(review, frozen, [low], "unavailable").status).toBe(
    "stopped_no_effect",
  );
  rejects(() => makeOutcome(review, frozen, [low], "unavailable", predecessor));
  rejects(() =>
    makeReview({ ...logical, generation: "1" }, h(1), predecessor, {
      admissionHash: h(90),
    }),
  );
});

it("authenticates outcome projection before reading predecessor fields", () => {
  const resolved = makeOutcome(
    review,
    inventory(),
    [seal(stop(settle(prepared(), noEffect)))],
    "unavailable",
  );
  const dto = {
    review,
    status: resolved.status,
    outcomeHash: resolved.outcomeHash,
  };
  const admission = { admissionHash: h(80) };
  const nextFacts = { ...logical, generation: "1" };
  rejects(() => makeStructuralReview(nextFacts, h(1), resolved, admission));
  const next = makeReview(nextFacts, h(1), resolved, admission);
  expect(
    assertSameForkReview(
      next,
      makeStructuralReview(nextFacts, h(1), dto, admission),
    ),
  ).toBe(next);
  let calls = 0;
  const trap = () => {
    calls++;
    throw new Error("must not execute");
  };
  for (const bad of [
    dto,
    { ...resolved },
    JSON.parse(JSON.stringify(resolved)),
    { ...resolved, outcomeHash: h(99) },
    {
      ...resolved,
      get review() {
        return trap();
      },
    },
    new Proxy(resolved, { get: trap, ownKeys: trap, getPrototypeOf: trap }),
  ])
    rejects(() => makeReview(nextFacts, h(1), bad as ForkOutcome, admission));
  expect(calls).toBe(0);
  rejects(() => makeReview(nextFacts, h(99), resolved, admission));
  rejects(() =>
    makeReview(
      { ...nextFacts, headSha: "c".repeat(40) },
      h(1),
      resolved,
      admission,
    ),
  );
  const other = makeOutcome(
    review,
    inventory(),
    [seal(settle(begin(prepared())))],
    "unavailable",
  );
  rejects(() =>
    assertSameForkReview(next, makeReview(nextFacts, h(1), other, admission)),
  );
});

it.each(["provider", "publication"] as const)(
  "fabricated predecessor identity cannot grant %s execution or proof capabilities",
  (stage) => {
    const f = publication();
    const dto = { review, status: "completed" as const, outcomeHash: h(81) };
    const nextFacts = { ...logical, generation: "1" };
    const admission = { admissionHash: h(82) };
    const next = makeStructuralReview(nextFacts, h(1), dto, admission);
    expect(
      assertSameForkReview(
        next,
        makeStructuralReview(nextFacts, h(1), dto, admission),
      ),
    ).toBe(next);
    const provider = makeRequest(next, makeEffect(next, effect.slot), facts);
    const inv = freezeInventory(
      next,
      [{ request: provider, dependencies: [] }],
      [provider.effect.effectKey],
      null,
      null,
    );
    const req =
      stage === "provider"
        ? provider
        : makeRequest(next, makeEffect(next, f.pub.slot), f.pubFacts);
    const rawAuthority = {
      ...authority(),
      logicalKey: next.logicalKey,
      reviewHash: fingerprint("fork-admission", next),
    };
    const rawEvidence = {
      ...f.success.attempts[0]!.evidence[0]!,
      logicalKey: next.logicalKey,
      effectKey: req.effect.effectKey,
      requestHash: req.requestHash,
    };
    // All artifacts obtainable without trust injection remain the wrong capability kind.
    const untrusted = [
      next,
      req.effect,
      req,
      inv,
      dto,
      admission,
      rawAuthority,
      rawEvidence,
      { ...f.receipt },
    ];
    for (const value of untrusted) {
      rejects(() => prepare(req, value as ForkAuthority));
      rejects(() => verifier.authority(value));
      rejects(() => verifier.evidence(value));
      rejects(() =>
        makeOutput(value as unknown as ForkEffectState, {
          bindingHash: h(1),
          contextHash: h(2),
          canonicalOutputHash: h(18),
        }),
      );
      rejects(() =>
        freezeInventory(
          review,
          f.entries,
          f.keys,
          f.output,
          value as ForkDurability,
        ),
      );
    }
    rejects(() => prepare(req, authority())); // Genuine authority for generation zero cannot be reused.
    const forged = { ...f.p, request: req, authority: rawAuthority };
    rejects(() =>
      transition(forged, rawAuthority, {
        kind: "begin",
        inventory: null,
        states: [],
      }),
    );
    rejects(() => makeOutcome(next, inv, [forged], "unavailable"));
    // Only an issued adapter proof crosses the boundary; copied evidence still cannot.
    const a = makeAuthority(rawAuthority);
    const prepared = prepare(req, a);
    const current = makeAuthority({ ...a, revision: prepared.revision });
    rejects(() =>
      transition(
        prepared,
        { ...current },
        { kind: "begin", inventory: null, states: [] },
      ),
    );
    rejects(() =>
      transition(prepared, current, {
        kind: "evidence",
        evidence: rawEvidence,
      }),
    );
    if (stage === "provider") {
      expect(
        transition(prepared, current, {
          kind: "begin",
          inventory: null,
          states: [],
        }).attempts[0]!.status,
      ).toBe("in_flight");
    } else {
      rejects(() =>
        transition(prepared, current, {
          kind: "begin",
          inventory: f.inventory,
          states: [f.success, prepared],
        }),
      );
      rejects(() =>
        freezeInventory(
          next,
          [
            { request: provider, dependencies: [] },
            { request: req, dependencies: [provider.effect.effectKey] },
          ],
          [provider.effect.effectKey, req.effect.effectKey],
          f.output,
          f.receipt,
        ),
      );
    }
  },
);

it.each(["binding", "admission", "predecessor"] as const)(
  "package root rejects genuine authority across %s substitution",
  (substitution) => {
    const resolved = makeOutcome(
      review,
      inventory(),
      [seal(stop(settle(prepared(), noEffect)))],
      "unavailable",
    );
    const other = makeOutcome(
      review,
      inventory(),
      [seal(settle(begin(prepared())))],
      "unavailable",
    );
    const nextFacts = { ...logical, generation: "1" };
    const aReview =
      substitution === "binding"
        ? review
        : makeReview(nextFacts, h(1), resolved, { admissionHash: h(80) });
    const bReview =
      substitution === "binding"
        ? makeReview(logical, h(99))
        : makeReview(
            nextFacts,
            h(1),
            substitution === "predecessor" ? other : resolved,
            { admissionHash: substitution === "admission" ? h(81) : h(80) },
          );
    expect(aReview.logicalKey).toBe(bReview.logicalKey);
    expect(fingerprint("fork-admission", aReview)).not.toBe(
      fingerprint("fork-admission", bReview),
    );
    const req = (r: typeof review) =>
      makeRequest(r, makeEffect(r, effect.slot), facts);
    const grant = (
      r: typeof review,
      revision = "0",
      mode: "execute" | "reconcile" = "execute",
    ) =>
      makeAuthority({
        ...authority(revision, "1", mode),
        logicalKey: r.logicalKey,
        reviewHash: fingerprint("fork-admission", r),
      });
    const a = grant(aReview);
    const b = prepare(req(bReview), grant(bReview));
    rejects(() => prepare(req(bReview), a));
    rejects(() =>
      transition(b, grant(aReview, "1"), {
        kind: "begin",
        inventory: null,
        states: [],
      }),
    );
    for (const mode of ["execute", "reconcile"] as const)
      for (const command of [
        { kind: "stop", reason: "cancelled" },
        { kind: "seal" },
      ] as const)
        rejects(() => transition(b, grant(aReview, b.revision, mode), command));
    const negativeEvidence = (auth: ForkAuthority) =>
      makeEvidence({
        ...resolved.states[0]!.attempts[0]!.evidence[0]!,
        logicalKey: bReview.logicalKey,
        effectKey: b.request.effect.effectKey,
        requestHash: b.request.requestHash,
        remoteScopeHash: b.request.remoteScopeHash,
        authorityHash: forkAuthorityHash(auth),
      });
    const wrong = grant(aReview, b.revision, "reconcile");
    rejects(() =>
      transition(b, wrong, {
        kind: "evidence",
        evidence: negativeEvidence(wrong),
      }),
    );
    const correct = grant(bReview, b.revision);
    const proof = negativeEvidence(correct);
    const negative = transition(b, correct, {
      kind: "evidence",
      evidence: proof,
    });
    expect(
      transition(negative, correct, { kind: "evidence", evidence: proof }),
    ).toBe(negative);
    rejects(() =>
      transition(negative, wrong, { kind: "evidence", evidence: proof }),
    );
    rejects(() =>
      transition(negative, grant(aReview, negative.revision), {
        kind: "retry",
      }),
    );
    expect(
      transition(negative, grant(bReview, negative.revision), { kind: "retry" })
        .attempts,
    ).toHaveLength(2);
    const exact = prepare(req(aReview), a);
    expect(
      transition(exact, grant(aReview, "1"), {
        kind: "begin",
        inventory: null,
        states: [],
      }).attempts[0]!.status,
    ).toBe("in_flight");
  },
);

it("package root fences publication with otherwise valid inventory and authority", () => {
  const f = publication();
  const other = makeReview(logical, h(99));
  const wrong = makeAuthority({
    ...authority(f.p.revision),
    reviewHash: fingerprint("fork-admission", other),
  });
  const command = {
    kind: "begin" as const,
    inventory: f.inventory,
    states: [f.success, f.p],
  };
  rejects(() => transition(f.p, wrong, command));
  expect(
    transition(f.p, authority(f.p.revision), command).attempts[0]!.status,
  ).toBe("in_flight");
});
