import { describe, expect, it, vi } from "vitest";
import {
  executeCertifiedForkEffect as execute,
  type ForkExecutionInput,
} from "../application/use-cases/execute-certified-fork-effect.js";
import { claimCertifiedForkReview as claim } from "../application/use-cases/claim-certified-fork-review.js";
import {
  replayForkLedger,
  type ForkBoundary,
} from "../application/services/certified-fork-effect-ledger.js";
import type {
  ForkLedgerSnapshot,
  ForkRequestSeed,
} from "../application/ports/certified-fork-effect-repository-port.js";
import {
  SerializedForkRepository,
  change,
  copy,
  h,
  lease,
  noEffect,
  provider,
  seed,
  snapshotOf,
  stateOf,
  success,
} from "./support/certified-fork-effect-repository.js";

const publication: ForkRequestSeed = {
  slot: { stage: "publication", role: "advisory", slot: 1 },
  facts: {
    contextHash: h(2),
    adapterContractHash: h(3),
    schemaHash: h(4),
    outputCommitmentHash: h(50),
    frozenPlanHash: h(51),
    appId: "app",
    installationId: "installation",
    baseRepositoryId: seed.facts.baseRepositoryId,
    pullRequest: 1,
    commitSha: seed.facts.headSha,
    objectTargetHash: h(52),
    renderPolicyHash: h(53),
    payloadHashes: [h(54)],
    markerHash: h(55),
  },
};
async function acquired(r: SerializedForkRepository) {
  return snapshotOf(await claim(r.dependencies, r.admit()));
}
async function write(
  r: SerializedForkRepository,
  expected: ForkLedgerSnapshot,
  commandId: string,
  command: ForkExecutionInput,
) {
  return snapshotOf(
    await execute(r.dependencies, { expected, commandId, command }),
  );
}
async function prepared(r: SerializedForkRepository) {
  return write(r, await acquired(r), "prepare", {
    kind: "prepare",
    request: provider,
  });
}
async function begun(r: SerializedForkRepository) {
  const expected = await prepared(r);
  return write(r, expected, "begin", {
    kind: "begin",
    effectKey: stateOf(r, expected).request.effect.effectKey,
  });
}
function attemptCommand(
  r: SerializedForkRepository,
  expected: ForkLedgerSnapshot,
  kind: "begin" | "retry",
) {
  return { kind, effectKey: stateOf(r, expected).request.effect.effectKey };
}

describe("certified fork execution application boundary", () => {
  it("is disabled by default and requires the existing dependencies", async () => {
    const r = new SerializedForkRepository();
    const expected = await acquired(r);
    const input = {
      expected,
      commandId: "prepare",
      command: { kind: "prepare" as const, request: provider },
    };
    const before = r.calls;
    expect(await execute({}, input)).toEqual({ status: "disabled" });
    expect(await execute({ enabled: true }, input)).toEqual({
      status: "missing_dependencies",
    });
    expect(r.calls).toBe(before);
  });

  it("persists prepare/begin as domain events and restores attempts after restart", async () => {
    let r = new SerializedForkRepository();
    const empty = await acquired(r);
    const result = await execute(r.dependencies, {
      expected: empty,
      commandId: "prepare",
      command: { kind: "prepare", request: provider },
    });
    expect(result.status).toBe("committed");
    const first = snapshotOf(result);
    expect(first.events).toHaveLength(1);
    expect(first.events[0]!.input).toEqual({
      kind: "prepare",
      request: provider,
    });
    expect(stateOf(r, first).attempts[0]!.status).toBe("prepared");
    r = r.restart();
    const expected = (await r.loadReview(first.familyKey)).snapshot!;
    const started = await write(
      r,
      expected,
      "begin",
      attemptCommand(r, expected, "begin"),
    );
    const state = stateOf(r.restart(), started);
    expect(started.events.map((e) => e.input.kind)).toEqual([
      "prepare",
      "begin",
    ]);
    expect(state.revision).toBe("2");
    expect(state.authority.mode).toBe("execute");
    expect(state.attempts[0]).toMatchObject({
      status: "in_flight",
      evidence: [],
      originEpoch: expected.claim!.epoch,
      originClaimHash: expected.claim!.claimHash,
      originOwnerHash: expected.claim!.ownerHash,
    });
    expect(r.replayVerificationsInTransaction).toBe(0);
  });

  it("dedupes an exact prepare but rejects command ID mismatch and a second reservation of the slot", async () => {
    const r = new SerializedForkRepository();
    const expected = await acquired(r);
    const input = {
      expected,
      commandId: "prepare",
      command: { kind: "prepare" as const, request: provider },
    };
    const committed = snapshotOf(await execute(r.dependencies, input));
    const count = r.commits;
    expect((await execute(r.dependencies, copy(input))).status).toBe(
      "reconciliation_required",
    );
    expect(r.commits).toBe(count);
    await expect(
      execute(r.dependencies, {
        ...input,
        command: {
          kind: "prepare",
          request: {
            ...provider,
            facts: { ...provider.facts, settingsHash: h(90) },
          },
        },
      }),
    ).rejects.toThrow();
    await expect(
      write(r, committed, "second-prepare", input.command),
    ).rejects.toThrow();
    expect(r.commits).toBe(count);
  });

  it.each(["begin", "retry"] as const)(
    "dedupes exact %s without creating another attempt/event",
    async (kind) => {
      const r = new SerializedForkRepository();
      let expected = await prepared(r);
      if (kind === "retry")
        expected = await change(
          r,
          expected,
          "no-effect",
          r.evidenceFor(expected, noEffect),
        );
      const input = {
        expected,
        commandId: kind,
        command: attemptCommand(r, expected, kind),
      };
      const result = snapshotOf(await execute(r.dependencies, input));
      const count = r.commits;
      const duplicate = await execute(r.dependencies, copy(input));
      expect(duplicate.status).toBe("reconciliation_required");
      expect(snapshotOf(duplicate)).toEqual(result);
      expect(r.commits).toBe(count);
      await expect(
        execute(r.dependencies, {
          ...input,
          command: { kind, effectKey: h(99) },
        }),
      ).rejects.toThrow();
      expect(r.commits).toBe(count);
    },
  );

  it.each([
    "wrong_owner",
    "expired",
    "lock_expired",
    "replaced",
    "fence_tampered",
  ])("rejects begin with %s claim", async (scenario) => {
    const r = new SerializedForkRepository();
    let expected = await prepared(r);
    let deps: ForkBoundary = r.dependencies;
    if (scenario === "wrong_owner") deps = r.asOwner(h(91));
    if (scenario === "expired") r.now = expected.claim!.expiresAt;
    if (scenario === "lock_expired")
      r.beforeTransaction = () => {
        r.now = expected.claim!.expiresAt;
      };
    if (scenario === "replaced") {
      await lease(r, expected, "release", "release");
      expected = snapshotOf(
        await claim(r.dependencies, { ...r.admit(), commandId: "reacquire" }),
      );
      expect(expected.claim!.epoch).toBe("2");
    }
    const command = attemptCommand(r, expected, "begin");
    if (scenario === "fence_tampered") expected = { ...expected, fence: "2" };
    const count = r.commits;
    await expect(
      execute(deps, { expected, commandId: "begin", command }),
    ).rejects.toThrow();
    expect(r.commits).toBe(count);
    expect(r.replayVerificationsInTransaction).toBe(0);
  });

  it.each(["prepare", "begin", "retry"] as const)(
    "checks current admission and proposed/current provider input for %s under the lock",
    async (kind) => {
      for (const drift of ["scope", "provider"] as const) {
        const r = new SerializedForkRepository();
        let expected =
          kind === "prepare" ? await acquired(r) : await prepared(r);
        if (kind === "retry")
          expected = await change(
            r,
            expected,
            "closed",
            r.evidenceFor(expected, noEffect),
          );
        const command: ForkExecutionInput =
          kind === "prepare"
            ? { kind, request: provider }
            : attemptCommand(r, expected, kind);
        const count = r.commits;
        r.beforeTransaction = () => {
          if (drift === "scope") r.admissionCurrent = false;
          else
            r.currentProvider = {
              ...provider.facts,
              effectiveInputHash: h(92),
            };
        };
        await expect(write(r, expected, "stale", command)).rejects.toThrow();
        expect(r.commits).toBe(count);
      }
    },
  );

  it.each([
    ["no evidence", null],
    ["timeout", {}],
    ["open no-effect", { ...noEffect, senderClosure: "open" as const }],
    ["empty listing", { ...noEffect, reason: "listing_empty" as const }],
    ["wrong source", { ...noEffect, source: "observation" as const }],
    ["success", success],
  ] as const)("does not retry %s", async (_name, evidence) => {
    const r = new SerializedForkRepository();
    let expected = await begun(r);
    if (evidence)
      expected = await change(
        r,
        expected,
        "evidence",
        r.evidenceFor(expected, evidence),
      );
    const count = r.commits;
    await expect(
      write(r, expected, "retry", attemptCommand(r, expected, "retry")),
    ).rejects.toThrow();
    expect(r.commits).toBe(count);
    expect(stateOf(r, expected).attempts).toHaveLength(1);
  });

  it.each(["never_dispatched", "rejected"] as const)(
    "retries only after authenticated closed %s, then needs a distinct begin",
    async (reason) => {
      const r = new SerializedForkRepository();
      let expected = await begun(r);
      expected = await change(r, expected, "unknown", r.evidenceFor(expected));
      expected = await change(
        r,
        expected,
        "closed",
        r.evidenceFor(expected, {
          ...noEffect,
          reason,
          source:
            reason === "rejected" ? "provider_receipt" : "dispatch_journal",
          evidenceHash: h(98),
        }),
      );
      const restarted = r.restart();
      const retried = await write(
        restarted,
        expected,
        "retry",
        attemptCommand(restarted, expected, "retry"),
      );
      expect(
        stateOf(restarted.restart(), retried).attempts.map((a) => a.status),
      ).toEqual(["no_effect", "prepared"]);
      const started = await write(
        restarted,
        retried,
        "begin-again",
        attemptCommand(restarted, retried, "begin"),
      );
      expect(stateOf(restarted, started).attempts.map((a) => a.status)).toEqual(
        ["no_effect", "in_flight"],
      );
    },
  );

  it("rejects unauthenticated evidence and a tampered checkpoint before retry", async () => {
    const r = new SerializedForkRepository();
    const expected = await begun(r);
    const count = r.commits;
    await expect(
      change(r, expected, "forged-proof", {
        kind: "evidence",
        effectKey: stateOf(r, expected).request.effect.effectKey,
        proof: "unretained",
      }),
    ).rejects.toThrow();
    const tampered = copy(expected);
    Object.assign(tampered.checkpoint!.state.states[0]!.attempts[0]!, {
      status: "no_effect",
    });
    await expect(
      write(r, tampered, "retry", attemptCommand(r, expected, "retry")),
    ).rejects.toThrow();
    expect(r.commits).toBe(count);
  });

  it.each(["stale", "cancelled", "sealed", "hold"] as const)(
    "preserves the %s retry guard",
    async (guard) => {
      const r = new SerializedForkRepository();
      let expected = await prepared(r);
      expected = await change(
        r,
        expected,
        "closed",
        r.evidenceFor(expected, noEffect),
      );
      const effectKey = stateOf(r, expected).request.effect.effectKey;
      expected = await change(
        r,
        expected,
        "guard",
        guard === "sealed"
          ? { kind: "seal", effectKey }
          : guard === "hold"
            ? r.evidenceFor(expected, { ...success, evidenceHash: h(93) })
            : { kind: "stop", effectKey, reason: guard },
      );
      const count = r.commits;
      await expect(
        write(r, expected, "retry", { kind: "retry", effectKey }),
      ).rejects.toThrow();
      expect(r.commits).toBe(count);
    },
  );

  it("cannot begin publication without authenticated frozen inventory and output", async () => {
    const r = new SerializedForkRepository();
    const expected = await write(r, await prepared(r), "publication", {
      kind: "prepare",
      request: publication,
    });
    const state = [
      ...replayForkLedger(expected, r.proofs).states.values(),
    ].find((s) => s.request.effect.slot.stage === "publication")!;
    const count = r.commits;
    await expect(
      write(r, expected, "publish-begin", {
        kind: "begin",
        effectKey: state.request.effect.effectKey,
      }),
    ).rejects.toThrow();
    expect(r.commits).toBe(count);
  });

  it("compares all sibling revisions and rejects a race before build", async () => {
    const r = new SerializedForkRepository();
    const one = await prepared(r);
    const expected = await write(r, one, "publication", {
      kind: "prepare",
      request: publication,
    });
    const states = [...replayForkLedger(expected, r.proofs).states.values()];
    const sibling = states.find(
      (s) => s.request.effect.slot.stage === "publication",
    )!;
    const original = r.compareAndCommit;
    let builds = 0;
    r.compareAndCommit = async (tx) => {
      expect(tx.expected!.revisions).toEqual(
        states
          .map((s) => ({
            effectKey: s.request.effect.effectKey,
            revision: s.revision,
          }))
          .sort((a, b) => a.effectKey.localeCompare(b.effectKey)),
      );
      r.compareAndCommit = original;
      await change(r, expected, "sibling-drift", {
        kind: "stop",
        effectKey: sibling.request.effect.effectKey,
        reason: "cancelled",
      });
      return original({
        ...tx,
        build: (current, at) => {
          builds++;
          return tx.build(current, at);
        },
      });
    };
    const count = r.commits;
    await expect(
      write(r, expected, "begin", attemptCommand(r, expected, "begin")),
    ).rejects.toThrow();
    expect(builds).toBe(0);
    expect(r.commits).toBe(count + 1);
  });

  it.each(["omitted", "added", "revised"])(
    "the repository rejects %s sibling CAS membership even when other comparison fields match",
    async (drift) => {
      const r = new SerializedForkRepository();
      const expected = await write(r, await prepared(r), "publication", {
        kind: "prepare",
        request: publication,
      });
      const original = r.compareAndCommit;
      let builds = 0;
      r.compareAndCommit = (tx) => {
        const revisions = [...tx.expected!.revisions];
        if (drift === "omitted") revisions.pop();
        if (drift === "added")
          revisions.push({ effectKey: h(97), revision: "1" });
        if (drift === "revised")
          revisions[1] = { ...revisions[1]!, revision: "2" };
        return original({
          ...tx,
          expected: { ...tx.expected!, revisions },
          build: (current, at) => {
            builds++;
            return tx.build(current, at);
          },
        });
      };
      const count = r.commits;
      await expect(
        write(r, expected, "begin", attemptCommand(r, expected, "begin")),
      ).rejects.toThrow();
      expect(builds).toBe(0);
      expect(r.commits).toBe(count);
    },
  );

  it.each(["prepare", "begin", "retry"] as const)(
    "%s ambiguity uses one recovery load and never a second transaction",
    async (kind) => {
      for (const fault of ["before_commit", "lost_ack"] as const) {
        const r = new SerializedForkRepository();
        let expected =
          kind === "prepare" ? await acquired(r) : await prepared(r);
        if (kind === "retry")
          expected = await change(
            r,
            expected,
            "closed",
            r.evidenceFor(expected, noEffect),
          );
        const command: ForkExecutionInput =
          kind === "prepare"
            ? { kind, request: provider }
            : attemptCommand(r, expected, kind);
        const transaction = vi.spyOn(r, "compareAndCommit");
        const load = vi.spyOn(r, "loadReview");
        const count = r.commits;
        r.fault = fault;
        const operation = execute(r.dependencies, {
          expected,
          commandId: "ambiguous",
          command,
        });
        if (fault === "before_commit")
          await expect(operation).rejects.toThrow("crash_before_commit");
        else {
          const result = await operation;
          expect(result.status).toBe("reconciliation_required");
          expect(snapshotOf(result).events.at(-1)!.input).toEqual(command);
        }
        expect(transaction).toHaveBeenCalledTimes(1);
        expect(load).toHaveBeenCalledExactlyOnceWith(
          expected.familyKey,
          "ambiguous",
        );
        expect(r.commits).toBe(count + (fault === "lost_ack" ? 1 : 0));
        expect(r.replayVerificationsInTransaction).toBe(0);
        const stored = await r
          .restart()
          .loadReview(expected.familyKey, "ambiguous");
        expect(stored.receipt !== null).toBe(fault === "lost_ack");
        expect(stored.snapshot!.events.length).toBe(
          expected.events.length + (fault === "lost_ack" ? 1 : 0),
        );
      }
    },
  );

  it("propagates recovery read failure without another load or transaction", async () => {
    const r = new SerializedForkRepository();
    const expected = await acquired(r);
    const transaction = vi.spyOn(r, "compareAndCommit");
    const load = vi
      .spyOn(r, "loadReview")
      .mockRejectedValue(new Error("read-unavailable"));
    r.fault = "lost_ack";
    await expect(
      write(r, expected, "prepare", { kind: "prepare", request: provider }),
    ).rejects.toThrow("read-unavailable");
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledTimes(1);
    expect(
      (await r.restart().loadReview(expected.familyKey, "prepare")).receipt,
    ).not.toBeNull();
  });

  it("recovers original-owner receipts after release/reacquisition despite stale admission, rejecting another owner", async () => {
    const r = new SerializedForkRepository();
    const expected = await acquired(r);
    const input = {
      expected,
      commandId: "prepare",
      command: { kind: "prepare" as const, request: provider },
    };
    const first = snapshotOf(await execute(r.dependencies, input));
    await lease(r, first, "release", "release");
    const nextOwner = h(94);
    const later = snapshotOf(
      await claim(r.asOwner(nextOwner), {
        ...r.admit(),
        ownerHash: nextOwner,
        commandId: "new-owner",
      }),
    );
    r.admissionCurrent = false;
    r.now = later.claim!.expiresAt;
    const count = r.commits;
    const recovered = await execute(r.dependencies, input);
    expect(recovered.status).toBe("reconciliation_required");
    expect(snapshotOf(recovered).claim!.ownerHash).toBe(nextOwner);
    expect("loaded" in recovered && recovered.loaded.receipt!.ownerHash).toBe(
      h(20),
    );
    await expect(execute(r.asOwner(nextOwner), input)).rejects.toThrow();
    expect(r.commits).toBe(count);
  });

  it("passes lock-time current ownership, admission, mutation and execute authority to the trusted proofs", async () => {
    const r = new SerializedForkRepository();
    const expected = await acquired(r);
    const ownership = vi.spyOn(r.proofs, "ownership");
    const admission = vi.spyOn(r.proofs, "admission");
    const mutation = vi.spyOn(r.proofs, "mutation");
    const authorize = vi.spyOn(r.proofs, "authorize");
    const authority = vi.spyOn(r.proofs, "authority");
    r.beforeTransaction = () => {
      r.now = 150;
    };
    const command = { kind: "prepare" as const, request: provider };
    const result = await write(r, expected, "prepare", command);
    expect(ownership).toHaveBeenCalledWith(
      r.dependencies.ownerProof,
      expected.claim!.ownerHash,
      150,
    );
    const currentAdmission = admission.mock.calls.find(
      (call) => call[2] === true,
    )!;
    expect(currentAdmission[3]).toBe(150);
    expect(currentAdmission[4].map((request) => request.requestHash)).toEqual([
      stateOf(r, result).request.requestHash,
    ]);
    expect(mutation).toHaveBeenCalledWith(command, currentAdmission[1], 150);
    expect(authorize).toHaveBeenCalledExactlyOnceWith({
      review: currentAdmission[1],
      revision: "0",
      at: 150,
      mode: "execute",
      claim: expected.claim,
    });
    expect(authority).toHaveBeenCalledWith(
      result.events[0]!.authorityProof,
      authorize.mock.calls[0]![0],
    );
    expect(result.events[0]!.at).toBe(150);
    expect(r.replayVerificationsInTransaction).toBe(0);
  });

  it("rejects a current principal revoked while waiting for the transaction lock", async () => {
    const r = new SerializedForkRepository();
    const expected = await prepared(r);
    const original = r.proofs.ownership;
    let revoked = false;
    r.proofs.ownership = (proof, owner, at) => {
      if (revoked) throw new Error("principal_revoked");
      original(proof, owner, at);
    };
    r.beforeTransaction = () => {
      revoked = true;
    };
    const count = r.commits;
    await expect(
      write(r, expected, "begin", attemptCommand(r, expected, "begin")),
    ).rejects.toThrow("principal_revoked");
    expect(r.commits).toBe(count);
  });

  it.each(["prepared", "in_flight", "no_effect"] as const)(
    "rejects invalid new commands from %s instead of resetting an attempt",
    async (status) => {
      const r = new SerializedForkRepository();
      let expected =
        status === "in_flight" ? await begun(r) : await prepared(r);
      if (status === "no_effect")
        expected = await change(
          r,
          expected,
          "closed",
          r.evidenceFor(expected, noEffect),
        );
      const kind = status === "prepared" ? "retry" : "begin";
      const count = r.commits;
      await expect(
        write(r, expected, "invalid", attemptCommand(r, expected, kind)),
      ).rejects.toThrow();
      expect(r.commits).toBe(count);
    },
  );

  it.each(["stale", "cancelled", "sealed"] as const)(
    "cannot begin a prepared effect after %s",
    async (guard) => {
      const r = new SerializedForkRepository();
      let expected = await prepared(r);
      const effectKey = stateOf(r, expected).request.effect.effectKey;
      expected = await change(
        r,
        expected,
        "guard",
        guard === "sealed"
          ? { kind: "seal", effectKey }
          : { kind: "stop", effectKey, reason: guard },
      );
      const count = r.commits;
      await expect(
        write(r, expected, "begin", { kind: "begin", effectKey }),
      ).rejects.toThrow();
      expect(r.commits).toBe(count);
    },
  );

  it("captures nested request bytes before the repository yields", async () => {
    const r = new SerializedForkRepository();
    const expected = await acquired(r);
    const request = copy(provider);
    r.beforeTransaction = () => {
      request.facts.settingsHash = h(95);
    };
    const result = await write(r, expected, "prepare", {
      kind: "prepare",
      request,
    });
    expect(stateOf(r, result).request.facts).toEqual(provider.facts);
  });
});
