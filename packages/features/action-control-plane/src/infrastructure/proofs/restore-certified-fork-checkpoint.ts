import type {
  CertifiedForkEffectProofPort,
  ForkCheckpointState,
} from "../../application/ports/certified-fork-effect-proof-port.js";
import type {
  ForkCommandReceipt,
  ForkLedgerSnapshot,
  ForkLedgerEvent,
} from "../../application/ports/certified-fork-effect-repository-port.js";
import {
  applyForkEvent,
  checkpointState,
  commandHash,
  comparison,
  validateForkSeed,
  captureForkInput,
  exactForkFields,
  type ForkRebuiltLedger,
} from "../../application/services/certified-fork-effect-ledger.js";
import { certifiedForkReviewBindingHash } from "../../application/use-cases/certified-fork-review-binding.js";
import { parseCertifiedForkReviewPromptPacket } from "../../application/use-cases/certified-fork-review-packet.js";
import {
  authentic,
  fingerprint,
  hash,
  next,
  positive,
  requireFact,
  counter,
  opaqueId,
} from "../../domain/certified-fork-effect-canonical.js";
import {
  createForkEffect,
  createForkRequest,
} from "../../domain/certified-fork-effect-identity.js";
import { createForkReviewFromOutcome } from "../../domain/certified-fork-effect-outcome.js";
import {
  createForkStateVerifier,
  forkAuthorityHash,
  type ForkEvidence,
  type ForkEffectState,
} from "../../domain/certified-fork-effect-state.js";
import {
  archiveSnapshot,
  archiveReceipt,
  archiveComparison,
  checkpointComparison,
  sameArchive,
  archiveJson,
} from "../prisma/certified-fork-archive-codec.js";
import {
  parseRetainedFact,
  canonicalRetainedBytes,
  factSha256,
  factSourceSha256,
  type RetainedFactInput,
  type RetainedFactKind,
  type RetainedFactScope,
} from "../prisma/certified-fork-proof-fact-types.js";
import type { ForkArchiveVersion } from "../prisma/prisma-certified-fork-effect-repository.js";
import { validateRetainedForkOutput } from "./certified-fork-retained-output.js";
import type {
  HistoricalForkPredecessor,
  HistoricalForkPreimage,
  ProtectedForkHistoricalSource,
} from "./certified-fork-historical-source.js";

/** Private discovery contracts. These are NEW producer conventions, not aliases
 * for old references. No hash inversion, guessed command or legacy fallback. */
export function historicalForkCommandReference(
  family: string,
  version: string,
  id: string,
): string {
  return `fork-command-v1/${hash(family)}/${counter(version)}/${opaqueId(id)}`;
}
export function historicalForkPredecessorReference(
  position: HistoricalForkPredecessor,
): string {
  return `fork-predecessor-v1/${hash(position.familyKey)}/${counter(position.version)}/${hash(position.reviewHash)}/${hash(position.outcomeHash)}`;
}
/** Deterministic receipt comparison only; custody and committed causal ordering
 * MUST already have been authenticated by ProtectedForkHistoricalSource.output. */
export function historicalForkOutputReceiptHash(
  input: RetainedFactInput<"output">,
): string {
  const fact = parseRetainedFact(input);
  requireFact(fact.kind === "output");
  return factSha256(
    canonicalRetainedBytes({
      tag: "fork-output-commit-v1",
      proofId: fact.proofId,
      scope: fact.scope,
      provenance: fact.provenance,
      payloadHash: factSha256(canonicalRetainedBytes(fact.payload)).toString(
        "hex",
      ),
      commitIdentity: fact.payload.commitIdentity,
    }),
  ).toString("hex");
}
const unavailable = (): never => {
  throw new Error("historical_only_no_current_authority");
};
const equal = (a: unknown, b: unknown) => requireFact(sameArchive(a, b));

export type RestoredForkHistory = Readonly<{
  familyKey: string;
  tipVersion: string;
  versions: readonly Readonly<{
    archive: ForkArchiveVersion;
    state: ForkCheckpointState;
  }>[];
  /** Full byte equality against the private committed read set, no I/O and no
   * replay. Current scope, CAS and ownership are deliberately not implemented. */
  proofs: Pick<
    CertifiedForkEffectProofPort,
    "verifyLedger" | "restoreCheckpoint" | "verifyReceipt" | "predecessor"
  >;
}>;

/** Constructor-driven bounded historical core. Await outside ALL write hooks.
 * The source is mandatory trusted infrastructure; data returned by it is parsed
 * and cross-checked, never directly artifact-branded. No runtime composition.
 * Completeness/custody of the pinned read and semantic source authentication are
 * explicit source obligations; this algorithm cannot establish them from hashes.
 */
export async function restoreCertifiedForkCheckpoint(
  source: ProtectedForkHistoricalSource,
  familyKey: string,
): Promise<RestoredForkHistory> {
  hash(familyKey);
  const opened = await source.open(familyKey);
  const tipVersion = counter(opened.tipVersion);
  requireFact(opened.familyKey === familyKey && opened.versions.length > 0);
  requireFact(opened.versions.length <= 10_000);
  // Each archive is captured independently, never using the per-fact 8 MiB codec
  // on an entire history. Explicit staged limits, no implicit 32-event suffix.
  const versions = opened.versions.map(
    (v): ForkArchiveVersion =>
      Object.freeze({
        snapshot: archiveSnapshot(v.snapshot),
        receipt: archiveReceipt(v.receipt),
        comparison: archiveComparison(v.comparison),
        operation: v.operation,
        committedAt: positive(v.committedAt),
      }),
  );
  requireFact(versions.at(-1)!.snapshot.version === tipVersion);
  let totalEvents = 0;
  const commandIds = new Set<string>();
  const checkpointIds = new Set<string>();
  const facts = new Map<string, string>();
  const factSources = new Map<string, string>();
  function fact(
    input: unknown,
    kind: RetainedFactKind,
    scope: RetainedFactScope,
    proof: string,
  ) {
    const parsed = parseRetainedFact(input);
    requireFact(parsed.kind === kind && parsed.proofId === proof);
    equal(parsed.scope, scope);
    const bytes = archiveJson(parsed);
    const old = facts.get(proof);
    requireFact(old === undefined || old === bytes);
    facts.set(proof, bytes);
    const sourceKey = factSourceSha256(parsed).toString("hex");
    const previousSource = factSources.get(sourceKey);
    requireFact(previousSource === undefined || previousSource === bytes);
    factSources.set(sourceKey, bytes);
    return parsed;
  }
  const verified: {
    archive: ForkArchiveVersion;
    state: ForkCheckpointState;
  }[] = [];
  const predecessors = new Map<string, ForkLedgerSnapshot>();
  const evidenceClosure = new Map<
    string,
    {
      evidence: ForkEvidence;
      authority: RetainedFactInput<"authority">["payload"];
    }
  >();
  const authorities = new Map<
    string,
    RetainedFactInput<"authority">["payload"]
  >();
  const outputStates = new Map<string, ForkEffectState>();
  let generationAdmission: RetainedFactInput<"admission"> | null = null;
  let ledger: ForkRebuiltLedger | null = null;
  let prior: ForkArchiveVersion | null = null;
  for (const version of versions) {
    const s = version.snapshot,
      cp = s.checkpoint,
      r = version.receipt;
    requireFact(
      s.familyKey === familyKey &&
        s.version === next(prior?.snapshot.version ?? "0"),
    );
    requireFact(
      cp &&
        cp.position &&
        !checkpointIds.has(cp.proof) &&
        !commandIds.has(r.commandId),
    );
    checkpointIds.add(cp.proof);
    commandIds.add(r.commandId);
    equal(cp.position, { commandId: r.commandId, commandHash: r.commandHash });
    requireFact(r.version === s.version && r.reviewHash === s.reviewHash);
    equal(checkpointComparison(s), version.comparison);
    requireFact(version.committedAt >= (prior?.committedAt ?? 0));
    const scope: RetainedFactScope = {
      workspaceId: s.seed.facts.workspaceId,
      repositoryConnectionId: s.seed.facts.repositoryId,
      familyKey,
      reviewHash: s.reviewHash,
    };
    const commandRef = historicalForkCommandReference(
      familyKey,
      s.version,
      r.commandId,
    );
    const resolvedCommand = await opened.command(scope, commandRef);
    const command = fact(resolvedCommand.fact, "command", scope, commandRef);
    requireFact(command.kind === "command");
    const p = command.payload,
      preimage = captureForkInput(resolvedCommand.preimage);
    exactForkFields(preimage, ["operation", "data"]);
    equal(p.preimage, preimage);
    requireFact(
      commandHash(preimage.operation, preimage.data) === r.commandHash,
    );
    requireFact(
      p.commandHash === r.commandHash &&
        p.commandId === r.commandId &&
        p.version === s.version &&
        p.operation === version.operation &&
        p.admissionProof === s.admissionProof,
    );
    equal(p.comparison, prior?.comparison ?? null);
    requireFact(resolvedCommand.ownerHash === r.ownerHash);
    const newGeneration =
      !prior ||
      prior.snapshot.seed.facts.generation !== s.seed.facts.generation;
    let prefix = prior?.snapshot.events ?? [];
    if (newGeneration) {
      validateForkSeed(s.seed);
      let predecessor = null;
      if (prior) {
        requireFact(ledger?.outcome && version.operation === "acquireClaim");
        requireFact(
          s.seed.facts.generation ===
            next(prior.snapshot.seed.facts.generation),
        );
        equal(
          ledger.outcome.states,
          [...ledger.states.values()].sort((a, b) =>
            a.request.effect.effectKey.localeCompare(
              b.request.effect.effectKey,
            ),
          ),
        );
        predecessor = ledger.outcome;
        const position = {
          familyKey,
          version: prior.snapshot.version,
          reviewHash: prior.snapshot.reviewHash,
          outcomeHash: predecessor.outcomeHash,
        };
        requireFact(
          s.seed.predecessor === historicalForkPredecessorReference(position),
        );
        predecessors.set(s.seed.predecessor, prior.snapshot);
      } else requireFact(s.seed.facts.generation === "0");
      ledger = {
        review: createForkReviewFromOutcome(
          s.seed.facts,
          s.seed.bindingHash,
          predecessor,
          s.seed.admissionHash === null
            ? null
            : { admissionHash: s.seed.admissionHash },
        ),
        states: new Map(),
        inventory: null,
        outcome: null,
      };
      prefix = [];
      evidenceClosure.clear();
      authorities.clear();
      outputStates.clear();
      generationAdmission = null;
    } else {
      equal(s.seed, prior!.snapshot.seed);
      if (version.operation !== "acquireClaim")
        requireFact(s.admissionProof === prior!.snapshot.admissionProof);
    }
    requireFact(ledger);
    const active = ledger;
    requireFact(
      active.review.familyKey === familyKey &&
        fingerprint("fork-admission", active.review) === s.reviewHash,
    );
    requireFact(s.events.length >= prefix.length && s.events.length <= 100_000);
    equal(s.events.slice(0, prefix.length), prefix);
    const delta = s.events.slice(prefix.length);
    totalEvents += delta.length;
    requireFact(
      totalEvents <= 100_000 &&
        delta.every((e) => e.at === version.committedAt),
    );
    equal(
      p.authorityProofs,
      delta.flatMap((e) =>
        e.authorityProof === null ? [] : [e.authorityProof],
      ),
    );
    requireFact(new Set(p.authorityProofs).size === p.authorityProofs.length);

    const admission = await opened.admission(scope, s.admissionProof);
    const admitted = fact(admission.fact, "admission", scope, s.admissionProof);
    requireFact(admitted.kind === "admission");
    equal(admission.seed, s.seed);
    equal(admitted.payload.seed, s.seed);
    equal(admitted.payload.requests, admission.requests);
    equal(admitted.payload.predecessor, admission.predecessor);
    requireFact(
      (admission.predecessor === null) === (s.seed.predecessor === null),
    );
    if (admission.predecessor) {
      requireFact(
        historicalForkPredecessorReference(admission.predecessor) ===
          s.seed.predecessor,
      );
      const previous = predecessors.get(s.seed.predecessor!);
      requireFact(previous && previous.checkpoint?.state.outcome);
      equal(admission.predecessor, {
        familyKey,
        version: previous.version,
        reviewHash: previous.reviewHash,
        outcomeHash: previous.checkpoint.state.outcome.outcomeHash,
      });
    }
    if (generationAdmission) {
      equal(admitted.payload.requests, generationAdmission.payload.requests);
      equal(admitted.payload.packet, generationAdmission.payload.packet);
    } else generationAdmission = admitted;
    const packet = parseCertifiedForkReviewPromptPacket(
      admitted.payload.packet,
    );
    equal(packet.binding, admitted.payload.binding);
    requireFact(
      certifiedForkReviewBindingHash(packet.binding) ===
        active.review.bindingHash,
    );
    requireFact(
      packet.binding.sourceRepositoryId === s.seed.facts.sourceRepositoryId &&
        packet.binding.baseRepositoryId === s.seed.facts.baseRepositoryId &&
        packet.binding.pullRequestNumber === s.seed.facts.pullRequest &&
        packet.binding.reviewHeadSha === s.seed.facts.headSha &&
        packet.binding.baseSha === s.seed.facts.baseSha &&
        packet.binding.trustDomain === s.seed.facts.trustDomain,
    );
    const admittedRequests = admission.requests.map((request) =>
      createForkRequest(
        active.review,
        createForkEffect(active.review, request.slot),
        request.facts,
      ),
    );
    requireFact(
      new Set(admittedRequests.map((q) => q.effect.effectKey)).size ===
        admittedRequests.length,
    );
    requireFact(
      admittedRequests.every((q) => q.contextHash === packet.contextHash),
    );

    validateCommand(preimage, version, prior, delta, newGeneration);
    equal(
      p.claim,
      version.operation === "acquireClaim"
        ? s.claim
        : (prior?.snapshot.claim ?? null),
    );
    requireFact(
      r.ownerHash ===
        (version.operation === "acquireClaim"
          ? s.claim?.ownerHash
          : prior?.snapshot.claim?.ownerHash),
    );

    // Proofs exist only during this single event's constructor call. They never
    // implement ownership/authorize/issueCheckpoint or expose historical leases.
    async function evidence(
      proof: string,
      key: string,
      authorityProof: string | null,
    ) {
      const state = active.states.get(key);
      requireFact(state);
      const resolved = await opened.evidence(scope, proof, state);
      const stored = fact(resolved.fact, "evidence", scope, proof);
      requireFact(stored.kind === "evidence");
      equal(stored.payload.evidence, resolved.evidence);
      equal(stored.payload.originalScope, resolved.originalScope);
      const attempt = state.attempts.find(
        (a) => a.ordinal === resolved.evidence.attempt,
      );
      requireFact(attempt);
      equal(resolved.originalScope, {
        requestHash: state.request.requestHash,
        effectKey: key,
        attempt: attempt.ordinal,
        originEpoch: attempt.originEpoch,
        originClaimHash: attempt.originClaimHash,
        originOwnerHash: attempt.originOwnerHash,
        remoteScopeHash: state.request.remoteScopeHash,
      });
      requireFact(
        resolved.evidence.logicalKey === active.review.logicalKey &&
          resolved.evidence.effectKey === key &&
          resolved.evidence.requestHash === state.request.requestHash &&
          resolved.evidence.remoteScopeHash === state.request.remoteScopeHash &&
          resolved.evidence.originEpoch === attempt.originEpoch,
      );
      if (authorityProof !== null)
        requireFact(stored.payload.authorityProof === authorityProof);
      else {
        const original = evidenceClosure.get(
          fingerprint("fork-evidence", resolved.evidence),
        );
        requireFact(original);
        equal(resolved.evidence, original.evidence);
        // An alias must resolve its own authenticated authority edge to the
        // complete original event context, including command, claim and admission.
        const edge = await opened.authority(
          scope,
          stored.payload.authorityProof,
        );
        const authority = fact(
          edge.fact,
          "authority",
          scope,
          stored.payload.authorityProof,
        );
        requireFact(authority.kind === "authority");
        equal(edge.authority, authority.payload.authority);
        equal(edge.claim, authority.payload.claim);
        equal(authority.payload, original.authority);
        return original.evidence;
      }
      return resolved.evidence;
    }
    if (preimage.operation === "reconcile" && delta.length === 0) {
      const input = preimage.data.command;
      requireFact(input.kind === "evidence");
      const e = await evidence(input.proof, input.effectKey, null);
      requireFact(
        active.states
          .get(input.effectKey)!
          .attempts.some((a) => a.evidence.some((old) => sameArchive(old, e))),
      );
    }
    async function output(proof: string) {
      const resolved = await opened.output(scope, proof, commandRef);
      const stored = fact(resolved.fact, "output", scope, proof);
      requireFact(stored.kind === "output");
      // Retained bytes remain committed after later provider contradictions.
      // Revalidate against the immutable successful construction state, while
      // the outcome constructor below still consumes the latest ledger states.
      const state =
        outputStates.get(stored.payload.effectKey) ??
        active.states.get(stored.payload.effectKey);
      requireFact(state);
      const success = await evidence(
        stored.payload.successEvidenceProof,
        stored.payload.effectKey,
        null,
      );
      const checked = validateRetainedForkOutput(stored, {
        proofId: proof,
        scope,
        review: active.review,
        request: state.request,
        providerState: state,
        successEvidence: success,
        successEvidenceProof: stored.payload.successEvidenceProof,
        filePaths: packet.files.map((f) => f.path),
      });
      outputStates.set(stored.payload.effectKey, state);
      return {
        ...checked,
        durability: {
          disposition: "durably_committed" as const,
          outputCommitmentHash: checked.output.outputHash,
          commitReceiptHash: historicalForkOutputReceiptHash(stored),
        },
      };
    }
    for (const event of delta) {
      const input = event.input;
      const proofs: CertifiedForkEffectProofPort = {
        ownership: unavailable,
        authorize: unavailable,
        mutation: unavailable,
        issueCheckpoint: unavailable,
        restoreCheckpoint: unavailable,
        verifyLedger: unavailable,
        verifyReceipt: unavailable,
        predecessor: unavailable,
        admission: unavailable,
        authority: unavailable,
        evidence: unavailable,
        inventory: unavailable,
        durability: unavailable,
        retainedOutput: unavailable,
      };
      if (input.kind === "inventory") {
        requireFact(event.authorityProof === null);
        const plan = await opened.inventory(
          scope,
          input.completenessProof,
          event,
        );
        const stored = fact(
          plan.fact,
          "inventory",
          scope,
          input.completenessProof,
        );
        requireFact(stored.kind === "inventory");
        equal(stored.payload.plan, plan.requests);
        equal(stored.payload.dependencies, plan.entries);
        equal(plan.entries, input.entries);
        const requests = plan.requests.map((q) =>
          createForkRequest(
            active.review,
            createForkEffect(active.review, q.slot),
            q.facts,
          ),
        );
        requireFact(requests.length === active.states.size);
        for (const q of requests)
          equal(q, active.states.get(q.effect.effectKey)?.request ?? null);
        equal(
          stored.payload.expectedEffectKeys,
          requests.map((q) => q.effect.effectKey),
        );
        proofs.inventory = () => stored.payload.expectedEffectKeys;
        requireFact(
          (stored.payload.outputProof === null) === (input.output === null),
        );
        if (input.output) {
          requireFact(
            stored.payload.outputProof === input.output.durabilityProof,
          );
          const checked = await output(input.output.durabilityProof);
          requireFact(
            checked.output.effectKey === input.output.effectKey &&
              checked.output.canonicalOutputHash ===
                input.output.canonicalOutputHash,
          );
          proofs.durability = () => checked.durability;
        }
      } else if (input.kind === "outcome") {
        if (input.retainedProof !== null) {
          const checked = await output(input.retainedProof);
          equal(checked.output, active.inventory?.output ?? null);
          proofs.retainedOutput = () => undefined;
        }
      } else {
        requireFact(
          event.authorityProof !== null &&
            s.claim &&
            s.claim.expiresAt > event.at,
        );
        const resolved = await opened.authority(scope, event.authorityProof);
        const stored = fact(
          resolved.fact,
          "authority",
          scope,
          event.authorityProof,
        );
        requireFact(stored.kind === "authority");
        equal(stored.payload.authority, resolved.authority);
        equal(stored.payload.claim, resolved.claim);
        equal(resolved.claim, s.claim);
        requireFact(
          stored.payload.transactionTimeMs === event.at &&
            stored.payload.expiresAtMs === s.claim.expiresAt &&
            stored.payload.fence === s.fence &&
            stored.payload.version === s.version &&
            stored.payload.commandId === r.commandId &&
            stored.payload.admissionProof === s.admissionProof,
        );
        const a = resolved.authority;
        requireFact(
          a.logicalKey === active.review.logicalKey &&
            a.reviewHash === s.reviewHash &&
            a.epoch === s.fence &&
            a.claimHash === s.claim.claimHash &&
            a.ownerHash === s.claim.ownerHash &&
            a.validUntilHash ===
              fingerprint("fork-lease-expiry", s.claim.expiresAt),
        );
        requireFact(
          a.mode ===
            (["prepare", "begin", "retry"].includes(input.kind)
              ? "execute"
              : "reconcile"),
        );
        authorities.set(event.authorityProof, stored.payload);
        proofs.authority = () => a;
        if (input.kind === "prepare") {
          const q = createForkRequest(
            active.review,
            createForkEffect(active.review, input.request.slot),
            input.request.facts,
          );
          // Publication planning may be produced only after output exists; its
          // complete membership is independently authenticated at inventory.
          if (q.effect.slot.stage === "provider")
            requireFact(admittedRequests.some((old) => sameArchive(q, old)));
        }
        if (input.kind === "evidence") {
          const e = await evidence(
            input.proof,
            input.effectKey,
            event.authorityProof,
          );
          const verifier = createForkStateVerifier({
            authority: () => a,
            evidence: () => e,
          });
          requireFact(
            e.authorityHash ===
              forkAuthorityHash(verifier.authority(event.authorityProof)),
          );
          proofs.evidence = () => e;
        }
      }
      applyForkEvent(active, event, proofs, null);
      if (input.kind === "evidence") {
        const all = active.states
          .get(input.effectKey)!
          .attempts.flatMap((a) => a.evidence);
        const raw = proofs.evidence(input.proof);
        const minted = all.find((e) => sameArchive(e, raw));
        requireFact(minted);
        authentic("evidence", minted);
        const authority = authorities.get(event.authorityProof!);
        requireFact(authority);
        evidenceClosure.set(fingerprint("fork-evidence", minted), {
          evidence: minted,
          authority,
        });
      }
    }
    const state = Object.freeze({
      ...checkpointState(active),
      states: Object.freeze([...active.states.values()]),
    });
    equal(state, cp.state); // EVERY version, including no-event commands.
    equal(comparison(s, active), version.comparison);
    verified.push(Object.freeze({ archive: version, state }));
    prior = version;
  }
  // Capture private indexes only after the complete closure has passed. Returned
  // arrays/containers cannot mutate the baseline used by synchronous verification.
  const byVersion = new Map(
    verified.map((v) => [v.archive.snapshot.version, v]),
  );
  function known(snapshot: ForkLedgerSnapshot) {
    const captured = archiveSnapshot(snapshot);
    const v = byVersion.get(captured.version);
    requireFact(v);
    equal(captured, v.archive.snapshot);
    return v;
  }
  return Object.freeze({
    familyKey,
    tipVersion,
    versions: Object.freeze(verified),
    proofs: Object.freeze({
      verifyLedger(snapshot: ForkLedgerSnapshot) {
        known(snapshot);
      },
      restoreCheckpoint(
        checkpoint: NonNullable<ForkLedgerSnapshot["checkpoint"]>,
        snapshot: ForkLedgerSnapshot,
      ) {
        const v = known(snapshot);
        equal(checkpoint, v.archive.snapshot.checkpoint);
        return v.state;
      },
      verifyReceipt(receipt: ForkCommandReceipt, snapshot: ForkLedgerSnapshot) {
        const tip = known(snapshot);
        const original = byVersion.get(receipt.version);
        requireFact(original);
        requireFact(
          BigInt(receipt.version) <= BigInt(tip.archive.snapshot.version),
        );
        equal(receipt, original.archive.receipt);
      },
      predecessor(proof: string) {
        const snapshot = predecessors.get(proof);
        requireFact(snapshot);
        return snapshot;
      },
    }),
  });
}

function validateCommand(
  preimage: HistoricalForkPreimage,
  version: ForkArchiveVersion,
  prior: ForkArchiveVersion | null,
  delta: readonly ForkLedgerEvent[],
  newGeneration: boolean,
) {
  const s = version.snapshot,
    before = prior?.snapshot,
    at = version.committedAt;
  if (preimage.operation === "acquire") {
    requireFact(version.operation === "acquireClaim" && delta.length === 0);
    const d = preimage.data;
    exactForkFields(d, [
      "seed",
      "admissionProof",
      "ownerHash",
      "ttlMs",
      "commandId",
    ]);
    requireFact(
      d.commandId === version.receipt.commandId &&
        d.admissionProof === s.admissionProof,
    );
    equal(d.seed, s.seed);
    hash(d.ownerHash);
    positive(d.ttlMs);
    requireFact(d.ttlMs <= 300_000);
    requireFact(!before?.claim || before.claim.expiresAt <= at);
    requireFact(s.fence === next(before?.fence ?? "0"));
    equal(s.claim, {
      ownerHash: d.ownerHash,
      epoch: s.fence,
      expiresAt: positive(at + d.ttlMs),
      claimHash: fingerprint("fork-claim", {
        reviewHash: s.reviewHash,
        ownerHash: d.ownerHash,
        epoch: s.fence,
        at,
      }),
    });
    return;
  }
  requireFact(before?.claim && !newGeneration && before.claim.expiresAt > at);
  requireFact(s.fence === before.fence && before.claim.epoch === before.fence);
  equal(preimage.data.expected, prior!.comparison);
  if (preimage.operation === "release" || preimage.operation === "renew") {
    requireFact(
      version.operation ===
        (preimage.operation === "release" ? "releaseClaim" : "renewClaim") &&
        delta.length === 0,
    );
    exactForkFields(preimage.data, ["expected", "ttl"]);
    const ttl = preimage.data.ttl;
    requireFact(
      preimage.operation === "release" ? ttl === 0 : positive(ttl) <= 300_000,
    );
    equal(
      s.claim,
      preimage.operation === "release"
        ? null
        : {
            ...before.claim,
            expiresAt: positive(Math.max(before.claim.expiresAt, at + ttl)),
          },
    );
  } else {
    requireFact(version.operation === "compareAndCommit");
    equal(s.claim, before.claim);
    if (preimage.operation === "reconcile") {
      exactForkFields(preimage.data, ["expected", "command"]);
      requireFact(
        ["evidence", "stop", "seal", "outcome"].includes(
          preimage.data.command.kind,
        ),
      );
      requireFact(delta.length <= 1);
      if (delta.length === 1) equal(delta[0]!.input, preimage.data.command);
      else requireFact(preimage.data.command.kind === "evidence");
    } else {
      exactForkFields(preimage.data, ["expected", "inputs"]);
      requireFact(
        preimage.operation === "fork-historical-events-v1" && delta.length > 0,
      );
      equal(
        delta.map((e) => e.input),
        preimage.data.inputs,
      );
    }
  }
}
