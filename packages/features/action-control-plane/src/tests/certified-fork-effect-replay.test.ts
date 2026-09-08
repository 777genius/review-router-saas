import { describe, expect, it, vi } from "vitest";
import * as canonical from "../domain/certified-fork-effect-canonical.js";
import * as domainState from "../domain/certified-fork-effect-state.js";
import { createForkOutput } from "../domain/certified-fork-effect-outcome.js";
import {
  manageCertifiedForkClaim,
  claimCertifiedForkReview as claim,
} from "../application/use-cases/claim-certified-fork-review.js";
import { reconcileCertifiedForkEffect as reconcile } from "../application/use-cases/reconcile-certified-fork-effect.js";
import {
  replayForkLedger,
  checkpointState,
} from "../application/services/certified-fork-effect-ledger.js";
import type { ForkLedgerSnapshot } from "../application/ports/certified-fork-effect-repository-port.js";
import {
  SerializedForkRepository,
  seed,
  provider,
  h,
  noEffect,
  success,
  copy,
  stateOf,
  snapshotOf,
  change,
} from "./support/certified-fork-effect-repository.js";

const seal = (r: SerializedForkRepository, s: ForkLedgerSnapshot) =>
  change(r, s, "seal", {
    kind: "seal",
    effectKey: stateOf(r, s).request.effect.effectKey,
  });
const outcome = (
  r: SerializedForkRepository,
  s: ForkLedgerSnapshot,
  id = "outcome",
) =>
  change(r, s, id, {
    kind: "outcome",
    availability: "unavailable",
    retainedProof: null,
  });

function withoutCheckpoint(snapshot: ForkLedgerSnapshot) {
  const historical = copy({ ...snapshot });
  delete historical.checkpoint;
  return historical;
}

describe("certified fork PR A crash and verified replay", () => {
  it.each(["before_commit", "lost_ack"] as const)(
    "claim %s rolls back or recovers one durable receipt",
    async (fault) => {
      let r = new SerializedForkRepository();
      const input = r.admit();
      r.fault = fault;
      if (fault === "before_commit") {
        await expect(claim(r.dependencies, input)).rejects.toThrow(
          "crash_before_commit",
        );
        expect(r.commits).toBe(0);
      } else {
        expect((await claim(r.dependencies, input)).status).toBe(
          "reconciliation_required",
        );
        expect(r.commits).toBe(1);
      }
      r = r.restart();
      const result = await claim(r.dependencies, input);
      expect(result.status).toBe(
        fault === "lost_ack" ? "reconciliation_required" : "committed",
      );
      expect(snapshotOf(result).claim?.epoch).toBe("1");
      expect(r.commits).toBe(fault === "lost_ack" ? 0 : 1);
    },
  );
  it.each(["before_commit", "lost_ack"] as const)(
    "evidence %s never duplicates a transition",
    async (fault) => {
      let r = new SerializedForkRepository();
      const initial = r.fixture();
      const input = {
        expected: initial,
        commandId: "evidence",
        command: r.evidenceFor(initial),
      };
      const durableBefore = JSON.parse(r.serialize());
      r.fault = fault;
      if (fault === "before_commit") {
        await expect(reconcile(r.dependencies, input)).rejects.toThrow(
          "crash_before_commit",
        );
        expect((await r.loadReview(initial.familyKey)).snapshot).toEqual(
          initial,
        );
        const after = JSON.parse(r.serialize());
        for (const table of ["rows", "receipts", "checkpoints", "comparisons"])
          expect(after[table]).toEqual(durableBefore[table]);
      } else
        expect((await reconcile(r.dependencies, input)).status).toBe(
          "reconciliation_required",
        );
      r = r.restart();
      const result = await reconcile(r.dependencies, input);
      expect(result.status).toBe(
        fault === "lost_ack" ? "reconciliation_required" : "committed",
      );
      expect(snapshotOf(result).events).toHaveLength(initial.events.length + 1);
      expect(stateOf(r, snapshotOf(result)).attempts[0]!.evidence).toHaveLength(
        1,
      );
    },
  );
  it("restarts after begin with unknown dispatch; historical expired claim grants no current mutation", async () => {
    let r = new SerializedForkRepository();
    const initial = r.fixture();
    r.now = 201;
    r = r.restart();
    expect(stateOf(r, initial).attempts[0]!.status).toBe("in_flight");
    await expect(seal(r, initial)).rejects.toThrow();
    const acquired = await claim(r.dependencies, {
      ...r.admit(),
      commandId: "takeover",
    });
    expect(acquired.status).toBe("reconciliation_required");
    const current = snapshotOf(acquired);
    expect(current.fence).toBe("2");
    expect(stateOf(r, current).attempts).toEqual(stateOf(r, initial).attempts);
    const observed = await change(
      r,
      current,
      "unknown",
      r.evidenceFor(current),
    );
    expect(stateOf(r, observed).attempts[0]!.status).toBe("unknown");
    expect(stateOf(r, observed).attempts).toHaveLength(1);
  });
  it("rejects forged, reordered and truncated history, even authenticated invalid transition bytes", () => {
    const r = new SerializedForkRepository();
    const initial = withoutCheckpoint(r.fixture(true, false));
    r.attestStoredBytes(initial);
    const duplicateAuthority = r.proofs.authorize({
      review: replayForkLedger(initial, r.proofs).review,
      revision: "1",
      mode: "execute",
      at: 100,
      claim: initial.claim,
    });
    const verifyLedger = vi.spyOn(r.proofs, "verifyLedger");
    const authority = vi.spyOn(r.proofs, "authority");
    const restore = vi.spyOn(r.proofs, "restoreCheckpoint");
    const candidates = [
      { ...initial, events: [...initial.events].reverse() },
      { ...initial, events: initial.events.slice(1) },
      {
        ...initial,
        events: [
          initial.events[0]!,
          initial.events[0]!,
          ...initial.events.slice(1),
        ],
      },
      {
        ...initial,
        events: initial.events.map((e, i) => (i === 1 ? { ...e, at: 201 } : e)),
      },
      {
        ...initial,
        events: initial.events.map((e, i) =>
          i === 0 ? { ...e, authorityProof: "forged" } : e,
        ),
      },
      {
        ...initial,
        // Valid authority for revision 1 must still reject a second prepare.
        events: [
          initial.events[0]!,
          { ...initial.events[0]!, authorityProof: duplicateAuthority },
          ...initial.events.slice(1),
        ],
      },
    ];
    for (const [index, corrupted] of candidates.entries()) {
      verifyLedger.mockClear();
      authority.mockClear();
      expect(() => replayForkLedger(corrupted, r.proofs)).toThrow(
        "certified_fork_effect_contract_rejected",
      );
      expect(verifyLedger).toHaveBeenCalledExactlyOnceWith(corrupted);
      expect(verifyLedger.mock.results[0]?.type).toBe("throw");
      expect(authority).not.toHaveBeenCalled();
      r.attestStoredBytes(corrupted);
      verifyLedger.mockClear();
      expect(() => replayForkLedger(corrupted, r.proofs)).toThrow(
        "certified_fork_effect_contract_rejected",
      );
      expect(verifyLedger).toHaveBeenCalledExactlyOnceWith(corrupted);
      expect(verifyLedger.mock.results[0]?.type).toBe("return");
      expect(authority).toHaveBeenCalledTimes([1, 1, 2, 2, 1, 2][index]!);
      expect(authority.mock.results.at(-1)?.type).toBe(
        index === 5 ? "return" : "throw",
      );
    }
    expect(restore).not.toHaveBeenCalled();
    expect(() =>
      replayForkLedger(copy(initial), r.restart().proofs),
    ).not.toThrow();
  });
  it("retains the authenticated historical mode rather than reclassifying old authority", () => {
    const r = new SerializedForkRepository();
    let s = r.fixture();
    const effectKey = stateOf(r, s).request.effect.effectKey;
    s = r.appendFixture(
      s,
      { kind: "stop", effectKey, reason: "cancelled" },
      "execute",
    );
    s = r.appendFixture(s, { kind: "seal", effectKey }, "execute");
    s = withoutCheckpoint(s);
    r.attestStoredBytes(s);
    const restarted = r.restart();
    restarted.now = 300; // Historical authority survives expiration of the lease.
    const authority = vi.spyOn(restarted.proofs, "authority");
    const restore = vi.spyOn(restarted.proofs, "restoreCheckpoint");
    expect(stateOf(restarted, copy(s))).toMatchObject({
      sealed: true,
      stops: ["cancelled"],
      authority: { mode: "execute" },
    });
    const historical = s.events.filter(
      (event) => event.authorityProof !== null,
    );
    expect(authority).toHaveBeenCalledTimes(historical.length);
    historical.forEach((event, index) => {
      expect(authority).toHaveBeenNthCalledWith(
        index + 1,
        event.authorityProof,
        expect.objectContaining({ mode: null, claim: null, at: event.at }),
      );
      expect(authority.mock.results[index]).toMatchObject({
        type: "return",
        value: { mode: "execute" },
      });
    });
    expect(restore).not.toHaveBeenCalled();
  });
  it.each([
    "settingsHash",
    "effectiveInputHash",
    "accountScopeHash",
    "modelHash",
  ] as const)(
    "rejects substituted historical request %s without mutation",
    async (field) => {
      const r = new SerializedForkRepository();
      const initial = r.fixture();
      const corrupted = {
        ...initial,
        events: initial.events.map((e, i) =>
          i === 0
            ? {
                ...e,
                input: {
                  kind: "prepare" as const,
                  request: {
                    ...provider,
                    facts: { ...provider.facts, [field]: h(99) },
                  },
                },
              }
            : e,
        ),
      };
      await expect(
        change(r, corrupted, "seal", {
          kind: "seal",
          effectKey: stateOf(r, initial).request.effect.effectKey,
        }),
      ).rejects.toThrow();
      expect(r.commits).toBe(0);
      expect((await r.loadReview(initial.familyKey)).snapshot).toEqual(initial);
      r.currentProvider = { ...provider.facts, [field]: h(99) };
      await expect(seal(r, initial)).rejects.toThrow();
      expect(r.commits).toBe(0);
    },
  );
  it("rejects missing frozen inventory members and unavailable retained output", async () => {
    const r = new SerializedForkRepository();
    const initial = r.fixture();
    const missing = {
      ...initial,
      events: initial.events.map((e) =>
        e.input.kind === "inventory"
          ? { ...e, input: { ...e.input, entries: [] } }
          : e,
      ),
    };
    r.attestStoredBytes(missing);
    expect(() => replayForkLedger(missing, r.proofs)).toThrow();
    const sealed = await seal(r, initial);
    await expect(
      change(r, sealed, "available", {
        kind: "outcome",
        availability: "available",
        retainedProof: "forged",
      }),
    ).rejects.toThrow();
    expect((await r.loadReview(initial.familyKey)).snapshot).toEqual(sealed);
  });
  it("reconstructs retained output and durability from authenticated receipts after restart", () => {
    let r = new SerializedForkRepository();
    let s = r.fixture(true, false);
    s = r.appendFixture(s, r.evidenceFor(s, success));
    const state = stateOf(r, s);
    const output = createForkOutput(state, {
      bindingHash: seed.bindingHash,
      contextHash: provider.facts.contextHash,
      canonicalOutputHash: h(40),
    });
    const effectKey = state.request.effect.effectKey;
    // Test-local trusted archive: serialize proof records alongside repository
    // bytes, then install fresh adapters from that archive after restart.
    let archive = {
      inventory: { complete: [effectKey] },
      durability: {
        durable: {
          output: copy(output),
          facts: {
            disposition: "durably_committed" as const,
            outputCommitmentHash: output.outputHash,
            commitReceiptHash: h(70),
          },
        },
      },
      retained: { retained: copy(output) },
    };
    const install = () => {
      const records = archive;
      r.proofs.inventory = (proof) => {
        if (!Object.hasOwn(records.inventory, proof))
          throw new Error("unknown_inventory_proof");
        return copy(records.inventory[proof as keyof typeof records.inventory]);
      };
      r.proofs.durability = (proof, proposed) => {
        if (!Object.hasOwn(records.durability, proof))
          throw new Error("unknown_durability_proof");
        const record =
          records.durability[proof as keyof typeof records.durability];
        expect(proposed).toEqual(record.output);
        return copy(record.facts);
      };
      r.proofs.retainedOutput = (proof, proposed) => {
        if (!Object.hasOwn(records.retained, proof))
          throw new Error("unknown_retained_proof");
        expect(proposed).toEqual(
          records.retained[proof as keyof typeof records.retained],
        );
      };
    };
    install();
    s = r.appendFixture(s, {
      kind: "inventory",
      entries: [{ effectKey, dependencies: [] }],
      completenessProof: "complete",
      output: {
        effectKey,
        canonicalOutputHash: h(40),
        durabilityProof: "durable",
      },
    });
    s = r.appendFixture(s, { kind: "seal", effectKey });
    s = r.appendFixture(s, {
      kind: "outcome",
      availability: "available",
      retainedProof: "retained",
    });
    s = withoutCheckpoint(s);
    r.attestStoredBytes(s);
    const serialized = JSON.stringify({
      repository: r.serialize(),
      archive,
      snapshot: s,
    });
    const restored: {
      repository: string;
      archive: typeof archive;
      snapshot: typeof s;
    } = JSON.parse(serialized);
    r = new SerializedForkRepository(restored.repository);
    archive = restored.archive;
    s = restored.snapshot;
    install();
    const inventory = vi.spyOn(r.proofs, "inventory");
    const durability = vi.spyOn(r.proofs, "durability");
    const retained = vi.spyOn(r.proofs, "retainedOutput");
    const verifyLedger = vi.spyOn(r.proofs, "verifyLedger");
    const checkpoint = vi.spyOn(r.proofs, "restoreCheckpoint");
    const replayed = replayForkLedger(s, r.proofs);
    expect(replayed.outcome).toMatchObject({ status: "completed", output });
    expect(replayed.inventory).toMatchObject({
      output,
      durability: archive.durability.durable.facts,
    });
    expect(inventory).toHaveBeenCalledExactlyOnceWith(
      "complete",
      replayed.review,
      [state.request],
      100,
    );
    expect(durability).toHaveBeenCalledExactlyOnceWith("durable", output, 100);
    expect(retained).toHaveBeenCalledExactlyOnceWith("retained", output, 100);
    expect(
      [inventory, durability, retained].map(
        (probe) => probe.mock.results[0]?.type,
      ),
    ).toEqual(["return", "return", "return"]);
    expect(checkpoint).not.toHaveBeenCalled();
    const forged = {
      ...s,
      events: s.events.map((e) =>
        e.input.kind === "outcome"
          ? { ...e, input: { ...e.input, retainedProof: "copied_dto" } }
          : e,
      ),
    };
    r.attestStoredBytes(forged);
    for (const probe of [verifyLedger, inventory, durability, retained])
      probe.mockClear();
    expect(() => replayForkLedger(forged, r.proofs)).toThrow(
      "unknown_retained_proof",
    );
    expect(verifyLedger).toHaveBeenCalledExactlyOnceWith(forged);
    expect(verifyLedger.mock.results[0]?.type).toBe("return");
    expect(inventory).toHaveBeenCalledTimes(1);
    expect(durability).toHaveBeenCalledExactlyOnceWith("durable", output, 100);
    expect(retained).toHaveBeenCalledExactlyOnceWith("copied_dto", output, 100);
    expect(retained.mock.results[0]?.type).toBe("throw");
    expect(checkpoint).not.toHaveBeenCalled();
  });
  it("saturation commits the final distinct proof with a sticky hold; duplicates still dedupe", async () => {
    let r = new SerializedForkRepository();
    const initial = r.saturatedFixture();
    const command = r.evidenceFor(initial, { evidenceHash: h(2000) });
    const saturated = await change(r, initial, "saturate", command);
    expect(stateOf(r, saturated).integrityHold).toBe(true);
    expect(stateOf(r, saturated).attempts[0]!.evidence).toHaveLength(256);
    r = r.restart();
    const duplicate = await change(r, saturated, "duplicate", command);
    expect(duplicate.events).toEqual(saturated.events);
    await expect(
      change(
        r,
        duplicate,
        "overflow",
        r.evidenceFor(duplicate, { evidenceHash: h(2001) }),
      ),
    ).rejects.toThrow();
    expect((await r.loadReview(initial.familyKey)).snapshot).toEqual(duplicate);
    expect(stateOf(r, duplicate).integrityHold).toBe(true);
  }, 180_000);
  it("corrects sealed unresolved outcome after restart by previous-outcome CAS without reopening sends", async () => {
    let r = new SerializedForkRepository();
    let current = r.fixture();
    current = await change(r, current, "unknown", r.evidenceFor(current));
    current = await change(r, current, "stop", {
      kind: "stop",
      reason: "cancelled",
      effectKey: stateOf(r, current).request.effect.effectKey,
    });
    current = await outcome(r, await seal(r, current));
    const before = replayForkLedger(current, r.proofs);
    expect(before.outcome?.status).toBe("unresolved");
    const nextSeed = {
      ...seed,
      facts: { ...seed.facts, generation: "1" },
      admissionHash: h(90),
      predecessor: r.savePredecessor(current),
    };
    expect(() => r.admit(nextSeed)).toThrow();
    r.now = 201;
    r = r.restart();
    current = snapshotOf(
      await claim(r.dependencies, { ...r.admit(), commandId: "takeover" }),
    );
    current = await change(
      r,
      current,
      "closed",
      r.evidenceFor(current, noEffect),
    );
    r.fault = "lost_ack";
    const corrected = await outcome(r, current, "correct");
    const after = replayForkLedger(corrected, r.proofs);
    expect(after.outcome?.status).toBe("stopped_no_effect");
    expect(after.outcome?.predecessorHash).toBe(before.outcome?.outcomeHash);
    expect(after.inventory).toEqual(before.inventory);
    expect(stateOf(r, corrected)).toMatchObject({
      sealed: true,
      stops: ["cancelled"],
    });
    expect(stateOf(r, corrected).attempts).toHaveLength(1);
    await expect(outcome(r, current, "stale_correction")).rejects.toThrow();
    const admitted = r.admit({
      ...nextSeed,
      predecessor: r.savePredecessor(corrected),
    });
    const fork = r.restart();
    fork.now = 302;
    const contenders = await Promise.allSettled(
      ["next", "racing_next"].map((commandId) =>
        claim(fork.dependencies, { ...admitted, commandId }),
      ),
    );
    expect(
      contenders.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const next = (await fork.loadReview(corrected.familyKey)).snapshot!;
    expect(replayForkLedger(next, fork.proofs).review.facts.generation).toBe(
      "1",
    );
    expect(next.events).toEqual([]);
    const late = await change(
      r,
      corrected,
      "late",
      r.evidenceFor(corrected, success),
    );
    r.now = 302;
    // Even before a new outcome is projected, late contradictory evidence blocks
    // generation admission from the previously resolved outcome.
    await expect(
      claim(r.dependencies, { ...admitted, commandId: "premature" }),
    ).rejects.toThrow();
    expect((await r.loadReview(current.familyKey)).snapshot).toEqual(late);
  });
});

describe("authenticated bounded checkpoints", () => {
  it.each([
    "version",
    "review",
    "effect",
    "revision",
    "attempt",
    "hold",
    "stop",
    "seal",
    "prefix",
    "length",
    "position",
    "forged",
  ])(
    "rejects %s checkpoint tampering even with an authenticated outer ledger",
    (field) => {
      const r = new SerializedForkRepository();
      const original = r.fixture();
      const altered = copy(original);
      const cp = altered.checkpoint!;
      const state = cp.state.states[0]!;
      if (field === "version") Object.assign(altered, { version: "999" });
      if (field === "review")
        Object.assign(cp.state.review, { bindingHash: h(99) });
      if (field === "effect")
        Object.assign(state.request.effect, { effectKey: h(99) });
      if (field === "revision") Object.assign(state, { revision: "999" });
      if (field === "attempt")
        Object.assign(state.attempts[0]!, { originEpoch: "999" });
      if (field === "hold") Object.assign(state, { integrityHold: true });
      if (field === "stop") Object.assign(state, { stops: ["cancelled"] });
      if (field === "seal") Object.assign(state, { sealed: true });
      if (field === "prefix") Object.assign(cp, { prefixHash: h(99) });
      if (field === "length")
        Object.assign(cp, { prefixLength: cp.prefixLength - 1 });
      if (field === "position")
        Object.assign(cp, {
          position: { commandId: "forged", commandHash: h(99) },
        });
      if (field === "forged") Object.assign(cp, { proof: h(99) });
      r.attestStoredBytes(altered);
      expect(() => replayForkLedger(altered, r.restart().proofs)).toThrow();
      expect(() =>
        replayForkLedger(original, r.restart().proofs),
      ).not.toThrow();
    },
  );
  it("enforces the exact 32-event suffix bound and independently commits order", () => {
    const r = new SerializedForkRepository();
    const snapshot = r.saturatedFixture(33);
    const { checkpoint: _checkpoint, ...without } = snapshot;
    expect(_checkpoint).toBeDefined();
    expect(() => replayForkLedger(without, r.proofs)).toThrow(
      "checkpoint_required",
    );
    const prefix = { ...without, events: without.events.slice(0, 4) };
    r.attestStoredBytes(prefix);
    const ledger = replayForkLedger(prefix, r.proofs);
    const checkpoint = r.proofs.issueCheckpoint(
      prefix,
      checkpointState(ledger),
      null,
    );
    const bounded = { ...snapshot, checkpoint };
    r.attestStoredBytes(bounded);
    expect(replayForkLedger(bounded, r.restart().proofs)).toEqual(
      replayForkLedger(snapshot, r.proofs),
    );
    const shorter = { ...without, events: without.events.slice(0, 3) };
    r.attestStoredBytes(shorter);
    const tooLong = {
      ...snapshot,
      checkpoint: r.proofs.issueCheckpoint(
        shorter,
        checkpointState(replayForkLedger(shorter, r.proofs)),
        null,
      ),
    };
    r.attestStoredBytes(tooLong);
    expect(() => replayForkLedger(tooLong, r.proofs)).toThrow(
      "checkpoint_required",
    );
    const reordered = {
      ...bounded,
      events: [
        bounded.events[1]!,
        bounded.events[0]!,
        ...bounded.events.slice(2),
      ],
    };
    r.attestStoredBytes(reordered);
    expect(() => replayForkLedger(reordered, r.proofs)).toThrow(
      "checkpoint_stale_or_tampered",
    );
  });
  it("atomically retains the winning checkpoint/receipt across lost acknowledgement, restart and concurrent CAS", async () => {
    let r = new SerializedForkRepository();
    const expected = r.fixture();
    const commands = [
      r.evidenceFor(expected),
      r.evidenceFor(expected, noEffect),
    ];
    r.fault = "lost_ack";
    const result = await Promise.allSettled(
      commands.map((command, i) => change(r, expected, "cp" + i, command)),
    );
    expect(result.filter((item) => item.status === "fulfilled")).toHaveLength(
      1,
    );
    expect(r.replayVerificationsInTransaction).toBe(0);
    const before = await r.loadReview(expected.familyKey, "cp0");
    expect(before.snapshot!.checkpoint!.position).toEqual({
      commandId: "cp0",
      commandHash: before.receipt!.commandHash,
    });
    r = r.restart();
    expect(await r.loadReview(expected.familyKey, "cp0")).toEqual(before);
    const restored = await change(r, expected, "cp0", commands[0]!);
    expect(restored).toEqual(before.snapshot);
    expect(r.commits).toBe(0);
    const stale = { ...restored, checkpoint: expected.checkpoint! };
    r.attestStoredBytes(stale);
    expect(() => replayForkLedger(stale, r.proofs)).toThrow();
    const frozen = await change(r, restored, "seal_after_restart", {
      kind: "seal",
      effectKey: commands[0]!.effectKey,
    });
    expect(stateOf(r, frozen).sealed).toBe(true);
    expect(frozen.checkpoint).not.toEqual(restored.checkpoint);
  });
  it("reconstructs 32/64/128/255 entries with linear hash counts, zero cumulative transitions and zero transactional replay", async () => {
    const counts: number[] = [];
    for (const n of [32, 64, 128, 255]) {
      let r = new SerializedForkRepository();
      const snapshot = r.saturatedFixture(n);
      r = r.restart(); // no live capabilities or caches survive
      const hashes = vi.spyOn(canonical, "fingerprint");
      const transitions = vi.spyOn(domainState, "transitionForkEffect");
      const start = performance.now();
      const restored = replayForkLedger(snapshot, r.proofs);
      const ms = performance.now() - start;
      const calls = hashes.mock.calls.length;
      counts.push(calls);
      expect(transitions).toHaveBeenCalledTimes(0);
      expect(
        restored.states.values().next().value!.attempts[0]!.evidence,
      ).toHaveLength(n);
      expect(calls).toBeLessThan(4 * (n + 3) + 32);
      console.log(
        JSON.stringify({
          checkpointReplay: n,
          ms,
          hashes: calls,
          cumulativeTransitions: transitions.mock.calls.length,
        }),
      );
      hashes.mockRestore();
      transitions.mockRestore();
      const command = r.evidenceFor(snapshot, { evidenceHash: h(3000) });
      await change(r, snapshot, "linear", command);
      expect(r.replayVerificationsInTransaction).toBe(0);
    }
    expect(counts[3]!).toBeLessThan(counts[0]! * 8);
  }, 180_000);
});

describe("authenticated original command receipt recovery", () => {
  const operations = [
    "acquireClaim",
    "renewClaim",
    "releaseClaim",
    "compareAndCommit",
  ] as const;
  function setup(operation: (typeof operations)[number]) {
    const r = new SerializedForkRepository();
    const admission = r.admit();
    const expected = operation === "acquireClaim" ? null : r.fixture();
    const invoke = (deps: typeof r.dependencies) => {
      if (operation === "acquireClaim") return claim(deps, admission);
      if (operation === "compareAndCommit")
        return reconcile(deps, {
          expected: expected!,
          commandId: "original",
          command: {
            kind: "stop",
            reason: "cancelled",
            effectKey: stateOf(r, expected!).request.effect.effectKey,
          },
        });
      return manageCertifiedForkClaim(deps, {
        expected: expected!,
        commandId: "original",
        operation: operation === "renewClaim" ? "renew" : "release",
        ttlMs: 100,
      });
    };
    return { r, admission, invoke };
  }

  it.each(operations)(
    "%s authenticates actual lost acknowledgement",
    async (operation) => {
      const { r, invoke } = setup(operation);
      const transaction = vi.spyOn(r, operation);
      r.fault = "lost_ack";
      expect((await invoke(r.dependencies)).status).toBe(
        "reconciliation_required",
      );
      expect(transaction).toHaveBeenCalledTimes(1);
      expect(r.commits).toBe(1);
    },
  );

  for (const recovery of [false, true]) {
    for (const tip of [
      "expired",
      "same-owner-new-epoch",
      "new-owner",
    ] as const) {
      it.each(operations)(
        `%s authenticates ${recovery ? "reload" : "duplicate"} with ${tip}`,
        async (operation) => {
          const { r: original, admission, invoke } = setup(operation);
          const first = await invoke(original.dependencies);
          expect(first.status).toBe("committed");
          const r = original.restart();
          r.now = 1000;
          if (tip !== "expired") {
            const ownerHash = tip === "new-owner" ? h(99) : h(20);
            await claim(r.asOwner(ownerHash), {
              ...admission,
              ownerHash,
              commandId: "replacement",
            });
          }
          // Hide only the preflight receipt to exercise ambiguous-ack recovery.
          if (recovery && operation === "acquireClaim") {
            const load = r.loadReview.bind(r);
            let reads = 0;
            vi.spyOn(r, "loadReview").mockImplementation(async (...args) => {
              const loaded = await load(...args);
              return ++reads % 2 === 1 ? { ...loaded, receipt: null } : loaded;
            });
          }
          const operationImpl = r[operation].bind(r);
          const transaction = vi
            .spyOn(r, operation)
            .mockImplementation(async (tx) => {
              const loaded = await operationImpl(tx);
              if (recovery) throw new Error("duplicate_ack_lost");
              return loaded;
            });
          const ownership = vi.spyOn(r.proofs, "ownership");
          const before = r.serialize();
          const commits = r.commits;
          for (const proof of ["invalid-proof", r.ownerProof(h(99))]) {
            await expect(
              invoke({ ...r.dependencies, ownerProof: proof }),
            ).rejects.toThrow();
            expect(ownership).toHaveBeenLastCalledWith(proof, h(20), null);
          }
          const result = await invoke(r.dependencies);
          expect(result.status).toBe("reconciliation_required");
          expect("loaded" in result && result.loaded.receipt).toEqual(
            "loaded" in first && first.loaded.receipt,
          );
          expect(snapshotOf(result).claim?.ownerHash ?? null).toBe(
            tip === "new-owner"
              ? h(99)
              : operation === "releaseClaim" && tip === "expired"
                ? null
                : h(20),
          );
          if (tip !== "expired")
            expect(snapshotOf(result).claim?.epoch).toBe("2");
          expect(transaction).toHaveBeenCalledTimes(
            operation === "acquireClaim" && !recovery ? 0 : 3,
          );
          expect(r.commits).toBe(commits);
          // Registering test sessions is the only permitted archive difference.
          expect(JSON.parse(r.serialize()).rows).toEqual(
            JSON.parse(before).rows,
          );
          expect(JSON.parse(r.serialize()).receipts).toEqual(
            JSON.parse(before).receipts,
          );
        },
      );
    }
    it.each(operations)(
      `%s rejects tampered receipt on ${recovery ? "reload" : "duplicate"}`,
      async (operation) => {
        const { r, invoke } = setup(operation);
        await invoke(r.dependencies);
        const operationImpl = r[operation].bind(r);
        const load = r.loadReview.bind(r);
        const corrupt = (loaded: Awaited<ReturnType<typeof load>>) => ({
          ...loaded,
          receipt: loaded.receipt && { ...loaded.receipt, ownerHash: h(99) },
        });
        vi.spyOn(r, operation).mockImplementation(async (tx) => {
          const loaded = await operationImpl(tx);
          if (recovery) throw new Error("duplicate_ack_lost");
          return corrupt(loaded);
        });
        if (recovery || operation === "acquireClaim")
          vi.spyOn(r, "loadReview").mockImplementation(async (...args) =>
            corrupt(await load(...args)),
          );
        await expect(invoke(r.asOwner(h(99)))).rejects.toThrow();
        expect(r.commits).toBe(1);
      },
    );
  }
});

describe("original acquire recovery after family generation advancement", () => {
  async function setup() {
    let r = new SerializedForkRepository();
    const input = r.admit();
    const original = await claim(r.dependencies, input);
    // Import authenticated sender history; PR A deliberately cannot begin sends.
    let current = r.fixture();
    current = await change(
      r,
      current,
      "closed",
      r.evidenceFor(current, noEffect),
    );
    current = await change(r, current, "stop", {
      kind: "stop",
      reason: "cancelled",
      effectKey: stateOf(r, current).request.effect.effectKey,
    });
    current = await outcome(r, await seal(r, current));
    expect(replayForkLedger(current, r.proofs).outcome?.status).toBe(
      "stopped_no_effect",
    );
    const admission = r.admit({
      ...seed,
      facts: { ...seed.facts, generation: "1" },
      admissionHash: h(90),
      predecessor: r.savePredecessor(current),
    });
    r.now = 201;
    const next = snapshotOf(
      await claim(r.asOwner(h(99)), {
        ...admission,
        ownerHash: h(99),
        commandId: "generation_one",
      }),
    );
    expect(replayForkLedger(next, r.proofs).review.facts.generation).toBe("1");
    r = r.restart();
    return { r, input, original, next };
  }

  it.each(["original", "invalid", "different"] as const)(
    "%s owner proof on delayed acquire uses one read and zero transactions",
    async (owner) => {
      const { r, input, original, next } = await setup();
      const ownerProof =
        owner === "invalid"
          ? "invalid-proof"
          : r.ownerProof(owner === "different" ? h(99) : h(20));
      const before = r.serialize();
      const load = vi.spyOn(r, "loadReview");
      const transaction = vi.spyOn(r, "acquireClaim");
      const ownership = vi.spyOn(r.proofs, "ownership");
      const result = claim({ ...r.dependencies, ownerProof }, input);
      if (owner === "original") {
        const recovered = await result;
        expect(recovered.status).toBe("reconciliation_required");
        expect(snapshotOf(recovered)).toEqual(next);
        expect("loaded" in recovered && recovered.loaded.receipt).toEqual(
          "loaded" in original && original.loaded.receipt,
        );
      } else await expect(result).rejects.toThrow();
      expect(ownership).toHaveBeenLastCalledWith(ownerProof, h(20), null);
      expect(load).toHaveBeenCalledExactlyOnceWith(
        next.familyKey,
        input.commandId,
      );
      expect(transaction).not.toHaveBeenCalled();
      expect(r.commits).toBe(0);
      expect(r.serialize()).toBe(before);
    },
  );

  it.each(["commandId", "commandHash"] as const)(
    "mismatched receipt %s fails closed before receipt authentication or acquisition",
    async (field) => {
      const { r, input } = await setup();
      const load = r.loadReview.bind(r);
      vi.spyOn(r, "loadReview").mockImplementation(async (...args) => {
        const loaded = await load(...args);
        return {
          ...loaded,
          receipt: {
            ...loaded.receipt!,
            [field]: field === "commandId" ? "other" : h(999),
          },
        };
      });
      const verify = vi.spyOn(r.proofs, "verifyReceipt");
      const transaction = vi.spyOn(r, "acquireClaim");
      await expect(claim(r.dependencies, input)).rejects.toThrow();
      expect(verify).not.toHaveBeenCalled();
      expect(transaction).not.toHaveBeenCalled();
      expect(r.commits).toBe(0);
    },
  );

  it.each(["signature", "ledger", "family"] as const)(
    "exact receipt cannot bypass %s authentication",
    async (corruption) => {
      const { r, input } = await setup();
      const load = r.loadReview.bind(r);
      vi.spyOn(r, "loadReview").mockImplementation(async (...args) => {
        const loaded = await load(...args);
        if (corruption === "signature")
          return {
            ...loaded,
            receipt: { ...loaded.receipt!, ownerHash: h(999) },
          };
        if (corruption === "ledger")
          return {
            ...loaded,
            snapshot: { ...loaded.snapshot!, version: "999" },
          };
        return {
          ...loaded,
          snapshot: { ...loaded.snapshot!, familyKey: h(999) },
        };
      });
      const transaction = vi.spyOn(r, "acquireClaim");
      await expect(claim(r.dependencies, input)).rejects.toThrow();
      expect(transaction).not.toHaveBeenCalled();
      expect(r.commits).toBe(0);
    },
  );

  it("ambiguous acknowledgement recovers the advanced family in one read without transaction retry", async () => {
    const { r, input, next } = await setup();
    const durable = r.loadReview.bind(r);
    const receipt = (await durable(next.familyKey, input.commandId)).receipt;
    // The first observation predates acquisition; the single recovery read sees
    // the committed receipt and the family tip after concurrent advancement.
    const load = vi
      .spyOn(r, "loadReview")
      .mockResolvedValueOnce({ snapshot: null, receipt: null })
      .mockResolvedValueOnce({ snapshot: next, receipt });
    const transaction = vi
      .spyOn(r, "acquireClaim")
      .mockRejectedValueOnce(new Error("commit_ack_lost"));
    const before = r.serialize();
    const result = await claim(r.dependencies, input);
    expect(result.status).toBe("reconciliation_required");
    expect(snapshotOf(result)).toEqual(next);
    expect(load).toHaveBeenCalledTimes(2); // preflight plus exactly one recovery read
    expect(load).toHaveBeenNthCalledWith(2, next.familyKey, input.commandId);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(r.commits).toBe(0);
    expect(r.serialize()).toBe(before);
  });
});
