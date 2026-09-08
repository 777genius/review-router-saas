import { describe, expect, it, vi } from "vitest";
import {
  claimCertifiedForkReview as claim,
  manageCertifiedForkClaim as manage,
} from "../application/use-cases/claim-certified-fork-review.js";
import {
  reconcileCertifiedForkEffect as reconcile,
  type ForkReconciliationInput,
} from "../application/use-cases/reconcile-certified-fork-effect.js";
import { replayForkLedger } from "../application/services/certified-fork-effect-ledger.js";
import {
  SerializedForkRepository,
  seed,
  h,
  noEffect,
  success,
  stateOf,
  snapshotOf,
  change,
  lease,
  copy,
} from "./support/certified-fork-effect-repository.js";

describe("certified fork PR A application (no reservation entry point)", () => {
  it("disabled and either missing dependency return before every dependency call", async () => {
    const r = new SerializedForkRepository();
    const input = r.admit();
    const snapshot = r.fixture();
    const calls = [r.calls, r.proofCalls];
    for (const deps of [
      { ...r.dependencies, enabled: false },
      { ...r.dependencies, enabled: undefined },
      { ...r.dependencies, repository: undefined },
      { ...r.dependencies, proofs: undefined },
      { ...r.dependencies, ownerProof: undefined },
    ]) {
      expect((await claim(deps, input)).status).toMatch(
        /disabled|missing_dependencies/,
      );
      await manage(deps, {
        operation: "renew",
        expected: snapshot,
        commandId: "renew",
        ttlMs: 50,
      });
      await manage(deps, {
        operation: "release",
        expected: snapshot,
        commandId: "release",
      });
      await reconcile(deps, {
        expected: snapshot,
        commandId: "seal",
        command: { kind: "seal", effectKey: h(99) },
      });
    }
    expect([r.calls, r.proofCalls]).toEqual(calls);
    expect(r.commits).toBe(0);
  });
  it.each([
    "workspaceId",
    "repositoryId",
    "sourceRepositoryId",
    "baseRepositoryId",
  ] as const)(
    "rejects changed %s under an authentic admission",
    async (field) => {
      const r = new SerializedForkRepository();
      const input = r.admit();
      await expect(
        claim(r.dependencies, {
          ...input,
          seed: { ...seed, facts: { ...seed.facts, [field]: "other" } },
        }),
      ).rejects.toThrow();
      expect(r.commits).toBe(0);
    },
  );
  it("binds the complete admission, not ingress dedupe IDs", async () => {
    const r = new SerializedForkRepository();
    const input = r.admit();
    const snapshot = snapshotOf(await claim(r.dependencies, input));
    await expect(
      claim(r.dependencies, {
        ...input,
        seed: { ...seed, bindingHash: h(99) },
        commandId: "other",
      }),
    ).rejects.toThrow();
    await expect(
      claim(r.dependencies, {
        ...input,
        seed: { ...seed, admissionHash: h(99) },
        commandId: "other",
      }),
    ).rejects.toThrow();
    await expect(
      claim(r.dependencies, { ...input, ownerHash: h(99) }),
    ).rejects.toThrow();
    expect((await r.loadReview(snapshot.familyKey)).snapshot).toEqual(snapshot);
    expect(r.commits).toBe(1);
  });
  it("serializes concurrent admission and claims with one winner", async () => {
    const r = new SerializedForkRepository();
    const input = r.admit();
    const results = await Promise.allSettled([
      claim(r.dependencies, input),
      claim(r.asOwner(h(22)), {
        ...input,
        commandId: "second",
        ownerHash: h(22),
      }),
    ]);
    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(r.commits).toBe(1);
  });
  it("samples storage time under lock, rejects expired renewal and increments takeover fence", async () => {
    const r = new SerializedForkRepository();
    const input = r.admit();
    const old = snapshotOf(await claim(r.dependencies, input));
    r.beforeTransaction = () => {
      r.now = 200;
    };
    await expect(lease(r, old, "renew", "late", 100)).rejects.toThrow();
    const results = await Promise.allSettled([
      claim(r.asOwner(h(22)), {
        ...input,
        commandId: "takeover",
        ownerHash: h(22),
      }),
      claim(r.asOwner(h(23)), {
        ...input,
        commandId: "contender",
        ownerHash: h(23),
      }),
    ]);
    const winner = results.find((result) => result.status === "fulfilled");
    expect(winner?.status).toBe("fulfilled");
    if (!winner || winner.status !== "fulfilled")
      throw new Error("missing_winner");
    const current = snapshotOf(winner.value);
    expect(current.claim?.epoch).toBe("2");
    for (const operation of ["release", "renew"] as const)
      await expect(
        manage(r.dependencies, {
          operation,
          expected: old,
          commandId: operation,
          ttlMs: 100,
        }),
      ).rejects.toThrow();
    expect((await r.loadReview(old.familyKey)).snapshot).toEqual(current);
  });
  it("renews by CAS, rejects stale release, and release never closes a sender", async () => {
    const r = new SerializedForkRepository();
    const initial = r.fixture();
    await expect(
      manage(r.asOwner(h(22)), {
        operation: "release",
        expected: initial,
        commandId: "not_owner",
      }),
    ).rejects.toThrow();
    r.now = 150;
    const renewed = await lease(r, initial, "renew", "renew", 200);
    expect(renewed.claim?.expiresAt).toBe(350);
    await expect(lease(r, initial, "release", "stale")).rejects.toThrow();
    const released = await lease(r, renewed, "release", "release");
    expect(released.claim).toBeNull();
    expect(stateOf(r, released).attempts[0]!.status).toBe("in_flight");
    await expect(
      change(r, released, "seal", {
        kind: "seal",
        effectKey: stateOf(r, released).request.effect.effectKey,
      }),
    ).rejects.toThrow();
  });
  it("rejects new mutations when complete current admission is revoked", async () => {
    const r = new SerializedForkRepository();
    const snapshot = r.fixture();
    const command = r.evidenceFor(snapshot);
    r.admissionCurrent = false;
    await expect(change(r, snapshot, "evidence", command)).rejects.toThrow();
    await expect(lease(r, snapshot, "renew", "renew", 100)).rejects.toThrow();
    expect(r.commits).toBe(0);
    expect(stateOf(r, snapshot).attempts[0]!.status).toBe("in_flight");
  });
  it.each(["timeout", "listing_empty", "absent"] as const)(
    "%s evidence remains unresolved",
    async (reason) => {
      const r = new SerializedForkRepository();
      const snapshot = r.fixture();
      const updated = await change(
        r,
        snapshot,
        reason,
        r.evidenceFor(snapshot, { reason }),
      );
      expect(stateOf(r, updated).attempts[0]!.status).toBe("unknown");
      expect(stateOf(r, updated).attempts).toHaveLength(1);
    },
  );
  it("rejects forged no-effect and treats an authenticated open sender as unknown", async () => {
    const r = new SerializedForkRepository();
    const snapshot = r.fixture();
    const command = r.evidenceFor(snapshot, {
      ...noEffect,
      senderClosure: "open",
    });
    await expect(
      change(r, snapshot, "forged", {
        ...command,
        proof: JSON.stringify(noEffect),
      }),
    ).rejects.toThrow();
    expect(r.commits).toBe(0);
    const updated = await change(r, snapshot, "open", command);
    expect(stateOf(r, updated).attempts[0]!.status).toBe("unknown");
  });
  it("records closed-sender no-effect without exposing PR B retry/begin", async () => {
    const r = new SerializedForkRepository();
    const snapshot = r.fixture();
    const updated = await change(
      r,
      snapshot,
      "closed",
      r.evidenceFor(snapshot, noEffect),
    );
    expect(stateOf(r, updated).attempts[0]!.status).toBe("no_effect");
    for (const kind of ["begin", "retry", "prepare", "inventory"])
      await expect(
        change(r, updated, kind, {
          kind,
          effectKey: stateOf(r, updated).request.effect.effectKey,
        } as ForkReconciliationInput),
      ).rejects.toThrow();
    expect(r.commits).toBe(1);
  });
  it("deduplicates identical authenticated evidence durably and retains late contradiction", async () => {
    let r = new SerializedForkRepository();
    const snapshot = r.fixture();
    const command = r.evidenceFor(snapshot, success);
    const first = await change(r, snapshot, "success", command);
    r = r.restart();
    const duplicate = await change(r, first, "duplicate", command);
    expect(duplicate.events).toEqual(first.events);
    expect(stateOf(r, duplicate).revision).toBe(stateOf(r, first).revision);
    const held = await change(
      r,
      duplicate,
      "contradiction",
      r.evidenceFor(duplicate, noEffect),
    );
    expect(stateOf(r, held).integrityHold).toBe(true);
    expect(stateOf(r, held).attempts[0]!.evidence).toHaveLength(2);
    const late = await change(
      r,
      held,
      "late",
      r.evidenceFor(held, { ...success, evidenceHash: h(99) }),
    );
    expect(stateOf(r, late).integrityHold).toBe(true);
  });
  it("CASes all effect revisions and aggregate outcome, including concurrent evidence", async () => {
    const r = new SerializedForkRepository();
    const snapshot = r.fixture();
    const commands = [
      r.evidenceFor(snapshot),
      r.evidenceFor(snapshot, noEffect),
    ];
    const results = await Promise.allSettled(
      commands.map((command, i) => change(r, snapshot, "e" + i, command)),
    );
    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    const current = (await r.loadReview(snapshot.familyKey)).snapshot!;
    expect(stateOf(r, current).attempts[0]!.evidence).toHaveLength(1);
    expect(replayForkLedger(current, r.proofs).outcome).toBeNull();
  });
});

describe("detached application command capture", () => {
  it("captures the original acquire before awaiting receipt lookup", async () => {
    const r = new SerializedForkRepository();
    const input = copy(r.admit());
    const first = await claim(r.dependencies, input);
    const original = copy(input);
    const load = r.loadReview.bind(r);
    vi.spyOn(r, "loadReview").mockImplementation(async (...args) => {
      input.commandId = "mutated";
      input.ttlMs = 300001;
      Object.assign(input.seed.facts, { generation: "99" });
      return load(...args);
    });
    const transaction = vi.spyOn(r, "acquireClaim");
    const result = await claim(r.dependencies, input);
    expect(result.status).toBe("reconciliation_required");
    expect(snapshotOf(result)).toEqual(snapshotOf(first));
    expect(r.loadReview).toHaveBeenCalledExactlyOnceWith(
      snapshotOf(first).familyKey,
      original.commandId,
    );
    expect(transaction).not.toHaveBeenCalled();
    expect(r.commits).toBe(1);
  });
  it.each(["bindingHash", "ttlMs"] as const)(
    "captures %s before the transaction hook",
    async (field) => {
      const r = new SerializedForkRepository();
      const input = copy(r.admit());
      r.beforeTransaction = () => {
        if (field === "bindingHash")
          Object.assign(input.seed, { bindingHash: h(999) });
        else input.ttlMs = 999999999;
      };
      const result = snapshotOf(await claim(r.dependencies, input));
      expect(result.seed.bindingHash).toBe(seed.bindingHash);
      expect(result.claim?.expiresAt).toBe(200);
      expect(
        replayForkLedger(result, r.restart().proofs).review.bindingHash,
      ).toBe(seed.bindingHash);
      expect(r.commits).toBe(1);
    },
  );
  it("never commits stop(cancelled) under a seal command receipt", async () => {
    const r = new SerializedForkRepository();
    const expected = r.fixture();
    const effectKey = stateOf(r, expected).request.effect.effectKey;
    const command: ForkReconciliationInput = { kind: "seal", effectKey };
    const original = copy(command);
    r.beforeTransaction = () =>
      Object.assign(command, { kind: "stop", reason: "cancelled" });
    const result = snapshotOf(
      await reconcile(r.dependencies, {
        expected,
        commandId: "seal_capture",
        command,
      }),
    );
    expect(stateOf(r, result)).toMatchObject({ sealed: true, stops: [] });
    r.beforeTransaction = null;
    const replay = await reconcile(r.restart().dependencies, {
      expected,
      commandId: "seal_capture",
      command: original,
    });
    expect(snapshotOf(replay)).toEqual(result);
    await expect(
      reconcile(r.dependencies, {
        expected,
        commandId: "seal_capture",
        command,
      }),
    ).rejects.toThrow();
  });
  it("detaches nested records, arrays and proof references before asynchronous mutation", async () => {
    const r = new SerializedForkRepository();
    const expected = copy(r.fixture());
    const command = r.evidenceFor(expected);
    const original = copy(expected);
    r.beforeTransaction = () => {
      Object.assign(expected.seed.facts, { workspaceId: "mutated" });
      const inventory = expected.events.find(
        (e) => e.input.kind === "inventory",
      )!.input;
      if (inventory.kind === "inventory")
        Object.assign(inventory.entries[0]!.dependencies, { 0: h(999) });
      Object.assign(expected.events[0]!, { at: new Date(999) });
      Object.defineProperty(expected, "familyKey", {
        get() {
          throw new Error("late_getter");
        },
      });
      command.proof = "changed";
    };
    const result = snapshotOf(
      await reconcile(r.dependencies, {
        expected,
        commandId: "nested",
        command,
      }),
    );
    expect(result.events.slice(0, original.events.length)).toEqual(
      original.events,
    );
    expect(stateOf(r.restart(), result).attempts[0]!.evidence).toHaveLength(1);
  });
  it.each([
    "getter",
    "proxy",
    "revoked",
    "date",
    "date_like",
    "inherited",
    "sparse",
    "oversized",
    "cycle",
    "invalid_command",
    "invalid_ttl",
    "nested_proxy",
    "nested_getter",
    "nested_date",
    "unbounded_record",
  ])(
    "rejects %s without any dependency call or accessor/trap execution",
    async (kind) => {
      const r = new SerializedForkRepository();
      const expected = copy(r.fixture());
      const effectKey = stateOf(r, expected).request.effect.effectKey;
      let executed = 0;
      const bomb = () => {
        executed++;
        throw new Error("user_code");
      };
      let command: unknown = { kind: "seal", effectKey };
      if (kind === "getter")
        Object.defineProperty(command, "kind", { get: bomb });
      if (kind === "proxy")
        command = new Proxy(command as object, {
          ownKeys: bomb,
          get: bomb,
          getPrototypeOf: bomb,
          getOwnPropertyDescriptor: bomb,
        });
      if (kind === "revoked") {
        const p = Proxy.revocable({}, {});
        p.revoke();
        command = p.proxy;
      }
      if (kind === "date")
        Object.assign(expected.events[0]!, { at: new Date(100) });
      if (kind === "date_like")
        Object.assign(expected.events[0]!, {
          at: {
            get valueOf() {
              return bomb();
            },
            get toJSON() {
              return bomb();
            },
          },
        });
      if (kind === "inherited") command = Object.create(command as object);
      if (kind === "sparse") Object.assign(expected, { events: new Array(3) });
      if (kind === "oversized")
        Object.assign(expected, { events: new Array(100001) });
      if (kind === "cycle") Object.assign(command as object, { self: command });
      if (kind === "invalid_command")
        command = { kind: "stop", effectKey, reason: "invalid" };
      if (kind === "nested_proxy")
        Object.assign(expected.seed, {
          facts: new Proxy(expected.seed.facts, {
            ownKeys: bomb,
            get: bomb,
            getPrototypeOf: bomb,
          }),
        });
      if (kind === "nested_getter")
        Object.defineProperty(
          expected.checkpoint!.state.states[0]!,
          "attempts",
          { get: bomb },
        );
      if (kind === "nested_date")
        Object.assign(expected.checkpoint!.state.states[0]!.authority, {
          validUntilHash: new Date(100),
        });
      if (kind === "unbounded_record")
        command = Object.fromEntries(
          Array.from({ length: 65 }, (_, i) => ["field" + i, i]),
        );
      const deps = r.dependencies;
      const before = [r.calls, r.proofCalls, r.commits];
      if (kind === "invalid_ttl")
        await expect(
          manage(deps, {
            expected,
            operation: "renew",
            commandId: "bad",
            ttlMs: 300001,
          }),
        ).rejects.toThrow();
      else
        await expect(
          reconcile(deps, {
            expected,
            commandId: "bad",
            command: command as ForkReconciliationInput,
          }),
        ).rejects.toThrow();
      expect([r.calls, r.proofCalls, r.commits]).toEqual(before);
      expect(executed).toBe(0);
    },
  );
});
