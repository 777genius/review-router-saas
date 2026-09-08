import {
  reconcileCertifiedForkEffect,
  type ForkReconciliationInput,
} from "../../application/use-cases/reconcile-certified-fork-effect.js";
import { manageCertifiedForkClaim } from "../../application/use-cases/claim-certified-fork-review.js";
import {
  fingerprint,
  next,
  requireFact,
  artifact,
  authentic,
} from "../../domain/certified-fork-effect-canonical.js";
import {
  createForkEffect,
  createForkRequest,
  type ForkRequest,
} from "../../domain/certified-fork-effect-identity.js";
import {
  forkAuthorityHash,
  createForkStateVerifier,
  type ForkAuthority,
  type ForkEvidence,
  type ForkEffectState,
} from "../../domain/certified-fork-effect-state.js";
import type { ForkInventory } from "../../domain/certified-fork-effect-outcome.js";
import type {
  CertifiedForkEffectProofPort,
  ForkAuthorityContext,
  ForkCheckpoint,
  ForkCheckpointState,
} from "../../application/ports/certified-fork-effect-proof-port.js";
import type {
  CertifiedForkEffectRepositoryPort,
  ForkCommandReceipt,
  ForkLedgerInput,
  ForkLedgerSnapshot,
  ForkLoadedReview,
  ForkReviewSeed,
  ForkTransaction,
  ForkComparison,
} from "../../application/ports/certified-fork-effect-repository-port.js";
import {
  applyForkEvent,
  comparison,
  currentClaim,
  forkLedgerHash,
  checkpointAnchor,
  checkpointState,
  rebuildReview,
  replayForkLedger,
  type ForkRebuiltLedger,
  type ForkBoundaryResult,
} from "../../application/services/certified-fork-effect-ledger.js";

export const h = (n: number) => n.toString(16).padStart(64, "0");
export const seed: ForkReviewSeed = {
  facts: {
    workspaceId: "tenant",
    repositoryId: "repository",
    sourceRepositoryId: "fork",
    baseRepositoryId: "base",
    pullRequest: 1,
    headSha: "a".repeat(40),
    baseSha: "b".repeat(40),
    trustDomain: "fork",
    generation: "0",
  },
  bindingHash: h(1),
  admissionHash: null,
  predecessor: null,
};
export const provider = {
  slot: { stage: "provider", role: "review", slot: 1 } as const,
  facts: {
    contextHash: h(2),
    adapterContractHash: h(3),
    schemaHash: h(4),
    providerInstanceId: "provider",
    accountScopeHash: h(5),
    modelHash: h(6),
    settingsHash: h(7),
    trustedInstructionsHash: h(8),
    effectiveInputHash: h(9),
    toolsOutputSchemaHash: h(10),
    executionPolicyHash: h(11),
  },
};
export const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
type AuthorityRecord = { facts: ForkAuthority; at: number; expiresAt: number };
type Disk = {
  rows: Record<string, ForkLedgerSnapshot>;
  receipts: Record<string, ForkCommandReceipt>;
  seals: string[];
  admissions: Record<string, string>;
  authorities: Record<string, AuthorityRecord>;
  evidence: Record<string, ForkEvidence>;
  predecessors: Record<string, ForkLedgerSnapshot>;
  inventory: Record<string, string[]>;
  owners: Record<string, string>;
  checkpoints: Record<string, ForkCheckpoint>;
  comparisons: Record<string, ForkComparison>;
};
/** Deterministic serialized transaction model ONLY, not a database serialization
 * proof. Disk includes a simulated trusted proof archive, distinct from load DTOs.
 * Tests may corrupt DTOs but do not possess authority to re-sign the archive.
 */
export class SerializedForkRepository implements CertifiedForkEffectRepositoryPort {
  now = 100;
  calls = 0;
  proofCalls = 0;
  replayVerificationsInTransaction = 0;
  private inTransaction = false;
  private pendingCheckpoints = new Map<string, ForkCheckpoint>();
  commits = 0;
  fault: "before_commit" | "lost_ack" | null = null;
  admissionCurrent = true;
  currentProvider = provider.facts;
  beforeTransaction: (() => void) | null = null;
  private queue: Promise<void> = Promise.resolve();
  private disk: Disk;
  constructor(serialized?: string) {
    this.disk = serialized
      ? JSON.parse(serialized)
      : {
          rows: {},
          receipts: {},
          seals: [],
          admissions: {},
          authorities: {},
          evidence: {},
          predecessors: {},
          inventory: {},
          owners: {},
          checkpoints: {},
          comparisons: {},
        };
  }
  serialize() {
    return JSON.stringify(this.disk);
  }
  restart() {
    const restarted = new SerializedForkRepository(this.serialize());
    restarted.now = this.now;
    restarted.admissionCurrent = this.admissionCurrent;
    restarted.currentProvider = this.currentProvider;
    return restarted;
  }
  get dependencies() {
    return {
      enabled: true,
      repository: this,
      proofs: this.proofs,
      ownerProof: this.ownerProof(h(20)),
    };
  }
  ownerProof(ownerHash: string) {
    const token = fingerprint("test-owner-session", ownerHash);
    this.disk.owners[token] = ownerHash;
    return token;
  }
  asOwner(ownerHash: string) {
    return { ...this.dependencies, ownerProof: this.ownerProof(ownerHash) };
  }
  private stamp(snapshot: ForkLedgerSnapshot) {
    return fingerprint("test-durable-ledger", {
      ...snapshot,
      events: forkLedgerHash(snapshot),
    });
  }
  private sign(snapshot: ForkLedgerSnapshot) {
    const checkpoint = snapshot.checkpoint;
    const pending = checkpoint && this.pendingCheckpoints.get(checkpoint.proof);
    if (
      checkpoint &&
      pending &&
      fingerprint("checkpoint", pending) ===
        fingerprint("checkpoint", checkpoint)
    ) {
      this.disk.checkpoints[checkpoint.proof] = copy(pending);
      this.pendingCheckpoints.delete(checkpoint.proof);
    }
    this.disk.seals.push(this.stamp(snapshot));
  }
  private known<T>(record: Record<string, T>, key: string): T {
    this.proofCalls++;
    const value = Object.hasOwn(record, key) ? record[key] : undefined;
    requireFact(value !== undefined);
    return copy(value);
  }
  proofs: CertifiedForkEffectProofPort = {
    issueCheckpoint: (snapshot, state, position) => {
      authentic("review", state.review);
      requireFact(
        fingerprint("fork-admission", state.review) === snapshot.reviewHash &&
          state.review.familyKey === snapshot.familyKey,
      );
      state.states.forEach((s) => authentic("state", s));
      requireFact(
        new Set(state.states.map((s) => s.request.effect.effectKey)).size ===
          state.states.length,
      );
      requireFact(
        state.states.every(
          (s) =>
            fingerprint("fork-admission", s.request.review) ===
            snapshot.reviewHash,
        ),
      );
      if (state.inventory) authentic("inventory", state.inventory);
      if (state.outcome) authentic("outcome", state.outcome);
      const facts = {
        prefixLength: snapshot.events.length,
        prefixHash: forkLedgerHash(snapshot),
        anchorHash: checkpointAnchor(snapshot),
        position,
        state,
      };
      const proof = fingerprint("test-authenticated-checkpoint", facts);
      // Staged authentication is separate from committed ledger authenticity.
      const checkpoint = { ...facts, proof };
      this.pendingCheckpoints.set(proof, copy(checkpoint));
      return copy(checkpoint);
    },
    restoreCheckpoint: (checkpoint, snapshot) => {
      const trusted = this.known(this.disk.checkpoints, checkpoint.proof);
      requireFact(
        fingerprint("checkpoint", trusted) ===
          fingerprint("checkpoint", checkpoint),
      );
      requireFact(checkpoint.anchorHash === checkpointAnchor(snapshot));
      if (checkpoint.position) {
        const receipt = this.known(
          this.disk.receipts,
          snapshot.familyKey + ":" + checkpoint.position.commandId,
        );
        requireFact(
          receipt.commandHash === checkpoint.position.commandHash &&
            receipt.version === snapshot.version &&
            receipt.reviewHash === snapshot.reviewHash,
        );
      }
      return this.mintCheckpoint(trusted.state);
    },
    ownership: (proof, ownerHash) => {
      requireFact(this.known(this.disk.owners, proof) === ownerHash);
    },
    predecessor: (token) => this.known(this.disk.predecessors, token),
    verifyLedger: (snapshot) => {
      if (this.inTransaction) this.replayVerificationsInTransaction++;
      this.proofCalls++;
      requireFact(this.disk.seals.includes(this.stamp(snapshot)));
    },
    verifyReceipt: (receipt, snapshot) => {
      const stored = this.known(
        this.disk.receipts,
        snapshot.familyKey + ":" + receipt.commandId,
      );
      requireFact(
        fingerprint("receipt", stored) === fingerprint("receipt", receipt) &&
          BigInt(receipt.version) <= BigInt(snapshot.version),
      );
    },
    admission: (token, review, current, _at, requests) => {
      requireFact(
        this.known(this.disk.admissions, token) ===
          fingerprint("fork-admission", review),
      );
      requireFact(!current || this.admissionCurrent);
      if (current)
        requireFact(
          requests.every(
            (request) =>
              request.effect.slot.stage !== "provider" ||
              request.requestHash ===
                createForkRequest(
                  review,
                  createForkEffect(review, provider.slot),
                  this.currentProvider,
                ).requestHash,
          ),
        );
    },
    authorize: (context) => {
      this.proofCalls++;
      const claim = context.claim;
      requireFact(
        claim && claim.expiresAt > context.at && context.mode !== null,
      );
      const facts: ForkAuthority = {
        logicalKey: context.review.logicalKey,
        reviewHash: fingerprint("fork-admission", context.review),
        revision: context.revision,
        mode: context.mode,
        epoch: claim.epoch,
        ownerHash: claim.ownerHash,
        claimHash: claim.claimHash,
        validUntilHash: fingerprint("fork-lease-expiry", claim.expiresAt),
      };
      const record = { facts, at: context.at, expiresAt: claim.expiresAt };
      const token = fingerprint("test-issued-authority", record);
      this.disk.authorities[token] = record;
      return token;
    },
    authority: (token, context) => {
      const record = this.known(this.disk.authorities, token);
      const { facts } = record;
      requireFact(
        record.at === context.at &&
          record.expiresAt > context.at &&
          facts.reviewHash === fingerprint("fork-admission", context.review) &&
          facts.logicalKey === context.review.logicalKey &&
          facts.revision === context.revision &&
          (context.mode === null || facts.mode === context.mode),
      );
      if (context.claim)
        requireFact(
          context.claim.expiresAt > this.now &&
            facts.epoch === context.claim.epoch &&
            facts.ownerHash === context.claim.ownerHash &&
            facts.claimHash === context.claim.claimHash,
        );
      return facts;
    },
    evidence: (token) => this.known(this.disk.evidence, token),
    inventory: (token, review, requests) => {
      requireFact(
        requests.every((r) => r.review.logicalKey === review.logicalKey),
      );
      return this.known(this.disk.inventory, token);
    },
    durability: () => {
      throw new Error("no_authenticated_output_receipt");
    },
    retainedOutput: () => {
      throw new Error("output_unavailable");
    },
    mutation: (input, review) => {
      this.proofCalls++;
      if (input.kind === "evidence")
        requireFact(
          this.proofs.evidence(input.proof).logicalKey === review.logicalKey,
        );
    },
  };
  /** Only this trusted proof adapter can re-mint authenticated archived facts.
   * No caller DTO reaches artifact(); known() first checks the retained archive.
   * Re-minted historical authority is never a replacement for currentClaim/CAS.
   */
  private mintCheckpoint(data: ForkCheckpointState): ForkCheckpointState {
    const review = artifact("review", data.review);
    const request = (r: ForkRequest): ForkRequest =>
      artifact("request", {
        ...r,
        review: artifact("review", r.review),
        effect: artifact("effect", r.effect),
      });
    const state = (s: ForkEffectState): ForkEffectState =>
      artifact("state", {
        ...s,
        request: request(s.request),
        authority: artifact("authority", s.authority),
        attempts: s.attempts.map((a) => ({
          ...a,
          evidence: a.evidence.map((e) => artifact("evidence", e)),
        })),
      });
    const inventory = (i: ForkInventory): ForkInventory =>
      artifact("inventory", {
        ...i,
        review: artifact("review", i.review),
        entries: i.entries.map((e) => ({ ...e, request: request(e.request) })),
        output: i.output && artifact("output", i.output),
        durability: i.durability && artifact("durability", i.durability),
      });
    return {
      review,
      states: data.states.map(state),
      inventory: data.inventory && inventory(data.inventory),
      outcome:
        data.outcome &&
        artifact("outcome", {
          ...data.outcome,
          review: artifact("review", data.outcome.review),
          inventory: inventory(data.outcome.inventory),
          states: data.outcome.states.map(state),
          output:
            data.outcome.output && artifact("output", data.outcome.output),
        }),
    };
  }
  admit(input: ForkReviewSeed = seed) {
    const review = rebuildReview(input, this.proofs);
    const token = fingerprint("test-admission", review);
    this.disk.admissions[token] = fingerprint("fork-admission", review);
    return {
      seed: input,
      admissionProof: token,
      ownerHash: h(20),
      ttlMs: 100,
      commandId: "claim",
    };
  }
  async loadReview(
    familyKey: string,
    commandId?: string,
  ): Promise<ForkLoadedReview> {
    this.calls++;
    return copy({
      snapshot: this.disk.rows[familyKey] ?? null,
      receipt: commandId
        ? (this.disk.receipts[familyKey + ":" + commandId] ?? null)
        : null,
    });
  }
  acquireClaim = (tx: ForkTransaction) => this.transact("acquire", tx);
  renewClaim = (tx: ForkTransaction) => this.transact("renew", tx);
  releaseClaim = (tx: ForkTransaction) => this.transact("release", tx);
  compareAndCommit = (tx: ForkTransaction) => this.transact("cas", tx);
  private async transact(
    operation: string,
    tx: ForkTransaction,
  ): Promise<ForkLoadedReview> {
    this.calls++;
    const previous = this.queue;
    let unlock!: () => void;
    this.queue = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    await previous;
    this.inTransaction = true;
    try {
      this.beforeTransaction?.();
      const at = this.now; // storage clock sampled after obtaining the transaction lock
      const key = tx.familyKey + ":" + tx.commandId;
      const receipt = this.disk.receipts[key];
      if (receipt) {
        requireFact(receipt.commandHash === tx.commandHash);
        return copy({
          snapshot: this.disk.rows[tx.familyKey]!,
          receipt,
          replayed: true,
        });
      }
      const current = this.disk.rows[tx.familyKey] ?? null;
      const actual = current ? this.disk.comparisons[tx.familyKey] : null;
      requireFact(
        fingerprint("cas", actual) === fingerprint("cas", tx.expected),
      );
      if (operation !== "acquire") {
        requireFact(current);
        currentClaim(current, at);
      } else requireFact(!current?.claim || current.claim.expiresAt <= at);
      const built = tx.build(current && copy(current), at);
      const proposed = copy(built.snapshot);
      requireFact(
        proposed.familyKey === tx.familyKey &&
          proposed.version === next(current?.version ?? "0"),
      );
      requireFact(
        proposed.fence ===
          (operation === "acquire"
            ? next(current?.fence ?? "0")
            : current?.fence),
      );
      if (operation !== "acquire") {
        requireFact(current && proposed.reviewHash === current.reviewHash);
        if (operation === "release") requireFact(proposed.claim === null);
        else
          requireFact(
            proposed.claim?.epoch === current.claim?.epoch &&
              proposed.claim?.ownerHash === current.claim?.ownerHash &&
              proposed.claim?.claimHash === current.claim?.claimHash,
          );
      }
      const fault = this.fault;
      this.fault = null;
      if (fault === "before_commit") throw new Error("crash_before_commit");
      const checkpoint = this.proofs.issueCheckpoint(proposed, built.state, {
        commandId: tx.commandId,
        commandHash: tx.commandHash,
      });
      const checkpointed = { ...proposed, checkpoint };
      const owner = operation === "acquire" ? proposed.claim : current?.claim;
      requireFact(owner);
      const committed = {
        ownerHash: owner.ownerHash,
        commandId: tx.commandId,
        commandHash: tx.commandHash,
        reviewHash: proposed.reviewHash,
        version: proposed.version,
      };
      const committedComparison = comparison(checkpointed, {
        ...built.state,
        states: new Map(
          built.state.states.map((s) => [s.request.effect.effectKey, s]),
        ),
      });
      const stamp = this.stamp(checkpointed);
      const retainedCheckpoint = copy(checkpoint);
      // All potentially throwing work precedes the single durable state swap.
      this.disk = {
        ...this.disk,
        rows: { ...this.disk.rows, [tx.familyKey]: checkpointed },
        comparisons: {
          ...this.disk.comparisons,
          [tx.familyKey]: committedComparison,
        },
        receipts: { ...this.disk.receipts, [key]: committed },
        checkpoints: {
          ...this.disk.checkpoints,
          [checkpoint.proof]: retainedCheckpoint,
        },
        seals: [...this.disk.seals, stamp],
      };
      this.pendingCheckpoints.delete(checkpoint.proof);
      this.commits++;
      if (fault === "lost_ack") throw new Error("commit_ack_lost");
      return copy({ snapshot: checkpointed, receipt: committed });
    } finally {
      this.inTransaction = false;
      unlock();
    }
  }
  /** Fixture import simulates already authenticated history from the preceding
   * writer. This is deliberately test-only; PR A exposes no prepare/begin path. */
  fixture(running = true, freeze = true) {
    const admission = this.admit();
    const review = rebuildReview(seed, this.proofs);
    let snapshot: ForkLedgerSnapshot = {
      seed,
      admissionProof: admission.admissionProof,
      reviewHash: fingerprint("fork-admission", review),
      familyKey: review.familyKey,
      version: "1",
      fence: "1",
      claim: { ownerHash: h(20), claimHash: h(21), epoch: "1", expiresAt: 200 },
      events: [],
    };
    this.sign(snapshot);
    snapshot = this.appendFixture(snapshot, {
      kind: "prepare",
      request: provider,
    });
    const request = createForkRequest(
      review,
      createForkEffect(review, provider.slot),
      provider.facts,
    );
    if (running)
      snapshot = this.appendFixture(snapshot, {
        kind: "begin",
        effectKey: request.effect.effectKey,
      });
    if (!freeze) {
      this.disk.rows[review.familyKey] = copy(snapshot);
      return snapshot;
    }
    this.disk.inventory.inventory = [request.effect.effectKey];
    snapshot = this.appendFixture(snapshot, {
      kind: "inventory",
      entries: [{ effectKey: request.effect.effectKey, dependencies: [] }],
      completenessProof: "inventory",
      output: null,
    });
    this.disk.rows[review.familyKey] = copy(snapshot);
    return snapshot;
  }
  appendFixture(
    snapshot: ForkLedgerSnapshot,
    input: ForkLedgerInput,
    mode?: "execute" | "reconcile",
  ) {
    const ledger = replayForkLedger(snapshot, this.proofs);
    const state =
      "effectKey" in input ? ledger.states.get(input.effectKey) : null;
    const context: ForkAuthorityContext = {
      review: ledger.review,
      revision: state?.revision ?? "0",
      mode:
        mode ??
        (["prepare", "begin", "retry"].includes(input.kind)
          ? "execute"
          : "reconcile"),
      at: this.now,
      claim: snapshot.claim,
    };
    const event = {
      at: this.now,
      input,
      authorityProof:
        input.kind === "inventory" || input.kind === "outcome"
          ? null
          : this.proofs.authorize(context),
    };
    applyForkEvent(ledger, event, this.proofs, null);
    const updated: ForkLedgerSnapshot = {
      ...snapshot,
      version: next(snapshot.version),
      events: [...snapshot.events, event],
    };
    const checkpoint = this.proofs.issueCheckpoint(
      updated,
      checkpointState(ledger),
      null,
    );
    const checkpointed = { ...updated, checkpoint };
    this.sign(checkpointed);
    this.disk.comparisons[updated.familyKey] = comparison(checkpointed, ledger);
    return checkpointed;
  }
  evidenceFor(
    snapshot: ForkLedgerSnapshot,
    changes: Partial<ForkEvidence> = {},
  ) {
    const ledger = replayForkLedger(snapshot, this.proofs);
    return this.evidenceFrom(ledger, snapshot.claim, changes);
  }
  private evidenceFrom(
    ledger: ForkRebuiltLedger,
    claim: ForkLedgerSnapshot["claim"],
    changes: Partial<ForkEvidence>,
  ) {
    const state = [...ledger.states.values()][0]!;
    const context: ForkAuthorityContext = {
      review: ledger.review,
      revision: state.revision,
      mode: "reconcile",
      at: this.now,
      claim,
    };
    const authority = createForkStateVerifier({
      authority: (token: string) => this.proofs.authority(token, context),
      evidence: (token: string) => this.proofs.evidence(token),
    }).authority(this.proofs.authorize(context));
    const facts: ForkEvidence = {
      logicalKey: ledger.review.logicalKey,
      effectKey: state.request.effect.effectKey,
      requestHash: state.request.requestHash,
      attempt: state.attempts.at(-1)!.ordinal,
      originEpoch: state.attempts.at(-1)!.originEpoch,
      remoteScopeHash: state.request.remoteScopeHash,
      authorityHash: forkAuthorityHash(authority),
      kind: "unknown",
      source: "observation",
      verifierHash: h(30),
      evidenceHash: h(31),
      externalRefHash: null,
      resultHash: null,
      disposition: "indeterminate",
      senderClosure: "open",
      reason: "timeout",
      ...changes,
    };
    const proof = fingerprint("test-evidence-token", facts);
    this.disk.evidence[proof] = facts;
    return {
      kind: "evidence" as const,
      effectKey: state.request.effect.effectKey,
      proof,
    };
  }
  saturatedFixture(count = 255) {
    const initial = this.fixture();
    const ledger = replayForkLedger(initial, this.proofs);
    const events = [...initial.events];
    for (let i = 0; i < count; i++) {
      const input = this.evidenceFrom(ledger, initial.claim, {
        evidenceHash: h(1000 + i),
      });
      const state = ledger.states.get(input.effectKey)!;
      const event = {
        at: this.now,
        input,
        authorityProof: this.proofs.authorize({
          review: ledger.review,
          revision: state.revision,
          mode: "reconcile",
          at: this.now,
          claim: initial.claim,
        }),
      };
      applyForkEvent(ledger, event, this.proofs, initial.claim);
      events.push(event);
    }
    const updated = { ...initial, version: String(4 + count), events };
    const snapshot = {
      ...updated,
      checkpoint: this.proofs.issueCheckpoint(
        updated,
        checkpointState(ledger),
        null,
      ),
    };
    this.attestStoredBytes(snapshot);
    this.disk.comparisons[snapshot.familyKey] = comparison(snapshot, ledger);
    this.disk.rows[snapshot.familyKey] = copy(snapshot);
    return snapshot;
  }
  attestStoredBytes(snapshot: ForkLedgerSnapshot) {
    this.sign(snapshot);
  }
  savePredecessor(snapshot: ForkLedgerSnapshot) {
    const token = this.stamp(snapshot);
    this.proofs.verifyLedger(snapshot);
    this.disk.predecessors[token] = copy(snapshot);
    return token;
  }
}
export function stateOf(
  repository: SerializedForkRepository,
  snapshot: ForkLedgerSnapshot,
) {
  return [...replayForkLedger(snapshot, repository.proofs).states.values()][0]!;
}
export const noEffect: Partial<ForkEvidence> = {
  kind: "no_effect",
  disposition: "definitive_no_effect",
  source: "dispatch_journal",
  reason: "never_dispatched",
  senderClosure: "closed",
};
export const success: Partial<ForkEvidence> = {
  kind: "success",
  disposition: "authenticated_success",
  source: "provider_receipt",
  reason: "confirmed",
  senderClosure: "closed",
  resultHash: h(40),
  externalRefHash: h(41),
};
export function snapshotOf(result: ForkBoundaryResult): ForkLedgerSnapshot {
  requireFact("loaded" in result && result.loaded.snapshot);
  return result.loaded.snapshot;
}
export async function change(
  r: SerializedForkRepository,
  expected: ForkLedgerSnapshot,
  commandId: string,
  command: ForkReconciliationInput,
) {
  return snapshotOf(
    await reconcileCertifiedForkEffect(r.dependencies, {
      expected,
      commandId,
      command,
    }),
  );
}
export async function lease(
  r: SerializedForkRepository,
  expected: ForkLedgerSnapshot,
  operation: "renew" | "release",
  commandId: string,
  ttlMs = 100,
) {
  return snapshotOf(
    await manageCertifiedForkClaim(r.dependencies, {
      expected,
      operation,
      commandId,
      ttlMs,
    }),
  );
}
