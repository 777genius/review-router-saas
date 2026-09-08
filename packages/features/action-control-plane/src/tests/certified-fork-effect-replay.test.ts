import { describe, expect, it, vi } from "vitest";
import { createForkOutput } from "../domain/certified-fork-effect-outcome.js";
import type { ForkLedgerSnapshot } from "../application/ports/certified-fork-effect-repository-port.js";
import { replayForkLedger } from "../application/services/certified-fork-effect-ledger.js";
import {
  SerializedForkRepository,
  seed,
  provider,
  h,
  success,
  copy,
  stateOf,
} from "./support/certified-fork-effect-repository.js";

function withoutCheckpoint(snapshot: ForkLedgerSnapshot) {
  const historical = copy({ ...snapshot });
  delete historical.checkpoint;
  return historical;
}

describe("certified fork PR A crash and verified replay", () => {
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
});
