import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  coldHistoryFixture,
  controlledColdSource,
  copy,
  h,
} from "./support/certified-fork-cold-history.js";

type Mutable<T> = T extends readonly (infer E)[]
  ? Mutable<E>[]
  : T extends object
    ? { -readonly [K in keyof T]: Mutable<T[K]> }
    : T;
type Disk = Mutable<Awaited<ReturnType<typeof coldHistoryFixture>>["disk"]>;
let fixture: Awaited<ReturnType<typeof coldHistoryFixture>>;
beforeAll(async () => {
  fixture = await coldHistoryFixture();
});

describe("constructor-driven cold Fork history", () => {
  it("replays full nonempty history in a cold registry with original admission and owners", async () => {
    vi.resetModules();
    const { authentic } =
      await import("../domain/certified-fork-effect-canonical.js");
    expect(() => authentic("review", fixture.warmState)).toThrow();
    const serialized = fixture.disk.versions.find(
      (v) => v.snapshot.checkpoint!.state.outcome !== null,
    )!.snapshot.checkpoint!.state;
    expect(() => authentic("state", serialized.states[0]!)).toThrow();
    expect(() => authentic("output", serialized.inventory!.output!)).toThrow();
    expect(() => authentic("outcome", serialized.outcome!)).toThrow();
    const { restoreCertifiedForkCheckpoint } =
      await import("../infrastructure/proofs/restore-certified-fork-checkpoint.js");
    const result = await restoreCertifiedForkCheckpoint(
      controlledColdSource(copy(fixture.disk)),
      fixture.familyKey,
    );
    expect(result.versions).toHaveLength(fixture.disk.versions.length);
    for (const { archive, state } of result.versions) {
      expect(state).toEqual(archive.snapshot.checkpoint!.state);
      expect(authentic("review", state.review)).toBe(state.review);
      for (const s of state.states) {
        authentic("state", s);
        authentic("request", s.request);
        authentic("review", s.request.review);
        authentic("effect", s.request.effect);
        authentic("authority", s.authority);
        for (const attempt of s.attempts)
          for (const e of attempt.evidence) authentic("evidence", e);
      }
      if (state.inventory) {
        authentic("inventory", state.inventory);
        authentic("output", state.inventory.output!);
        authentic("durability", state.inventory.durability!);
        state.inventory.entries.forEach((e) => authentic("request", e.request));
      }
      if (state.outcome) {
        authentic("outcome", state.outcome);
        authentic("inventory", state.outcome.inventory);
        state.outcome.states.forEach((s) => authentic("state", s));
        expect(state.outcome.status).toBe("completed");
      }
    }
    const tip = result.versions.at(-1)!;
    expect(tip.state.review.facts.generation).toBe("2");
    expect(tip.archive.snapshot.seed.admissionHash).toBe(h(82));
    expect(tip.state.review.admissionHash).not.toBe(h(82));
    const duplicate = result.versions.find(
      (v) => v.archive.snapshot.version === fixture.duplicateVersion,
    )!;
    const previous = result.versions[Number(fixture.duplicateVersion) - 2]!;
    expect(duplicate.archive.snapshot.events.length).toBeGreaterThan(32);
    expect(duplicate.archive.snapshot.events).toEqual(
      previous.archive.snapshot.events,
    );
    expect(duplicate.state).toEqual(previous.state);
    expect(duplicate.archive.snapshot.checkpoint!.anchorHash).not.toBe(
      previous.archive.snapshot.checkpoint!.anchorHash,
    );
    const duplicates = result.versions.filter((v) =>
      v.archive.receipt.commandId.startsWith("duplicate-"),
    );
    expect(duplicates.map((v) => v.archive.receipt.ownerHash)).toEqual([
      h(20),
      h(21),
    ]);
    for (const v of duplicates) {
      const prior = result.versions[Number(v.archive.snapshot.version) - 2]!;
      expect(v.archive.snapshot.events).toEqual(prior.archive.snapshot.events);
      expect(v.state).toEqual(prior.state);
      const command = Object.values(fixture.disk.facts).find(
        (f) =>
          f.kind === "command" &&
          f.payload.commandId === v.archive.receipt.commandId,
      )!;
      expect(
        command.kind === "command" && command.payload.authorityProofs,
      ).toEqual([]);
    }
    expect(duplicate.archive.receipt.ownerHash).toBe(h(21));
    expect(duplicate.state.states[0]!.authority.ownerHash).toBe(h(20));
    expect(() =>
      result.proofs.verifyReceipt(
        result.versions[0]!.archive.receipt,
        tip.archive.snapshot,
      ),
    ).not.toThrow();
    expect(() =>
      result.proofs.verifyReceipt(
        { ...result.versions[0]!.archive.receipt, ownerHash: h(21) },
        tip.archive.snapshot,
      ),
    ).toThrow();
  });
  it("replays no-effect retry, unknown recovery, conflict and unavailable outcome correction", async () => {
    const conflict = await coldHistoryFixture({ conflict: true });
    vi.resetModules();
    const { restoreCertifiedForkCheckpoint } =
      await import("../infrastructure/proofs/restore-certified-fork-checkpoint.js");
    const result = await restoreCertifiedForkCheckpoint(
      controlledColdSource(conflict.disk),
      conflict.familyKey,
    );
    const tip = result.versions.at(-1)!.state;
    const provider = tip.states.find(
      (s) => s.request.effect.slot.stage === "provider",
    )!;
    expect(provider.attempts.map((a) => a.status)).toEqual([
      "no_effect",
      "unknown",
    ]);
    expect(provider.attempts[1]!.evidence.map((e) => e.kind).sort()).toEqual([
      "conflict",
      "success",
      "unknown",
    ]);
    expect(provider.integrityHold).toBe(true);
    expect(tip.outcome!.status).toBe("unresolved");
    expect(tip.outcome!.outputAvailability).toBe("unavailable");
    expect(tip.outcome!.predecessorHash).toBe(
      result.versions.at(-3)!.state.outcome!.outcomeHash,
    );
  });

  it("keeps immutable version baselines and matches complete caller bytes before restoration", async () => {
    const { restoreCertifiedForkCheckpoint } =
      await import("../infrastructure/proofs/restore-certified-fork-checkpoint.js");
    const result = await restoreCertifiedForkCheckpoint(
      controlledColdSource(fixture.disk),
      fixture.familyKey,
    );
    const version = result.versions.find((v) => v.state.outcome !== null)!;
    const first = result.versions[0]!;
    expect(first.state.states).toHaveLength(0);
    expect(version.state.states).toHaveLength(2);
    const restored = result.proofs.restoreCheckpoint(
      copy(version.archive.snapshot.checkpoint!),
      copy(version.archive.snapshot),
    );
    expect(restored).toBe(version.state);
    expect(Object.isFrozen(restored)).toBe(true);
    expect(Object.isFrozen(restored.states)).toBe(true);
    expect(Object.isFrozen(version.archive.snapshot.events)).toBe(true);
    const changed: Mutable<typeof version.archive.snapshot> = copy(
      version.archive.snapshot,
    ) as Mutable<typeof version.archive.snapshot>;
    changed.checkpoint!.state.states[0]!.attempts[0]!.originOwnerHash = h(99);
    expect(() => result.proofs.verifyLedger(changed)).toThrow();
    expect(() =>
      result.proofs.restoreCheckpoint(
        changed.checkpoint!,
        version.archive.snapshot,
      ),
    ).toThrow();
    expect(Object.keys(result.proofs).sort()).toEqual([
      "predecessor",
      "restoreCheckpoint",
      "verifyLedger",
      "verifyReceipt",
    ]);
    const next = result.versions.find(
      (v) => v.state.review.facts.generation === "1",
    )!;
    const predecessor = result.proofs.predecessor(
      next.archive.snapshot.seed.predecessor!,
    );
    expect(predecessor.checkpoint!.state.outcome!.status).toBe("completed");
    expect(() =>
      result.proofs.verifyReceipt(next.archive.receipt, first.archive.snapshot),
    ).toThrow();
    expect(() => result.proofs.predecessor("legacy-predecessor")).toThrow();
  });

  it("requires authenticated source producers and does not interpret expiry as present permission", async () => {
    const { restoreCertifiedForkCheckpoint } =
      await import("../infrastructure/proofs/restore-certified-fork-checkpoint.js");
    const source = controlledColdSource(fixture.disk);
    const opened = await source.open(fixture.familyKey);
    const missing = {
      open: async () => ({
        ...opened,
        authority: async () => {
          throw new Error("producer_not_implemented");
        },
      }),
    };
    await expect(
      restoreCertifiedForkCheckpoint(missing, fixture.familyKey),
    ).rejects.toThrow("producer_not_implemented");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2099-01-01"));
    try {
      const result = await restoreCertifiedForkCheckpoint(
        source,
        fixture.familyKey,
      );
      expect(result.versions.at(-1)!.state.review.facts.generation).toBe("2");
    } finally {
      vi.useRealTimers();
    }
  });

  const changes: [string, (disk: Disk) => void][] = [
    [
      "output lacks committed read endorsement despite old commit timestamp",
      (d) => {
        for (const key of Object.keys(d.committedReads))
          d.committedReads[key] = d.committedReads[key]!.filter(
            (id) => d.facts[id]?.kind !== "output",
          );
      },
    ],
    [
      "contradictory producer source reimport",
      (d) => {
        const authorities = Object.values(d.facts).filter(
          (f) => f.kind === "authority",
        );
        authorities[1]!.provenance.sourceKey =
          authorities[0]!.provenance.sourceKey;
      },
    ],
    [
      "missing joined version",
      (d) => {
        d.versions.splice(2, 1);
      },
    ],
    [
      "reordered versions",
      (d) => {
        [d.versions[1], d.versions[2]] = [d.versions[2]!, d.versions[1]!];
      },
    ],
    [
      "duplicate command identity",
      (d) => {
        d.versions[2]!.receipt.commandId = d.versions[1]!.receipt.commandId;
      },
    ],
    [
      "missing command fact",
      (d) => {
        const key = Object.keys(d.facts).find(
          (k) => d.facts[k]!.kind === "command",
        )!;
        delete d.facts[key];
      },
    ],
    [
      "unsupported producer version",
      (d) => {
        Object.values(d.facts).find(
          (f) => f.kind === "authority",
        )!.provenance.producerVersion = "legacy";
      },
    ],
    [
      "cross-scope evidence",
      (d) => {
        Object.values(d.facts).find(
          (f) => f.kind === "evidence",
        )!.scope.reviewHash = h(99);
      },
    ],
    [
      "wrong proof kind",
      (d) => {
        const e = Object.values(d.facts).find((f) => f.kind === "evidence")!;
        d.facts[e.proofId] = {
          ...Object.values(d.facts).find((f) => f.kind === "output")!,
          proofId: e.proofId,
        };
      },
    ],
    [
      "nonempty prefix truncated with recomputed hashes",
      (d) => {
        d.versions[4]!.snapshot.events.shift();
      },
    ],
    [
      "event reordered with recomputed hashes",
      (d) => {
        d.versions[4]!.snapshot.events.reverse();
      },
    ],
    [
      "new event changed with recomputed hashes",
      (d) => {
        const e = d.versions[2]!.snapshot.events.at(-1)!;
        if (e.input.kind === "begin") e.input.kind = "retry";
      },
    ],
    [
      "event transaction time substituted",
      (d) => {
        d.versions[2]!.snapshot.events.at(-1)!.at++;
      },
    ],
    [
      "receipt owner changed",
      (d) => {
        d.versions[0]!.receipt.ownerHash = h(21);
      },
    ],
    [
      "command preimage recomputed",
      (d) => {
        const f = Object.values(d.facts).find((f) => f.kind === "command")!;
        if (f.kind === "command") {
          const data = f.payload.preimage.data as { ttlMs: number };
          data.ttlMs++;
        }
      },
    ],
    [
      "ordered command authority references removed",
      (d) => {
        const f = Object.values(d.facts).find(
          (f) => f.kind === "command" && f.payload.authorityProofs.length,
        )!;
        if (f.kind === "command") f.payload.authorityProofs = [];
      },
    ],
    [
      "command predecessor comparison altered",
      (d) => {
        const f = Object.values(d.facts).find(
          (f) => f.kind === "command" && f.payload.comparison,
        )!;
        if (f.kind === "command") f.payload.comparison!.fence = "99";
      },
    ],
    [
      "authority original mode changed",
      (d) => {
        const f = Object.values(d.facts).find((f) => f.kind === "authority")!;
        if (f.kind === "authority") f.payload.authority.mode = "reconcile";
      },
    ],
    [
      "authority claim owner changed",
      (d) => {
        const f = Object.values(d.facts).find((f) => f.kind === "authority")!;
        if (f.kind === "authority") f.payload.authority.ownerHash = h(99);
      },
    ],
    [
      "authority original expiry changed",
      (d) => {
        const f = Object.values(d.facts).find((f) => f.kind === "authority")!;
        if (f.kind === "authority") f.payload.expiresAtMs++;
      },
    ],
    [
      "evidence authority edge changed",
      (d) => {
        const f = Object.values(d.facts).find((f) => f.kind === "evidence")!;
        if (f.kind === "evidence") f.payload.authorityProof = "other-authority";
      },
    ],
    [
      "evidence original owner changed",
      (d) => {
        const f = Object.values(d.facts).find((f) => f.kind === "evidence")!;
        if (f.kind === "evidence")
          f.payload.originalScope.originOwnerHash = h(99);
      },
    ],
    [
      "source sender closure not authenticated",
      (d) => {
        const f = Object.values(d.facts).find((f) => f.kind === "evidence")!;
        if (f.kind === "evidence") f.payload.senderClosure.testClosed = false;
      },
    ],
    [
      "inventory omitted publication",
      (d) => {
        const f = Object.values(d.facts).find((f) => f.kind === "inventory")!;
        if (f.kind === "inventory") {
          f.payload.plan.pop();
          f.payload.expectedEffectKeys.pop();
        }
      },
    ],
    [
      "inventory changed dependency",
      (d) => {
        const f = Object.values(d.facts).find((f) => f.kind === "inventory")!;
        if (f.kind === "inventory") f.payload.dependencies = [];
      },
    ],
    [
      "output bytes changed despite retained hashes",
      (d) => {
        const f = Object.values(d.facts).find((f) => f.kind === "output")!;
        if (f.kind === "output") f.payload.outputBytes += " ";
      },
    ],
    [
      "output packet paths changed",
      (d) => {
        const f = Object.values(d.facts).find((f) => f.kind === "output")!;
        if (f.kind === "output") f.payload.filePaths.push("extra.ts");
      },
    ],
    [
      "output success edge missing",
      (d) => {
        const f = Object.values(d.facts).find((f) => f.kind === "output")!;
        if (f.kind === "output")
          f.payload.successEvidenceProof = "missing-success";
      },
    ],
    [
      "original admission plan omitted",
      (d) => {
        const f = d.facts["admission-0"]!;
        if (f.kind === "admission") f.payload.requests = [];
      },
    ],
    [
      "generation original admission replaced by derived hash",
      (d) => {
        const v = d.versions.find(
          (v) => v.snapshot.seed.facts.generation === "1",
        )!;
        v.snapshot.seed.admissionHash =
          v.snapshot.checkpoint!.state.review.admissionHash;
      },
    ],
    [
      "predecessor self cycle",
      (d) => {
        const f = d.facts["admission-1"]!;
        if (f.kind === "admission")
          f.payload.predecessor!.version = d.versions.at(-1)!.snapshot.version;
      },
    ],
    [
      "checkpoint command position absent",
      (d) => {
        d.versions[1]!.snapshot.checkpoint!.position = null;
      },
    ],
    [
      "checkpoint state omitted on eventless renew",
      (d) => {
        const v = d.versions.find((v) => v.operation === "renewClaim")!;
        v.snapshot.checkpoint!.state.states = [];
      },
    ],
  ];
  const nestedChanges: [
    string,
    (
      s: Mutable<
        NonNullable<Disk["versions"][number]["snapshot"]["checkpoint"]>["state"]
      >,
    ) => void,
  ][] = [
    [
      "request review",
      (s) => {
        s.states[0]!.request.review.bindingHash = h(99);
      },
    ],
    [
      "request effect",
      (s) => {
        s.states[0]!.request.effect.logicalKey = h(99);
      },
    ],
    [
      "attempt origin",
      (s) => {
        s.states[0]!.attempts[0]!.originOwnerHash = h(99);
      },
    ],
    [
      "attempt evidence",
      (s) => {
        s.states[0]!.attempts[0]!.evidence[0]!.authorityHash = h(99);
      },
    ],
    [
      "authority revision",
      (s) => {
        s.states[0]!.authority.revision = "99";
      },
    ],
    [
      "state hold",
      (s) => {
        s.states[0]!.integrityHold = true;
      },
    ],
    [
      "state seal",
      (s) => {
        s.states[0]!.sealed = false;
      },
    ],
    [
      "state stops",
      (s) => {
        s.states[0]!.stops = ["stale"];
      },
    ],
    [
      "omitted sibling",
      (s) => {
        s.states.pop();
      },
    ],
    [
      "inventory request",
      (s) => {
        s.inventory!.entries[0]!.request.contextHash = h(99);
      },
    ],
    [
      "inventory output",
      (s) => {
        s.inventory!.output!.successEvidenceHash = h(99);
      },
    ],
    [
      "inventory durability",
      (s) => {
        s.inventory!.durability!.commitReceiptHash = h(99);
      },
    ],
    [
      "outcome nested state",
      (s) => {
        s.outcome!.states[0]!.attempts = [];
      },
    ],
    [
      "outcome status",
      (s) => {
        s.outcome!.status = "unresolved";
      },
    ],
    [
      "outcome predecessor",
      (s) => {
        s.outcome!.predecessorHash = h(99);
      },
    ],
  ];
  for (const [name, change] of nestedChanges)
    changes.push([
      `nested ${name}`,
      (disk) => {
        const v = disk.versions.find(
          (v) => v.snapshot.checkpoint?.state.outcome !== null,
        )!;
        change(v.snapshot.checkpoint!.state);
      },
    ]);
  it.each(changes)(
    "rejects %s, including recomputed archive/command hashes",
    async (_name, change) => {
      const disk = copy(fixture.disk) as Disk;
      change(disk);
      const l =
        await import("../application/services/certified-fork-effect-ledger.js");
      const codec =
        await import("../infrastructure/prisma/certified-fork-archive-codec.js");
      const { restoreCertifiedForkCheckpoint } =
        await import("../infrastructure/proofs/restore-certified-fork-checkpoint.js");
      // Simulate a syntactically valid protected test writer retaining corruption:
      // recompute all affected root hashes rather than relying on digest mismatch.
      for (const v of disk.versions) {
        const cp = v.snapshot.checkpoint!;
        const command = Object.values(disk.facts).find(
          (f) =>
            f.kind === "command" && f.payload.version === v.snapshot.version,
        );
        if (command?.kind === "command") {
          const p = command.payload.preimage;
          const hash = l.commandHash(String(p.operation), p.data);
          v.receipt.commandHash = hash;
          command.payload.commandHash = hash;
          if (cp.position) cp.position.commandHash = hash;
        }
        cp.anchorHash = l.checkpointAnchor(v.snapshot);
        cp.prefixLength = v.snapshot.events.length;
        cp.prefixHash = l.forkLedgerHash(v.snapshot);
        if (cp.position)
          v.comparison = copy(
            codec.checkpointComparison(v.snapshot),
          ) as Mutable<typeof v.comparison>;
      }
      await expect(
        restoreCertifiedForkCheckpoint(
          controlledColdSource(disk),
          fixture.familyKey,
        ),
      ).rejects.toThrow();
    },
  );
});

describe("r109 supported application histories", () => {
  let released: Awaited<ReturnType<typeof coldHistoryFixture>>;
  let expired: typeof released;
  let conflict: typeof released;
  beforeAll(async () => {
    released = await coldHistoryFixture({ refresh: "release", aliases: true });
    expired = await coldHistoryFixture({ refresh: "expiry", aliases: true });
    conflict = await coldHistoryFixture({
      conflict: true,
      retainedConflict: true,
      aliases: true,
    });
  }, 20000);

  async function restore(disk: typeof fixture.disk) {
    const { restoreCertifiedForkCheckpoint } =
      await import("../infrastructure/proofs/restore-certified-fork-checkpoint.js");
    return restoreCertifiedForkCheckpoint(
      controlledColdSource(disk),
      fixture.familyKey,
    );
  }
  it.each(["release", "expiry"] as const)(
    "restores %s refresh in zero/nonzero generations, aliases and old receipts",
    async (mode) => {
      const f = mode === "release" ? released : expired;
      vi.resetModules();
      const { authentic } =
        await import("../domain/certified-fork-effect-canonical.js");
      const result = await restore(f.disk);
      for (const v of result.versions) {
        expect(v.state).toEqual(v.archive.snapshot.checkpoint!.state);
        authentic("review", v.state.review);
        expect(Object.isFrozen(v.state.states)).toBe(true);
        for (const state of v.state.states) {
          authentic("state", state);
          authentic("request", state.request);
          authentic("effect", state.request.effect);
          authentic("authority", state.authority);
          for (const attempt of state.attempts)
            for (const e of attempt.evidence) authentic("evidence", e);
        }
      }
      const acquisitions = result.versions.filter(
        (v) =>
          v.archive.operation === "acquireClaim" &&
          v.archive.snapshot.admissionProof.startsWith("admission-refreshed"),
      );
      expect(acquisitions.map((v) => v.state.review.facts.generation)).toEqual([
        "0",
        "1",
      ]);
      expect(acquisitions.map((v) => v.archive.receipt.ownerHash)).toEqual([
        h(21),
        h(22),
      ]);
      for (const v of acquisitions) {
        const prior = result.versions[Number(v.archive.snapshot.version) - 2]!;
        expect(v.archive.snapshot.seed).toEqual(prior.archive.snapshot.seed);
        expect(v.state).toEqual(prior.state);
        if (mode === "expiry")
          expect(prior.archive.snapshot.claim!.expiresAt).toBeLessThanOrEqual(
            v.archive.committedAt,
          );
        else expect(prior.archive.snapshot.claim).toBeNull();
      }
      const duplicates = result.versions.filter((v) =>
        v.archive.receipt.commandId.startsWith("duplicate-"),
      );
      expect(duplicates.map((v) => v.archive.receipt.ownerHash)).toEqual([
        h(20),
        h(21),
        h(21),
        h(22),
      ]);
      for (const v of duplicates) {
        const prior = result.versions[Number(v.archive.snapshot.version) - 2]!;
        expect(v.state).toEqual(prior.state);
        expect(v.archive.snapshot.events).toEqual(
          prior.archive.snapshot.events,
        );
        expect(v.archive.snapshot.checkpoint!.anchorHash).not.toBe(
          prior.archive.snapshot.checkpoint!.anchorHash,
        );
        result.proofs.verifyReceipt(
          v.archive.receipt,
          result.versions.at(-1)!.archive.snapshot,
        );
      }
      result.proofs.verifyReceipt(
        result.versions[0]!.archive.receipt,
        result.versions.at(-1)!.archive.snapshot,
      );
      const { claimCertifiedForkReview } =
        await import("../application/use-cases/claim-certified-fork-review.js");
      const unavailable = () => {
        throw new Error("unexpected current mutation");
      };
      const ownership = vi.fn((_proof: string, owner: string) =>
        expect(owner).toBe(h(20)),
      );
      const original = result.versions[0]!.archive;
      const recovery = await claimCertifiedForkReview(
        {
          enabled: true,
          ownerProof: "current-original-owner",
          proofs: {
            ...result.proofs,
            ownership,
            admission: unavailable,
            authorize: unavailable,
            mutation: unavailable,
            authority: unavailable,
            evidence: unavailable,
            inventory: unavailable,
            durability: unavailable,
            retainedOutput: unavailable,
            issueCheckpoint: unavailable,
          },
          repository: {
            loadReview: async () => ({
              snapshot: result.versions.at(-1)!.archive.snapshot,
              receipt: original.receipt,
            }),
            acquireClaim: unavailable,
            renewClaim: unavailable,
            releaseClaim: unavailable,
            compareAndCommit: unavailable,
          },
        },
        {
          seed: original.snapshot.seed,
          admissionProof: original.snapshot.admissionProof,
          ownerHash: h(20),
          ttlMs: 120_000,
          commandId: original.receipt.commandId,
        },
      );
      expect(recovery.status).toBe("reconciliation_required");
      expect(ownership).toHaveBeenCalledOnce();
      expect(f.disk.facts["admission-0"]).toEqual(
        fixture.disk.facts["admission-0"],
      );
      expect(f.disk.facts["admission-1"]!.proofId).toBe("admission-1");
    },
  );
  it("restores frozen retained bytes after conflict through the actual outcome writer", async () => {
    vi.resetModules();
    const { authentic } =
      await import("../domain/certified-fork-effect-canonical.js");
    const result = await restore(conflict.disk);
    const tip = result.versions.at(-1)!.state;
    expect(tip.outcome!.status).toBe("unresolved");
    expect(tip.outcome!.outputAvailability).toBe("available");
    expect(tip.inventory!.output).toEqual(
      result.versions.at(-3)!.state.inventory!.output,
    );
    authentic("outcome", tip.outcome!);
    authentic("inventory", tip.outcome!.inventory);
    authentic("output", tip.outcome!.inventory.output!);
    authentic("durability", tip.outcome!.inventory.durability!);
    for (const state of tip.outcome!.states) {
      authentic("state", state);
      authentic("request", state.request);
      authentic("review", state.request.review);
      authentic("effect", state.request.effect);
      authentic("authority", state.authority);
      for (const attempt of state.attempts)
        for (const e of attempt.evidence) authentic("evidence", e);
    }
    for (const v of result.versions)
      expect(v.state).toEqual(v.archive.snapshot.checkpoint!.state);
  });

  const aliasChanges: [string, (d: Disk, key: string) => void][] = [
    [
      "different evidence",
      (d, k) => {
        const f = d.facts[k]!;
        if (f.kind === "evidence") f.payload.evidence.evidenceHash = h(999);
      },
    ],
    ...[
      "requestHash",
      "effectKey",
      "originClaimHash",
      "originOwnerHash",
      "remoteScopeHash",
    ].map(
      (field) =>
        [
          "changed original " + field,
          (d: Disk, k: string) => {
            const f = d.facts[k]!;
            if (f.kind === "evidence") f.payload.originalScope[field] = h(999);
          },
        ] as [string, (d: Disk, k: string) => void],
    ),
    [
      "changed original attempt",
      (d, k) => {
        const f = d.facts[k]!;
        if (f.kind === "evidence") f.payload.originalScope.attempt = "99";
      },
    ],
    [
      "changed original epoch",
      (d, k) => {
        const f = d.facts[k]!;
        if (f.kind === "evidence") f.payload.originalScope.originEpoch = "99";
      },
    ],
    [
      "dangling authority",
      (d, k) => {
        const f = d.facts[k]!;
        if (f.kind === "evidence") f.payload.authorityProof = "missing";
      },
    ],
    [
      "substituted authority",
      (d, k) => {
        const f = d.facts[k]!;
        if (f.kind === "evidence")
          f.payload.authorityProof = Object.values(d.facts).find(
            (x) => x.kind === "authority",
          )!.proofId;
      },
    ],
    [
      "cross scope",
      (d, k) => {
        d.facts[k]!.scope.reviewHash = h(999);
      },
    ],
    [
      "unauthenticated receipt",
      (d, k) => {
        const f = d.facts[k]!;
        if (f.kind === "evidence") f.payload.response.testAuthenticated = false;
      },
    ],
    [
      "authority original command substituted",
      (d, k) => {
        const f = d.facts[k]!;
        if (f.kind !== "evidence") return;
        const a = copy(d.facts[f.payload.authorityProof]!);
        a.proofId = "authority-alias";
        a.provenance.sourceKey = a.proofId;
        if (a.kind === "authority") a.payload.commandId = "substituted-command";
        d.facts[a.proofId] = a;
        f.payload.authorityProof = a.proofId;
      },
    ],
  ];
  for (const field of [
    "transactionTimeMs",
    "expiresAtMs",
    "fence",
    "version",
    "admissionProof",
    "principal",
    "claim",
  ]) {
    aliasChanges.push([
      `authority ${field} substituted`,
      (d, k) => {
        const f = d.facts[k]!;
        if (f.kind !== "evidence") return;
        const a = copy(d.facts[f.payload.authorityProof]!);
        a.proofId = "authority-alias";
        a.provenance.sourceKey = a.proofId;
        if (a.kind === "authority") {
          const payload = a.payload as Record<string, unknown>;
          payload[field] = field.endsWith("Ms")
            ? 999
            : field === "claim" || field === "principal"
              ? { ownerHash: h(999) }
              : "999";
        }
        d.facts[a.proofId] = a;
        f.payload.authorityProof = a.proofId;
      },
    ]);
  }
  it("resolves distinct authenticated authority records with identical original closure", async () => {
    const d = copy(released.disk) as Disk;
    for (const k of Object.keys(d.facts).filter(
      (k) =>
        k.startsWith("duplicate-alias-") ||
        k.startsWith("output-success-alias-"),
    )) {
      const f = d.facts[k]!;
      if (f.kind !== "evidence") continue;
      const a = copy(d.facts[f.payload.authorityProof]!);
      a.proofId = `authority-for-${k}`;
      a.provenance.sourceKey = a.proofId;
      d.facts[a.proofId] = a;
      f.payload.authorityProof = a.proofId;
    }
    const result = await restore(d);
    for (const v of result.versions)
      expect(v.state).toEqual(v.archive.snapshot.checkpoint!.state);
  });
  for (const prefix of ["duplicate-alias-", "output-success-alias-"]) {
    it.each(aliasChanges)(`rejects ${prefix} %s`, async (_name, change) => {
      const disk = copy(released.disk) as Disk;
      const key = Object.keys(disk.facts).find((k) => k.startsWith(prefix))!;
      change(disk, key);
      await expect(restore(disk)).rejects.toThrow();
    });
  }
  it.each(["bytes", "commitment", "success", "endorsement"])(
    "rejects later retained output %s substitution",
    async (kind) => {
      const disk = copy(conflict.disk) as Disk;
      const source = controlledColdSource(disk);
      const opened = await source.open(conflict.familyKey);
      const last = disk.versions.at(-1)!;
      const { historicalForkCommandReference, restoreCertifiedForkCheckpoint } =
        await import("../infrastructure/proofs/restore-certified-fork-checkpoint.js");
      const ref = historicalForkCommandReference(
        conflict.familyKey,
        last.snapshot.version,
        last.receipt.commandId,
      );
      if (kind === "endorsement") disk.committedReads[ref] = [];
      await expect(
        restoreCertifiedForkCheckpoint(
          {
            open: async () => ({
              ...opened,
              output: async (scope, proof, command) => {
                const resolved = await opened.output(scope, proof, command);
                if (command === ref) {
                  const f = copy(resolved.fact) as Mutable<
                    typeof resolved.fact
                  >;
                  if (kind === "bytes") f.payload.outputBytes += " ";
                  if (kind === "commitment")
                    f.payload.outputCommitmentHash = h(999);
                  if (kind === "success")
                    f.payload.successEvidenceProof = "publication-success-0";
                  return { fact: f };
                }
                return resolved;
              },
            }),
          },
          conflict.familyKey,
        ),
      ).rejects.toThrow();
    },
  );
  it.each(["review", "request", "forged"])(
    "rejects refreshed admission %s",
    async (kind) => {
      const d = copy(released.disk) as Disk;
      const f = d.facts["admission-refreshed-1"]!;
      if (f.kind === "admission") {
        if (kind === "review") f.payload.seed.bindingHash = h(999);
        if (kind === "request")
          (
            (f.payload.requests[0] as Record<string, unknown>).facts as Record<
              string,
              unknown
            >
          ).modelHash = h(999);
        if (kind === "forged") f.provenance.producerVersion = "forged";
      }
      await expect(restore(d)).rejects.toThrow();
    },
  );
  it("rejects an admission switch on renew even with recomputed checkpoint anchor", async () => {
    const d = copy(released.disk) as Disk;
    const index = d.versions.findIndex(
      (v) =>
        v.operation === "renewClaim" &&
        v.snapshot.admissionProof === "admission-refreshed-0",
    );
    d.versions.splice(index + 1);
    const v = d.versions.at(-1)!;
    v.snapshot.admissionProof = "admission-0";
    const command = Object.values(d.facts).find(
      (f) => f.kind === "command" && f.payload.version === v.snapshot.version,
    )!;
    if (command.kind === "command")
      command.payload.admissionProof = "admission-0";
    const { checkpointAnchor } =
      await import("../application/services/certified-fork-effect-ledger.js");
    v.snapshot.checkpoint!.anchorHash = checkpointAnchor(v.snapshot);
    await expect(restore(d)).rejects.toThrow();
  });
});
