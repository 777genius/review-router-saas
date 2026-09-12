import type { CertifiedForkEffectProofPort } from "../../application/ports/certified-fork-effect-proof-port.js";
import type {
  CertifiedForkEffectRepositoryPort,
  ForkLedgerInput,
  ForkLedgerSnapshot,
  ForkReviewSeed,
  ForkTransaction,
  ForkRequestSeed,
} from "../../application/ports/certified-fork-effect-repository-port.js";
import type {
  ForkArchiveOperation,
  ForkArchiveVersion,
} from "../../infrastructure/prisma/prisma-certified-fork-effect-repository.js";
import type {
  AnyRetainedFactInput,
  RetainedFactInput,
  RetainedFactKind,
  RetainedFactScope,
} from "../../infrastructure/prisma/certified-fork-proof-fact-types.js";
import type {
  HistoricalForkPreimage,
  ProtectedForkHistoricalSource,
  HistoricalForkAdmission,
  HistoricalForkAuthority,
  HistoricalForkEvidence,
  HistoricalForkInventory,
} from "../../infrastructure/proofs/certified-fork-historical-source.js";

export const h = (n: number) => n.toString(16).padStart(64, "0");
export const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v));
export type ColdFixtureDisk = {
  versions: ForkArchiveVersion[];
  facts: Record<string, AnyRetainedFactInput>;
  committedReads: Record<string, string[]>;
};
const fail = (): never => {
  throw new Error("test_source_not_provisioned");
};

/** Controlled test producers: all source facts are serialized separately from
 * checkpoints. No HMAC, artifact utility, snapshot restoration or warm registry
 * is used to authenticate/reconstruct cold checkpoints. NOT production custody. */
export async function coldHistoryFixture(
  options: {
    conflict?: boolean;
    retainedConflict?: boolean;
    refresh?: "release" | "expiry";
    aliases?: boolean;
  } = {},
) {
  const c: typeof import("../../domain/certified-fork-effect-canonical.js") =
    await import("../../domain/certified-fork-effect-canonical.js");
  const id = await import("../../domain/certified-fork-effect-identity.js");
  const domain = await import("../../domain/certified-fork-effect-state.js");
  const outcome = await import("../../domain/certified-fork-effect-outcome.js");
  const l =
    await import("../../application/services/certified-fork-effect-ledger.js");
  const codec =
    await import("../../infrastructure/prisma/certified-fork-archive-codec.js");
  const retained =
    await import("../../infrastructure/prisma/certified-fork-proof-fact-types.js");
  const restore =
    await import("../../infrastructure/proofs/restore-certified-fork-checkpoint.js");
  const claims =
    await import("../../application/use-cases/claim-certified-fork-review.js");
  const reconcile =
    await import("../../application/use-cases/reconcile-certified-fork-effect.js");
  const parser =
    await import("../../application/use-cases/certified-fork-review-packet.js");
  const { prepareCertifiedForkReview } =
    await import("../../application/use-cases/prepare-certified-fork-review.js");
  const binding =
    await import("../../application/use-cases/certified-fork-review-binding.js");
  const packet = prepareCertifiedForkReview({
    binding: {
      sourceRepository: "fork/source",
      sourceRepositoryId: "12",
      baseRepository: "owner/base",
      baseRepositoryId: "34",
      pullRequestNumber: 1,
      reviewHeadSha: "a".repeat(40),
      baseSha: "b".repeat(40),
      trustDomain: "fork",
    },
    files: [
      {
        path: "src/review.ts",
        status: "modified",
        additions: 1,
        deletions: 1,
        patch: "@@ -1 +1 @@\n-old\n+new\n",
      },
    ],
  });
  const baseSeed: ForkReviewSeed = {
    facts: {
      workspaceId: "tenant",
      repositoryId: "repo",
      sourceRepositoryId: "12",
      baseRepositoryId: "34",
      pullRequest: 1,
      headSha: "a".repeat(40),
      baseSha: "b".repeat(40),
      trustDomain: "fork",
      generation: "0",
    },
    bindingHash: binding.certifiedForkReviewBindingHash(packet.binding),
    admissionHash: null,
    predecessor: null,
  };
  const disk: ColdFixtureDisk = { versions: [], facts: {}, committedReads: {} };
  let current: ForkLedgerSnapshot | null = null;
  let at = 100,
    owner = h(20),
    serial = 0;
  let seed = baseSeed;
  let review = id.createForkReview(seed.facts, seed.bindingHash);
  let ledger: import("../../application/services/certified-fork-effect-ledger.js").ForkRebuiltLedger =
    { review, states: new Map(), inventory: null, outcome: null };
  let pending: HistoricalForkPreimage | null = null;
  let admissionProof = "admission-0";
  const scope = (): RetainedFactScope => ({
    workspaceId: "tenant",
    repositoryConnectionId: "repo",
    familyKey: review.familyKey,
    reviewHash: c.fingerprint("fork-admission", review),
  });
  function put<K extends RetainedFactKind>(
    kind: K,
    proofId: string,
    payload: RetainedFactInput<K>["payload"],
  ) {
    disk.facts[proofId] = retained.parseRetainedFact({
      kind,
      proofId,
      scope: scope(),
      provenance: {
        producerKind: "controlled-test",
        producerId: `test-${kind}`,
        producerVersion: "1",
        sourceKey: proofId,
        sourceRevision: "1",
        observedAtMs: at,
        validUntilMs: at + 300_000,
      },
      payload,
    });
  }
  function get<K extends RetainedFactKind>(
    proof: string,
    kind: K,
  ): RetainedFactInput<K> {
    const f = disk.facts[proof];
    c.requireFact(f?.kind === kind);
    return f as RetainedFactInput<K>;
  }
  const providerSeed = (): ForkRequestSeed => ({
    slot: { stage: "provider", role: "review", slot: 1 },
    facts: {
      contextHash: packet.contextHash,
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
  });
  function admit() {
    const previous = disk.versions.find(
      (v) =>
        seed.predecessor ===
        restore.historicalForkPredecessorReference({
          familyKey: v.snapshot.familyKey,
          version: v.snapshot.version,
          reviewHash: v.snapshot.reviewHash,
          outcomeHash: v.comparison.outcomeHash ?? h(0),
        }),
    );
    put("admission", admissionProof, {
      seed: copy(seed),
      binding: copy(packet.binding),
      packet: copy(packet),
      requests: [copy(providerSeed())],
      remoteScopes: [],
      decisions: { testDecision: "admit-original-preimages" },
      gatewayObservation: { testPrincipal: owner },
      observationDeadlineMs: at + 300_000,
      policyVersion: "test-1",
      predecessor:
        seed.predecessor === null
          ? null
          : {
              familyKey: previous!.snapshot.familyKey,
              version: previous!.snapshot.version,
              reviewHash: previous!.snapshot.reviewHash,
              outcomeHash: previous!.comparison.outcomeHash!,
            },
    });
  }
  const liveStates = new Map<string, ReturnType<typeof l.checkpointState>>();
  const proofs: CertifiedForkEffectProofPort = {
    issueCheckpoint(snapshot, state, position) {
      const cp = {
        proof: `checkpoint-${snapshot.version}`,
        prefixLength: snapshot.events.length,
        prefixHash: l.forkLedgerHash(snapshot),
        anchorHash: l.checkpointAnchor(snapshot),
        position,
        state,
      };
      liveStates.set(cp.proof, state);
      return cp;
    },
    restoreCheckpoint(cp) {
      return liveStates.get(cp.proof) ?? fail();
    },
    verifyLedger(snapshot) {
      c.requireFact(
        snapshot.checkpoint && liveStates.has(snapshot.checkpoint.proof),
      );
    },
    verifyReceipt(receipt) {
      c.requireFact(
        disk.versions.some((v) => codec.sameArchive(v.receipt, receipt)),
      );
    },
    predecessor(proof) {
      return (
        disk.versions.find(
          (v) =>
            v.comparison.outcomeHash !== null &&
            restore.historicalForkPredecessorReference({
              familyKey: v.snapshot.familyKey,
              version: v.snapshot.version,
              reviewHash: v.snapshot.reviewHash,
              outcomeHash: v.comparison.outcomeHash,
            }) === proof,
        )?.snapshot ?? fail()
      );
    },
    ownership(_proof, expected) {
      c.requireFact(expected === owner);
    },
    admission(proof, proposed) {
      c.requireFact(
        proof === admissionProof && codec.sameArchive(proposed, review),
      );
    },
    authorize: fail,
    mutation() {},
    authority(proof) {
      return get(proof, "authority").payload
        .authority as unknown as import("../../domain/certified-fork-effect-state.js").ForkAuthority;
    },
    evidence(proof) {
      return get(proof, "evidence").payload
        .evidence as unknown as import("../../domain/certified-fork-effect-state.js").ForkEvidence;
    },
    inventory(proof) {
      return get(proof, "inventory").payload.expectedEffectKeys;
    },
    durability(proof, output) {
      c.requireFact(
        get(proof, "output").payload.outputCommitmentHash === output.outputHash,
      );
      return {
        disposition: "durably_committed",
        outputCommitmentHash: output.outputHash,
        commitReceiptHash: restore.historicalForkOutputReceiptHash(
          get(proof, "output"),
        ),
      };
    },
    retainedOutput(proof, output) {
      c.requireFact(
        get(proof, "output").payload.outputCommitmentHash === output.outputHash,
      );
    },
  };
  async function commit(operation: ForkArchiveOperation, tx: ForkTransaction) {
    c.requireFact(pending);
    at++;
    const before = current,
      expected = before ? codec.checkpointComparison(before) : null;
    const committedReads = Object.keys(disk.facts);
    const built = tx.build(before, at);
    const s = built.snapshot;
    const cp = proofs.issueCheckpoint(s, built.state, {
      commandId: tx.commandId,
      commandHash: tx.commandHash,
    });
    current = { ...s, checkpoint: cp };
    ledger = {
      ...built.state,
      states: new Map(
        built.state.states.map((s) => [s.request.effect.effectKey, s]),
      ),
    };
    const receipt = {
      commandId: tx.commandId,
      commandHash: tx.commandHash,
      version: s.version,
      reviewHash: s.reviewHash,
      ownerHash:
        operation === "acquireClaim"
          ? s.claim!.ownerHash
          : before!.claim!.ownerHash,
    };
    const prefixLength =
      before?.seed.facts.generation === s.seed.facts.generation
        ? before.events.length
        : 0;
    put(
      "command",
      restore.historicalForkCommandReference(
        s.familyKey,
        s.version,
        tx.commandId,
      ),
      {
        operation,
        preimage: copy(pending),
        comparison: copy(expected),
        principal: { ownerHash: receipt.ownerHash },
        claim: copy(operation === "acquireClaim" ? s.claim : before!.claim),
        version: s.version,
        commandId: tx.commandId,
        commandHash: tx.commandHash,
        admissionProof: s.admissionProof,
        authorityProofs: s.events
          .slice(prefixLength)
          .flatMap((e) =>
            e.authorityProof === null ? [] : [e.authorityProof],
          ),
      },
    );
    disk.committedReads[
      restore.historicalForkCommandReference(
        s.familyKey,
        s.version,
        tx.commandId,
      )
    ] = committedReads;
    disk.versions.push({
      snapshot: current,
      receipt,
      operation,
      comparison: l.comparison(current, ledger),
      committedAt: at,
    });
    pending = null;
    return { snapshot: current, receipt };
  }
  const repository: CertifiedForkEffectRepositoryPort = {
    async loadReview(_family, commandId) {
      return {
        snapshot: current,
        receipt:
          disk.versions.find((v) => v.receipt.commandId === commandId)
            ?.receipt ?? null,
      };
    },
    acquireClaim: (tx) => commit("acquireClaim", tx),
    renewClaim: (tx) => commit("renewClaim", tx),
    releaseClaim: (tx) => commit("releaseClaim", tx),
    compareAndCommit: (tx) => commit("compareAndCommit", tx),
  };
  const deps = {
    enabled: true,
    repository,
    proofs,
    ownerProof: "controlled-current-owner",
  };
  async function acquire() {
    const input = {
      seed,
      admissionProof,
      ownerHash: owner,
      ttlMs: 120_000,
      commandId: `acquire-${++serial}`,
    };
    pending = { operation: "acquire", data: input };
    await claims.claimCertifiedForkReview(deps, input);
  }
  async function manage(operation: "renew" | "release") {
    c.requireFact(current);
    pending = {
      operation,
      data: {
        expected: l.comparison(current, ledger),
        ttl: operation === "renew" ? 150_000 : 0,
      },
    };
    await claims.manageCertifiedForkClaim(deps, {
      operation,
      expected: current,
      commandId: `${operation}-${++serial}`,
      ...(operation === "renew" ? { ttlMs: 150_000 } : {}),
    });
  }
  async function append(
    input: ForkLedgerInput,
    beforeEvent?: (authorityProof: string | null) => void,
  ) {
    c.requireFact(current);
    const prior = current,
      expected = l.comparison(prior, ledger),
      commandId = `import-${++serial}`;
    pending = {
      operation: "fork-historical-events-v1",
      data: { expected, inputs: [input] },
    };
    const preimage = pending;
    await repository.compareAndCommit({
      familyKey: prior.familyKey,
      commandId,
      commandHash: l.commandHash(preimage.operation, preimage.data),
      expected,
      build(_current, time) {
        const authorityProof = ["inventory", "outcome"].includes(input.kind)
          ? null
          : `authority-${serial}`;
        if (authorityProof) {
          const key = "effectKey" in input ? input.effectKey : "";
          put("authority", authorityProof, {
            authority: {
              logicalKey: review.logicalKey,
              reviewHash: prior.reviewHash,
              epoch: prior.fence,
              claimHash: prior.claim!.claimHash,
              ownerHash: prior.claim!.ownerHash,
              revision: ledger.states.get(key)?.revision ?? "0",
              mode: ["prepare", "begin", "retry"].includes(input.kind)
                ? "execute"
                : "reconcile",
              validUntilHash: c.fingerprint(
                "fork-lease-expiry",
                prior.claim!.expiresAt,
              ),
            },
            transactionTimeMs: time,
            expiresAtMs: prior.claim!.expiresAt,
            claim: copy(prior.claim!),
            fence: prior.fence,
            version: c.next(prior.version),
            commandId,
            admissionProof,
            principal: { ownerHash: owner },
          });
        }
        beforeEvent?.(authorityProof);
        const event = { at: time, input, authorityProof };
        l.applyForkEvent(ledger, event, proofs, prior.claim);
        return l.preparedForkCommit(
          { ...l.advanced(prior), events: [...prior.events, event] },
          ledger,
        );
      },
    });
  }
  async function lifecycle() {
    const generation = seed.facts.generation;
    const request = providerSeed();
    const q = id.createForkRequest(
      review,
      id.createForkEffect(review, request.slot),
      request.facts,
    );
    const key = q.effect.effectKey,
      successProof = `success-${generation}`,
      outputProof = `output-${generation}`;
    const modelOutput = {
      protocolVersion: 1 as const,
      summaryMarkdown: "Review ✓",
      findings: [
        {
          severity: "minor" as const,
          title: "Naming",
          body: "Use a clearer name.",
          path: "src/review.ts",
          startLine: 1,
          endLine: 1,
        },
      ],
    };
    const paths = packet.files.map((f) => f.path);
    const resultHash = parser.certifiedForkReviewModelOutputHash(
      modelOutput,
      paths,
    );
    await append({ kind: "prepare", request });
    await append({ kind: "begin", effectKey: key });
    function success(
      proof: string,
      effectKey: string,
      result: string,
      authorityProof: string | null,
      kind: "success" | "no_effect" | "unknown" = "success",
    ) {
      c.requireFact(authorityProof);
      const state = ledger.states.get(effectKey)!,
        attempt = state.attempts.at(-1)!;
      const a = domain
        .createForkStateVerifier({
          authority: () =>
            proofs.authority(authorityProof, {
              review,
              revision: state.revision,
              at,
              mode: null,
              claim: null,
            }),
          evidence: fail,
        })
        .authority(authorityProof);
      put("evidence", proof, {
        evidence: {
          logicalKey: review.logicalKey,
          effectKey,
          requestHash: state.request.requestHash,
          attempt: attempt.ordinal,
          originEpoch: attempt.originEpoch,
          remoteScopeHash: state.request.remoteScopeHash,
          authorityHash: domain.forkAuthorityHash(a),
          kind,
          source: effectKey === key ? "provider_receipt" : "github_app_receipt",
          verifierHash: h(71),
          evidenceHash: h(serial),
          externalRefHash: kind === "success" ? h(serial + 200) : null,
          resultHash: kind === "success" ? result : null,
          disposition:
            kind === "success"
              ? "authenticated_success"
              : kind === "no_effect"
                ? "definitive_no_effect"
                : "indeterminate",
          senderClosure: "closed",
          reason:
            kind === "success"
              ? "confirmed"
              : kind === "no_effect"
                ? "rejected"
                : "timeout",
        },
        authorityProof,
        response: { testAuthenticated: true },
        bodyBytes: "controlled response",
        senderClosure: { testClosed: true },
        originalScope: {
          requestHash: state.request.requestHash,
          effectKey,
          attempt: attempt.ordinal,
          originEpoch: attempt.originEpoch,
          originClaimHash: attempt.originClaimHash,
          originOwnerHash: attempt.originOwnerHash,
          remoteScopeHash: state.request.remoteScopeHash,
        },
      });
    }
    await append(
      { kind: "evidence", effectKey: key, proof: `no-effect-${generation}` },
      (a) =>
        success(`no-effect-${generation}`, key, resultHash, a, "no_effect"),
    );
    await append({ kind: "retry", effectKey: key });
    await append({ kind: "begin", effectKey: key });
    await append(
      { kind: "evidence", effectKey: key, proof: `unknown-${generation}` },
      (a) => success(`unknown-${generation}`, key, resultHash, a, "unknown"),
    );
    await append(
      { kind: "evidence", effectKey: key, proof: successProof },
      (a) => success(successProof, key, resultHash, a),
    );
    const output = outcome.createForkOutput(ledger.states.get(key)!, {
      bindingHash: review.bindingHash,
      contextHash: packet.contextHash,
      canonicalOutputHash: resultHash,
    });
    const outputSuccess = options.aliases
      ? `output-success-alias-${generation}`
      : successProof;
    if (options.aliases)
      put(
        "evidence",
        outputSuccess,
        copy(get(successProof, "evidence").payload),
      );
    put("output", outputProof, {
      modelOutput,
      outputBytes: parser.serializeCertifiedForkReviewModelOutput(
        modelOutput,
        paths,
      ),
      filePaths: paths,
      bindingHash: review.bindingHash,
      contextHash: packet.contextHash,
      requestHash: q.requestHash,
      effectKey: key,
      successEvidenceProof: outputSuccess,
      outputCommitmentHash: output.outputHash,
      commitIdentity: `test-commit-${generation}`,
      committedAtMs: at,
      sourceArtifact: null,
    });
    const publication: ForkRequestSeed = {
      slot: { stage: "publication", role: "inline", slot: 1 },
      facts: {
        contextHash: packet.contextHash,
        adapterContractHash: h(3),
        schemaHash: h(4),
        outputCommitmentHash: output.outputHash,
        frozenPlanHash: h(13),
        appId: "app",
        installationId: "installation",
        baseRepositoryId: "34",
        pullRequest: 1,
        commitSha: seed.facts.headSha,
        objectTargetHash: h(14),
        renderPolicyHash: h(15),
        payloadHashes: [h(16)],
        markerHash: h(17),
      },
    };
    const publicationKey = id.createForkEffect(
      review,
      publication.slot,
    ).effectKey;
    await append({ kind: "prepare", request: publication });
    const planProof = `plan-${generation}`,
      entries = [
        { effectKey: key, dependencies: [] },
        { effectKey: publicationKey, dependencies: [key] },
      ];
    put("inventory", planProof, {
      plan: [copy(request), copy(publication)],
      dependencies: entries,
      expectedEffectKeys: [key, publicationKey],
      plannerVersion: "test-1",
      renderVersion: "test-1",
      limitsVersion: "test-1",
      outputProof,
    });
    await append({
      kind: "inventory",
      entries,
      completenessProof: planProof,
      output: {
        effectKey: key,
        canonicalOutputHash: resultHash,
        durabilityProof: outputProof,
      },
    });
    await append({ kind: "begin", effectKey: publicationKey });
    await append(
      {
        kind: "evidence",
        effectKey: publicationKey,
        proof: `publication-success-${generation}`,
      },
      (a) =>
        success(`publication-success-${generation}`, publicationKey, h(16), a),
    );
    await append({ kind: "seal", effectKey: key });
    await append({ kind: "seal", effectKey: publicationKey });
    await append({
      kind: "outcome",
      availability: "available",
      retainedProof: outputProof,
    });
    c.requireFact(ledger.outcome?.status === "completed");
    return { key, successProof };
  }
  admit();
  await acquire();
  const first = await lifecycle();
  if (options.conflict) {
    await append(
      { kind: "evidence", effectKey: first.key, proof: "conflict-0" },
      (authorityProof) => {
        c.requireFact(authorityProof);
        const previous = get(first.successProof, "evidence").payload;
        const authority = domain
          .createForkStateVerifier({
            authority: () =>
              get(authorityProof, "authority").payload
                .authority as unknown as import("../../domain/certified-fork-effect-state.js").ForkAuthority,
            evidence: fail,
          })
          .authority(authorityProof);
        put("evidence", "conflict-0", {
          ...previous,
          authorityProof,
          evidence: {
            ...previous.evidence,
            authorityHash: domain.forkAuthorityHash(authority),
            kind: "conflict",
            disposition: "duplicate_effects",
            reason: "duplicate_remote_effects",
            externalRefHash: null,
            resultHash: null,
            evidenceHash: h(199),
          },
        });
      },
    );
    const expectedSnapshot = current!;
    const command = {
      kind: "outcome" as const,
      availability: options.retainedConflict
        ? ("available" as const)
        : ("unavailable" as const),
      retainedProof: options.retainedConflict ? "output-0" : null,
    };
    pending = {
      operation: "reconcile",
      data: { expected: l.comparison(expectedSnapshot, ledger), command },
    };
    await reconcile.reconcileCertifiedForkEffect(deps, {
      expected: expectedSnapshot,
      commandId: `conflict-outcome-${++serial}`,
      command,
    });
    return {
      disk: copy(disk),
      warmState: ledger.review,
      duplicateVersion: "0",
      familyKey: review.familyKey,
    };
  }
  // Actual reconciliation writer: repeated outcomes extend an immutable chain
  // past the live replay suffix limit, without using any restoration shortcut.
  for (let i = 0; i < 25; i++) {
    const expectedSnapshot = disk.versions.at(-1)!.snapshot;
    const command = {
      kind: "outcome" as const,
      availability: "available" as const,
      retainedProof: "output-0",
    };
    pending = {
      operation: "reconcile",
      data: { expected: l.comparison(expectedSnapshot, ledger), command },
    };
    await reconcile.reconcileCertifiedForkEffect(deps, {
      expected: expectedSnapshot,
      commandId: `outcome-${++serial}`,
      command,
    });
  }
  async function duplicate(target = first) {
    const alias = options.aliases
      ? `duplicate-alias-${serial}`
      : target.successProof;
    if (options.aliases)
      put(
        "evidence",
        alias,
        copy(get(target.successProof, "evidence").payload),
      );
    const duplicateSnapshot = disk.versions.at(-1)!.snapshot;
    const duplicateInput = {
      kind: "evidence" as const,
      effectKey: target.key,
      proof: alias,
    };
    pending = {
      operation: "reconcile",
      data: {
        expected: l.comparison(duplicateSnapshot, ledger),
        command: duplicateInput,
      },
    };
    await reconcile.reconcileCertifiedForkEffect(deps, {
      expected: duplicateSnapshot,
      commandId: `duplicate-${++serial}`,
      command: duplicateInput,
    });
  }
  await duplicate();
  await manage("renew");
  if (options.refresh === "expiry") at = current!.claim!.expiresAt;
  else await manage("release");
  owner = h(21);
  if (options.refresh) {
    admissionProof = "admission-refreshed-0";
    admit();
  }
  await acquire();
  if (options.refresh) await manage("renew");
  await duplicate();
  const duplicateVersion = disk.versions.at(-1)!.snapshot.version;
  for (const generation of ["1", "2"]) {
    await manage("release");
    const previous = disk.versions.at(-1)!;
    const predecessor = restore.historicalForkPredecessorReference({
      familyKey: review.familyKey,
      version: previous.snapshot.version,
      reviewHash: previous.snapshot.reviewHash,
      outcomeHash: ledger.outcome!.outcomeHash,
    });
    seed = {
      ...baseSeed,
      facts: { ...baseSeed.facts, generation },
      admissionHash: h(80 + Number(generation)),
      predecessor,
    };
    review = outcome.createForkReviewFromOutcome(
      seed.facts,
      seed.bindingHash,
      ledger.outcome,
      { admissionHash: seed.admissionHash! },
    );
    admissionProof = `admission-${generation}`;
    admit();
    await acquire();
    if (generation === "1") {
      const next = await lifecycle();
      if (options.refresh) {
        await duplicate(next);
        if (options.refresh === "expiry") at = current!.claim!.expiresAt;
        else await manage("release");
        owner = h(22);
        admissionProof = "admission-refreshed-1";
        admit();
        await acquire();
        await manage("renew");
        await duplicate(next);
      }
    }
  }
  return {
    disk: copy(disk),
    warmState: ledger.review,
    duplicateVersion,
    familyKey: review.familyKey,
  };
}

/** Fixture-only authenticated resolver. A private controlled disk is its custody
 * root; nested producer receipts use a closed test convention. Deliberately not
 * exported from production, not a production verifier or accepted legacy source. */
export function controlledColdSource(
  disk: ColdFixtureDisk,
): ProtectedForkHistoricalSource {
  function read<K extends RetainedFactKind>(
    scope: RetainedFactScope,
    proof: string,
    kind: K,
  ): RetainedFactInput<K> {
    const f = disk.facts[proof];
    if (
      !f ||
      f.kind !== kind ||
      f.provenance.producerKind !== "controlled-test" ||
      f.provenance.producerId !== `test-${kind}` ||
      f.provenance.producerVersion !== "1" ||
      Object.entries(scope).some(
        ([key, value]) => f.scope[key as keyof RetainedFactScope] !== value,
      )
    )
      fail();
    return copy(f) as RetainedFactInput<K>;
  }
  return {
    async open(familyKey) {
      return {
        familyKey,
        tipVersion: disk.versions.at(-1)!.snapshot.version,
        versions: copy(disk.versions),
        async admission(scope, proof) {
          const fact = read(scope, proof, "admission");
          return {
            fact,
            seed: fact.payload.seed as unknown as ForkReviewSeed,
            requests: fact.payload.requests as unknown as ForkRequestSeed[],
            predecessor: fact.payload
              .predecessor as unknown as HistoricalForkAdmission["predecessor"],
          };
        },
        async command(scope, proof) {
          const fact = read(scope, proof, "command");
          return {
            fact,
            preimage: fact.payload
              .preimage as unknown as HistoricalForkPreimage,
            ownerHash: String(fact.payload.principal.ownerHash),
          };
        },
        async authority(scope, proof) {
          const fact = read(scope, proof, "authority");
          return {
            fact,
            authority: fact.payload
              .authority as unknown as HistoricalForkAuthority["authority"],
            claim: fact.payload
              .claim as unknown as HistoricalForkAuthority["claim"],
          };
        },
        async evidence(scope, proof) {
          const fact = read(scope, proof, "evidence");
          if (
            fact.payload.response.testAuthenticated !== true ||
            fact.payload.senderClosure.testClosed !== true
          )
            fail();
          return {
            fact,
            evidence: fact.payload
              .evidence as unknown as HistoricalForkEvidence["evidence"],
            originalScope: fact.payload
              .originalScope as unknown as HistoricalForkEvidence["originalScope"],
          };
        },
        async inventory(scope, proof) {
          const fact = read(scope, proof, "inventory");
          return {
            fact,
            requests: fact.payload
              .plan as unknown as HistoricalForkInventory["requests"],
            entries: fact.payload
              .dependencies as unknown as HistoricalForkInventory["entries"],
          };
        },
        async output(scope, proof, command) {
          const fact = read(scope, proof, "output");
          if (
            !disk.facts[command] ||
            !disk.committedReads[command]?.includes(proof) ||
            !fact.payload.commitIdentity.startsWith("test-commit-")
          )
            fail();
          return { fact };
        },
      };
    },
  };
}
