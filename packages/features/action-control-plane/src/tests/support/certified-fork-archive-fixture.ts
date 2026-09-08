import { createHmac } from "node:crypto";
import {
  artifact,
  authentic,
  fingerprint,
  next,
  requireFact,
} from "../../domain/certified-fork-effect-canonical.js";
import {
  createForkReview,
  createForkEffect,
  createForkRequest,
  type ForkReview,
  type ForkRequest,
} from "../../domain/certified-fork-effect-identity.js";
import {
  createForkStateVerifier,
  prepareForkEffect,
  forkAuthorityHash,
  type ForkAuthority,
  type ForkEvidence,
  type ForkEffectState,
} from "../../domain/certified-fork-effect-state.js";
import type {
  ForkCheckpoint,
  ForkCheckpointState,
  CertifiedForkEffectProofPort,
} from "../../application/ports/certified-fork-effect-proof-port.js";
import type {
  ForkTransaction,
  ForkLedgerSnapshot,
  ForkReviewSeed,
  ForkClaim,
  ForkLedgerEvent,
} from "../../application/ports/certified-fork-effect-repository-port.js";
import type {
  ForkArchiveTrustedHooks,
  ForkArchiveOperation,
  ForkArchiveVersion,
} from "../../infrastructure/prisma/prisma-certified-fork-effect-repository.js";
import {
  archiveJson,
  checkpointComparison,
  sameArchive,
} from "../../infrastructure/prisma/certified-fork-archive-codec.js";
import {
  checkpointAnchor,
  forkLedgerHash,
  applyForkEvent,
  type ForkRebuiltLedger,
} from "../../application/services/certified-fork-effect-ledger.js";

import type {
  ForkInventory,
  ForkOutcome,
} from "../../domain/certified-fork-effect-outcome.js";

export const ah = (n: number) => n.toString(16).padStart(64, "0");
export const archiveSeed: ForkReviewSeed = {
  facts: {
    workspaceId: "tenant",
    repositoryId: "repo",
    sourceRepositoryId: "fork",
    baseRepositoryId: "base",
    pullRequest: 1,
    headSha: "a".repeat(40),
    baseSha: "b".repeat(40),
    trustDomain: "fork",
    generation: "0",
  },
  bindingHash: ah(1),
  admissionHash: null,
  predecessor: null,
};
export const archiveReview = createForkReview(
  archiveSeed.facts,
  archiveSeed.bindingHash,
);
const unsupported = (): never => {
  throw new Error("test_proof_not_provisioned");
};

/** ONLY a bounded SQL repository test authority. A fixed test HMAC authenticates
 * complete checkpoint bytes and original owner, surviving fresh hook instances.
 * It is not a production producer/current-scope implementation or runtime issuer.
 * No SerializedForkRepository and no in-memory committed archive/receipt maps. */
export function archiveHooks(owner = ah(20)) {
  let bound = false;
  let committingOwner = owner;
  let verifiedReadSet: readonly ForkArchiveVersion[] = [];
  const control = {
    owner,
    revoked: false,
    expiresAt: Number.MAX_SAFE_INTEGER,
    beforePrepare: null as (() => Promise<void>) | null,
    beforeRetain: null as (() => Promise<void>) | null,
    buildsBound: 0,
    histories: 0,
    promoted: 0,
    // Explicit TEST provisioning; absent references always fail closed.
    admissions: new Map<string, ForkReview>(),
    predecessors: new Map<string, ForkLedgerSnapshot>(),
    evidence: new Map<string, ForkEvidence>(),
    mutations: 0,
  };
  const mac = (checkpoint: Omit<ForkCheckpoint, "proof">, principal: string) =>
    createHmac("sha256", "repository-test-key-never-production")
      .update(archiveJson({ checkpoint, principal }))
      .digest("hex");
  const verify = (snapshot: ForkLedgerSnapshot) => {
    const cp = snapshot.checkpoint;
    requireFact(cp);
    const { proof, ...data } = cp;
    const [principal, signature] = proof.split(".");
    requireFact(
      principal &&
        signature &&
        proof === `${principal}.${mac(data, principal)}`,
    );
    requireFact(
      cp.anchorHash === checkpointAnchor(snapshot) &&
        cp.prefixHash === forkLedgerHash(snapshot),
    );
    return principal;
  };
  const restore = (cp: ForkCheckpoint): ForkCheckpointState => {
    const restoredReview = artifact("review", cp.state.review);
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
    const outcome = (o: ForkOutcome): ForkOutcome =>
      artifact("outcome", {
        ...o,
        review: artifact("review", o.review),
        inventory: inventory(o.inventory),
        states: o.states.map(state),
        output: o.output && artifact("output", o.output),
      });
    return {
      review: restoredReview,
      states: cp.state.states.map(state),
      inventory: cp.state.inventory && inventory(cp.state.inventory),
      outcome: cp.state.outcome && outcome(cp.state.outcome),
    };
  };
  const hooks: ForkArchiveTrustedHooks = {
    proofs: {
      issueCheckpoint(snapshot, state, position) {
        requireFact(bound);
        control.buildsBound++;
        authentic("review", state.review);
        state.states.forEach((s) => authentic("state", s));
        requireFact(
          fingerprint("fork-admission", state.review) === snapshot.reviewHash,
        );
        const cp = {
          prefixLength: snapshot.events.length,
          prefixHash: forkLedgerHash(snapshot),
          anchorHash: checkpointAnchor(snapshot),
          position,
          state,
        };
        return {
          ...cp,
          proof: `${committingOwner}.${mac(cp, committingOwner)}`,
        };
      },
      restoreCheckpoint(cp, snapshot) {
        verify(snapshot);
        requireFact(sameArchive(cp, snapshot.checkpoint));
        return restore(cp);
      },
      verifyLedger(snapshot) {
        requireFact(!bound);
        verify(snapshot);
      },
      verifyReceipt(receipt, snapshot) {
        verify(snapshot);
        const origin =
          receipt.version === snapshot.version
            ? snapshot
            : verifiedReadSet.find(
                (v) =>
                  v.snapshot.familyKey === snapshot.familyKey &&
                  v.snapshot.version === receipt.version,
              )?.snapshot;
        requireFact(
          origin && BigInt(origin.version) <= BigInt(snapshot.version),
        );
        const principal = verify(origin),
          cp = origin.checkpoint!;
        requireFact(
          sameArchive(receipt, {
            ownerHash: principal,
            commandId: cp.position!.commandId,
            commandHash: cp.position!.commandHash,
            version: origin.version,
            reviewHash: origin.reviewHash,
          }),
        );
      },
      ownership(_proof, principal) {
        requireFact(!control.revoked && principal === control.owner);
      },
      admission(proof, review, current) {
        requireFact(!current || bound);
        const admitted = control.admissions.get(proof);
        requireFact(admitted && sameArchive(admitted, review));
      },
      predecessor(proof) {
        const snapshot = control.predecessors.get(proof);
        requireFact(snapshot);
        verify(snapshot);
        requireFact(snapshot.checkpoint!.state.outcome !== null);
        return snapshot;
      },
      authorize: unsupported,
      authority: unsupported,
      evidence(proof) {
        const evidence = control.evidence.get(proof);
        requireFact(evidence);
        return evidence;
      },
      inventory: unsupported,
      durability: unsupported,
      retainedOutput: unsupported,
      mutation(input, review) {
        requireFact(bound && input.kind === "evidence");
        const evidence = control.evidence.get(input.proof);
        requireFact(
          evidence &&
            evidence.logicalKey === review.logicalKey &&
            evidence.effectKey === input.effectKey,
        );
        // Authenticate against retained, HMAC-verified original evidence bytes.
        requireFact(
          verifiedReadSet.some((v) =>
            v.snapshot.checkpoint!.state.states.some((s) =>
              s.attempts.some((a) =>
                a.evidence.some((e) => sameArchive(e, evidence)),
              ),
            ),
          ),
        );
        control.mutations++;
      },
    },
    async lockScope() {
      return {
        assertRead(at, principal) {
          requireFact(
            !control.revoked &&
              at < control.expiresAt &&
              (principal === null || principal === control.owner),
          );
        },
        async prepareCommand(_sql, _command, current, operation) {
          await control.beforePrepare?.();
          return {
            run(at, work) {
              requireFact(!bound && !control.revoked && at < control.expiresAt);
              committingOwner =
                operation === "acquireClaim"
                  ? control.owner
                  : current!.receipt.ownerHash;
              requireFact(
                operation === "acquireClaim" ||
                  current!.snapshot.claim?.ownerHash === control.owner,
              );
              bound = true;
              try {
                return work();
              } finally {
                bound = false;
              }
            },
            async retain() {
              await control.beforeRetain?.();
            },
          };
        },
        close() {
          requireFact(!bound);
        },
      };
    },
    async authenticateHistory(_sql, versions) {
      requireFact(!bound);
      control.histories++;
      versions.forEach((v) => verify(v.snapshot));
      verifiedReadSet = versions;
    },
    committed() {
      control.promoted++;
    },
  };
  return { hooks, control };
}

export function fixtureStates(review: ForkReview = archiveReview, count = 2) {
  return Array.from({ length: count }, (_, index) => {
    const provider = index === 0;
    const effect = createForkEffect(review, {
      stage: provider ? "provider" : "publication",
      role: provider ? "review" : "inline",
      slot: provider ? 1 : index,
    });
    const common = {
      contextHash: ah(2),
      adapterContractHash: ah(3),
      schemaHash: ah(4),
    };
    const request = createForkRequest(
      review,
      effect,
      provider
        ? {
            ...common,
            providerInstanceId: "provider",
            accountScopeHash: ah(5),
            modelHash: ah(6),
            settingsHash: ah(7),
            trustedInstructionsHash: ah(8),
            effectiveInputHash: ah(9),
            toolsOutputSchemaHash: ah(10),
            executionPolicyHash: ah(11),
          }
        : {
            ...common,
            outputCommitmentHash: ah(12),
            frozenPlanHash: ah(13),
            appId: "app",
            installationId: "installation",
            baseRepositoryId: "base",
            pullRequest: 1,
            commitSha: "a".repeat(40),
            objectTargetHash: ah(14),
            renderPolicyHash: ah(15),
            payloadHashes: [ah(16)],
            markerHash: ah(17),
          },
    );
    const authority = createForkStateVerifier({
      authority: () => ({
        logicalKey: review.logicalKey,
        reviewHash: fingerprint("fork-admission", review),
        epoch: "1",
        claimHash: ah(21),
        ownerHash: ah(20),
        revision: "0",
        mode: "execute",
        validUntilHash: ah(22),
      }),
      evidence: unsupported,
    }).authority("test-fixture");
    return prepareForkEffect(request, authority);
  });
}
export function archiveCommand(
  operation: ForkArchiveOperation,
  id: string,
  current: ForkLedgerSnapshot | null = null,
  owner = ah(20),
  states = current?.checkpoint?.state.states ?? [],
): ForkTransaction {
  const liveStates = current?.checkpoint
    ? states.map((s) => artifact("state", s))
    : states;
  const review = current?.checkpoint
    ? artifact("review", current.checkpoint.state.review)
    : archiveReview;
  return {
    familyKey: archiveReview.familyKey,
    commandId: id,
    commandHash: fingerprint("archive-test-command", { operation, id, owner }),
    expected: current ? checkpointComparison(current) : null,
    build(prior, at) {
      const fence =
        operation === "acquireClaim" ? next(prior?.fence ?? "0") : prior!.fence;
      const claim =
        operation === "releaseClaim"
          ? null
          : operation === "acquireClaim"
            ? {
                ownerHash: owner,
                claimHash: ah(21),
                epoch: fence,
                expiresAt: at + 120_000,
              }
            : operation === "renewClaim"
              ? { ...prior!.claim!, expiresAt: at + 180_000 }
              : prior!.claim;
      const snapshot: ForkLedgerSnapshot = {
        seed: prior?.seed ?? archiveSeed,
        familyKey: archiveReview.familyKey,
        admissionProof: "test-admission",
        reviewHash: fingerprint("fork-admission", review),
        version: next(prior?.version ?? "0"),
        fence,
        claim,
        events: prior?.events ?? [],
      };
      return {
        snapshot,
        state: { review, states: liveStates, inventory: null, outcome: null },
      };
    },
  };
}
export function archiveRow(v: ForkArchiveVersion): Record<string, unknown> {
  const s = v.snapshot,
    c = s.checkpoint!;
  return {
    ...s,
    ...v.receipt,
    ...c,
    generation: s.seed.facts.generation,
    operation: v.operation,
    formatVersion: 1,
    checkpointFormat: 1,
    claimOwnerHash: s.claim?.ownerHash ?? null,
    claimHash: s.claim?.claimHash ?? null,
    claimEpoch: s.claim?.epoch ?? null,
    claimExpiresAtMs: s.claim ? String(s.claim.expiresAt) : null,
    committedAtMs: String(v.committedAt),
    ledgerHash: v.comparison.ledgerHash,
    outcomeHash: v.comparison.outcomeHash,
    revisions: v.comparison.revisions,
    positionCommandId: c.position!.commandId,
    positionCommandHash: c.position!.commandHash,
  };
}

/** Real domain event/state relationships, with explicitly test-trusted receipt,
 * inventory and durability producers. No output bytes or real authorization. */
export function fixtureHistory(
  review: ForkReview = archiveReview,
  claim: ForkClaim = {
    ownerHash: ah(20),
    claimHash: ah(21),
    epoch: "1",
    expiresAt: 120_100,
  },
  at = 100,
) {
  const request = fixtureStates(review, 1)[0]!.request;
  const ledger: ForkRebuiltLedger = {
    review,
    states: new Map(),
    inventory: null,
    outcome: null,
  };
  const authorities = new Map<string, ForkAuthority>();
  const evidence = new Map<string, ForkEvidence>();
  const proofs: CertifiedForkEffectProofPort = {
    ...archiveHooks().hooks.proofs,
    authority(proof) {
      const a = authorities.get(proof);
      requireFact(a);
      return a;
    },
    evidence(proof) {
      const e = evidence.get(proof);
      requireFact(e);
      return e;
    },
    inventory(proof) {
      requireFact(proof === "test-complete-inventory");
      return [request.effect.effectKey];
    },
    durability(proof, output) {
      requireFact(proof === "test-durable-output");
      return {
        disposition: "durably_committed",
        outputCommitmentHash: output.outputHash,
        commitReceiptHash: ah(70),
      };
    },
    retainedOutput(proof) {
      requireFact(proof === "test-retained-output");
    },
  };
  const events: ForkLedgerEvent[] = [];
  const add = (input: ForkLedgerEvent["input"]) => {
    const state = ledger.states.get(request.effect.effectKey);
    const authorityProof = ["inventory", "outcome"].includes(input.kind)
      ? null
      : `test-authority-${events.length}`;
    if (authorityProof)
      authorities.set(authorityProof, {
        logicalKey: review.logicalKey,
        reviewHash: fingerprint("fork-admission", review),
        epoch: claim.epoch,
        claimHash: claim.claimHash,
        ownerHash: claim.ownerHash,
        revision: state?.revision ?? "0",
        mode: ["prepare", "begin"].includes(input.kind)
          ? "execute"
          : "reconcile",
        validUntilHash: fingerprint("fork-lease-expiry", claim.expiresAt),
      });
    if (input.kind === "evidence") {
      const authority = createForkStateVerifier({
        authority: () => authorities.get(authorityProof!)!,
        evidence: unsupported,
      }).authority("test");
      evidence.set(
        input.proof,
        createForkStateVerifier({
          authority: unsupported,
          evidence: () => ({
            logicalKey: review.logicalKey,
            effectKey: request.effect.effectKey,
            requestHash: request.requestHash,
            attempt: "0",
            originEpoch: claim.epoch,
            remoteScopeHash: request.remoteScopeHash,
            authorityHash: forkAuthorityHash(authority),
            kind: "success",
            source: "provider_receipt",
            verifierHash: ah(71),
            evidenceHash: ah(72),
            externalRefHash: ah(73),
            resultHash: ah(74),
            disposition: "authenticated_success",
            senderClosure: "closed",
            reason: "confirmed",
          }),
        }).evidence("test"),
      );
    }
    const event = { at, input, authorityProof };
    applyForkEvent(ledger, event, proofs, claim);
    events.push(event);
  };
  add({
    kind: "prepare",
    request: { slot: request.effect.slot, facts: request.facts },
  });
  add({ kind: "begin", effectKey: request.effect.effectKey });
  add({
    kind: "evidence",
    effectKey: request.effect.effectKey,
    proof: "test-success",
  });
  add({
    kind: "inventory",
    entries: [{ effectKey: request.effect.effectKey, dependencies: [] }],
    completenessProof: "test-complete-inventory",
    output: {
      effectKey: request.effect.effectKey,
      canonicalOutputHash: ah(74),
      durabilityProof: "test-durable-output",
    },
  });
  add({ kind: "seal", effectKey: request.effect.effectKey });
  add({
    kind: "outcome",
    availability: "available",
    retainedProof: "test-retained-output",
  });
  return {
    events,
    evidence,
    state: { ...ledger, states: [...ledger.states.values()] },
  };
}
