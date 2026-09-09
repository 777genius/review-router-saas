import { describe, expect, it, vi } from "vitest";
import type {
  ForkAuthority,
  ForkEvidence,
} from "../domain/certified-fork-effect-state.js";
import type { RetainedForkOutputContext } from "../infrastructure/proofs/certified-fork-retained-output.js";

const h = (n: number) => n.toString(16).padStart(64, "0");
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));

// Each call loads constructors from the current registry and independently issues
// controlled authenticated receipt/authority handles. Stored output is never used
// as authority/evidence input. This is a semantic unit fixture, not a real producer.
async function fixture(resultOverride?: string) {
  const identity = await import("../domain/certified-fork-effect-identity.js");
  const domain = await import("../domain/certified-fork-effect-state.js");
  const canonical =
    await import("../domain/certified-fork-effect-canonical.js");
  const outcome = await import("../domain/certified-fork-effect-outcome.js");
  const parser =
    await import("../application/use-cases/certified-fork-review-packet.js");
  const binding =
    await import("../application/use-cases/certified-fork-review-binding.js");
  const { prepareCertifiedForkReview } =
    await import("../application/use-cases/prepare-certified-fork-review.js");
  const { validateRetainedForkOutput: validate } =
    await import("../infrastructure/proofs/certified-fork-retained-output.js");
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
    files: ["src/review.ts", "README.md"].map((path) => ({
      path,
      status: "modified",
      additions: 1,
      deletions: 1,
      patch: "@@ -1 +1 @@\n-old\n+new\n",
    })),
  });
  const paths = packet.files.map((file) => file.path);
  const review = identity.createForkReview(
    {
      workspaceId: "w",
      repositoryId: "r",
      sourceRepositoryId: "12",
      baseRepositoryId: "34",
      pullRequest: 1,
      headSha: "a".repeat(40),
      baseSha: "b".repeat(40),
      trustDomain: "fork",
      generation: "0",
    },
    binding.certifiedForkReviewBindingHash(packet.binding),
  );
  const effect = identity.createForkEffect(review, {
    stage: "provider",
    role: "review",
    slot: 1,
  });
  const request = identity.createForkRequest(review, effect, {
    contextHash: packet.contextHash,
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
  });
  const modelOutput = parser.parseCertifiedForkReviewModelOutput(
    {
      protocolVersion: 1,
      summaryMarkdown: "Review ✓",
      findings: [
        {
          severity: "minor",
          title: "Naming",
          body: "Use a clearer name.",
          path: paths[0],
          startLine: 2,
          endLine: 3,
        },
      ],
    },
    paths,
  );
  const resultHash = parser.certifiedForkReviewModelOutputHash(
    modelOutput,
    paths,
  );
  const authorities = new WeakMap<object, ForkAuthority>();
  const receipts = new WeakMap<object, ForkEvidence>();
  const verifier = domain.createForkStateVerifier({
    authority: (proof: object) => {
      const facts = authorities.get(proof);
      if (!facts) throw new Error("unauthenticated authority");
      return facts;
    },
    evidence: (proof: object) => {
      const facts = receipts.get(proof);
      if (!facts) throw new Error("unauthenticated receipt");
      return facts;
    },
  });
  const authority = (revision: string) => {
    const proof = {};
    authorities.set(proof, {
      logicalKey: review.logicalKey,
      reviewHash: canonical.fingerprint("fork-admission", review),
      epoch: "1",
      claimHash: h(12),
      ownerHash: h(13),
      revision,
      mode: "execute",
      validUntilHash: h(14),
    });
    return verifier.authority(proof);
  };
  const issueEvidence = (facts: ForkEvidence) => {
    const proof = {};
    receipts.set(proof, facts);
    return verifier.evidence(proof);
  };
  const prepared = domain.prepareForkEffect(request, authority("0"));
  const begun = domain.transitionForkEffect(
    prepared,
    authority(prepared.revision),
    { kind: "begin", inventory: null, states: [] },
  );
  const settledAuthority = authority(begun.revision);
  const successEvidence = issueEvidence({
    logicalKey: review.logicalKey,
    effectKey: effect.effectKey,
    requestHash: request.requestHash,
    attempt: "0",
    originEpoch: "1",
    remoteScopeHash: request.remoteScopeHash,
    authorityHash: domain.forkAuthorityHash(settledAuthority),
    kind: "success",
    source: "provider_receipt",
    verifierHash: h(15),
    evidenceHash: h(16),
    externalRefHash: h(17),
    resultHash: resultOverride ?? resultHash,
    disposition: "authenticated_success",
    senderClosure: "closed",
    reason: "confirmed",
  });
  const state = domain.transitionForkEffect(begun, settledAuthority, {
    kind: "evidence",
    evidence: successEvidence,
  });
  const output = outcome.createForkOutput(state, {
    bindingHash: review.bindingHash,
    contextHash: request.contextHash,
    canonicalOutputHash: resultOverride ?? resultHash,
  });
  const scope = {
    workspaceId: "w",
    repositoryConnectionId: "r",
    familyKey: review.familyKey,
    reviewHash: canonical.fingerprint("fork-admission", review),
  };
  const fact = {
    proofId: "output/1",
    kind: "output" as const,
    scope,
    provenance: {
      producerKind: "test-controlled-source",
      producerId: "fixture",
      producerVersion: "1",
      sourceKey: "response/1",
      sourceRevision: "1",
      observedAtMs: 1,
      validUntilMs: 2,
    },
    payload: {
      modelOutput,
      outputBytes: parser.serializeCertifiedForkReviewModelOutput(
        modelOutput,
        paths,
      ),
      filePaths: paths,
      bindingHash: review.bindingHash,
      contextHash: request.contextHash,
      requestHash: request.requestHash,
      effectKey: effect.effectKey,
      successEvidenceProof: "success/1",
      outputCommitmentHash: output.outputHash,
      commitIdentity: "commit/1",
      committedAtMs: 1,
      sourceArtifact: null,
    },
  };
  const trusted: RetainedForkOutputContext = {
    proofId: fact.proofId,
    scope,
    review,
    request,
    providerState: state,
    successEvidence,
    successEvidenceProof: "success/1",
    filePaths: paths,
  };
  return {
    validate,
    trusted,
    fact,
    output,
    canonical,
    parser,
    identity,
    domain,
    authority,
    issueEvidence,
    prepared,
    begun,
  };
}

describe("retained certified Fork output semantics", () => {
  it("reconstructs a detached immutable domain commitment from canonical retained UTF-8", async () => {
    const f = await fixture();
    const dto = copy(f.fact);
    const result = f.validate(dto, f.trusted);
    expect(result.output).toEqual(f.output);
    expect(result.output).not.toBe(f.output);
    expect(f.canonical.authentic("output", result.output)).toBe(result.output);
    expect(result.outputBytes).toBe(f.fact.payload.outputBytes);
    expect(Object.isFrozen(result.modelOutput.findings[0])).toBe(true);
    Reflect.set(dto.payload.modelOutput.findings[0]!, "body", "changed");
    expect(result.modelOutput.findings[0]!.body).toBe("Use a clearer name.");
    expect(() => f.canonical.authentic("durability", result)).toThrow();
  });

  it.each([
    "proofId",
    "kind",
    "scope.workspaceId",
    "scope.repositoryConnectionId",
    "scope.familyKey",
    "scope.reviewHash",
    "payload.bindingHash",
    "payload.contextHash",
    "payload.requestHash",
    "payload.effectKey",
    "payload.successEvidenceProof",
    "payload.outputCommitmentHash",
  ])("rejects altered %s", async (field) => {
    const f = await fixture();
    const dto = copy(f.fact);
    const [parent, child] = field.split(".");
    const record = (child ? Reflect.get(dto, parent!) : dto) as Record<
      string,
      unknown
    >;
    record[child ?? parent!] =
      field.endsWith("Hash") || field.endsWith("Key") ? h(999) : "substitution";
    expect(() => f.validate(dto, f.trusted)).toThrow();
  });

  it.each(["whitespace", "different-json", "truncated", "unicode-escape"])(
    "rejects noncanonical bytes: %s",
    async (kind) => {
      const f = await fixture();
      const dto = copy(f.fact);
      dto.payload.outputBytes =
        kind === "whitespace"
          ? `${dto.payload.outputBytes}\n`
          : kind === "different-json"
            ? "{}"
            : kind === "truncated"
              ? dto.payload.outputBytes.slice(0, -1)
              : dto.payload.outputBytes.replace("✓", "\\u2713");
      expect(() => f.validate(dto, f.trusted)).toThrow();
    },
  );

  it.each([
    "unknown-path",
    "reversed-lines",
    "bad-severity",
    "extra-key",
    "missing-body",
    "too-many-findings",
  ])("rejects malformed nested output: %s", async (kind) => {
    const f = await fixture();
    const dto = copy(f.fact);
    const finding = dto.payload.modelOutput.findings[0]!;
    if (kind === "unknown-path") Reflect.set(finding, "path", "src/other.ts");
    if (kind === "reversed-lines") Reflect.set(finding, "endLine", 1);
    if (kind === "bad-severity") Reflect.set(finding, "severity", "fatal");
    if (kind === "extra-key") Reflect.set(finding, "ignored", "attack");
    if (kind === "missing-body") Reflect.deleteProperty(finding, "body");
    if (kind === "too-many-findings")
      Reflect.set(
        dto.payload.modelOutput,
        "findings",
        Array(f.parser.certifiedForkReviewMaxFindings + 1).fill(finding),
      );
    dto.payload.outputBytes = JSON.stringify(dto.payload.modelOutput);
    expect(() => f.validate(dto, f.trusted)).toThrow();
  });

  it.each(["replace", "omit", "append", "reorder", "duplicate"])(
    "rejects retained file list %s even without a finding at the changed path",
    async (kind) => {
      const f = await fixture();
      const dto = copy(f.fact);
      if (kind === "replace") dto.payload.filePaths[1] = "substitute.md";
      if (kind === "omit") dto.payload.filePaths.pop();
      if (kind === "append") dto.payload.filePaths.push("extra.md");
      if (kind === "reorder") dto.payload.filePaths.reverse();
      if (kind === "duplicate")
        dto.payload.filePaths.push(dto.payload.filePaths[0]!);
      expect(() => f.validate(dto, f.trusted)).toThrow();
    },
  );

  it("rejects rewritten model output with recomputed bytes, canonical hash and full commitment", async () => {
    const f = await fixture();
    const dto = copy(f.fact);
    Reflect.set(
      dto.payload.modelOutput,
      "summaryMarkdown",
      "Substituted response",
    );
    dto.payload.outputBytes = f.parser.serializeCertifiedForkReviewModelOutput(
      dto.payload.modelOutput,
      dto.payload.filePaths,
    );
    const canonicalOutputHash = f.parser.certifiedForkReviewModelOutputHash(
      dto.payload.modelOutput,
      dto.payload.filePaths,
    );
    const facts = { ...f.output };
    Reflect.deleteProperty(facts, "outputHash");
    dto.payload.outputCommitmentHash = f.canonical.fingerprint("fork-output", {
      ...facts,
      canonicalOutputHash,
    });
    expect(() => f.validate(dto, f.trusted)).toThrow();
  });

  it("rejects substituted finding paths despite recomputing every caller output and storage hash", async () => {
    const f = await fixture();
    const dto = copy(f.fact);
    dto.payload.filePaths[0] = "src/substitute.ts";
    Reflect.set(
      dto.payload.modelOutput.findings[0]!,
      "path",
      dto.payload.filePaths[0],
    );
    dto.payload.outputBytes = f.parser.serializeCertifiedForkReviewModelOutput(
      dto.payload.modelOutput,
      dto.payload.filePaths,
    );
    const canonicalOutputHash = f.parser.certifiedForkReviewModelOutputHash(
      dto.payload.modelOutput,
      dto.payload.filePaths,
    );
    const forgedSuccess = {
      ...f.trusted.successEvidence,
      resultHash: canonicalOutputHash,
    };
    const facts = {
      ...f.output,
      canonicalOutputHash,
      successEvidenceHash: f.canonical.fingerprint(
        "fork-evidence",
        forgedSuccess,
      ),
    };
    Reflect.deleteProperty(facts, "outputHash");
    dto.payload.outputCommitmentHash = f.canonical.fingerprint(
      "fork-output",
      facts,
    );
    const storage =
      await import("../infrastructure/prisma/certified-fork-proof-fact-types.js");
    const parsed = storage.parseRetainedFact(dto);
    const canonicalBytes = storage.canonicalRetainedBytes(parsed.payload);
    const envelope = {
      fact: parsed,
      canonicalBytes,
      payloadHash: storage.factSha256(canonicalBytes).toString("hex"),
      createdAtMs: 1,
    };
    expect(envelope.payloadHash).toHaveLength(64);
    expect(() => f.validate(envelope.fact, f.trusted)).toThrow();
    // Even replacing the evidence DTO cannot manufacture a domain capability.
    expect(() =>
      f.validate(envelope.fact, {
        ...f.trusted,
        successEvidence: forgedSuccess,
      }),
    ).toThrow();
  });

  it("rejects oversized summary and nested finding body at the actual parser limits", async () => {
    const f = await fixture();
    for (const field of ["summaryMarkdown", "body"]) {
      const dto = copy(f.fact);
      if (field === "body")
        Reflect.set(
          dto.payload.modelOutput.findings[0]!,
          "body",
          "x".repeat(f.parser.certifiedForkReviewModelBodyMaxBytes + 1),
        );
      else
        Reflect.set(
          dto.payload.modelOutput,
          "summaryMarkdown",
          "x".repeat(f.parser.certifiedForkReviewModelSummaryMaxBytes + 1),
        );
      dto.payload.outputBytes = JSON.stringify(dto.payload.modelOutput);
      expect(() => f.validate(dto, f.trusted)).toThrow();
    }
  });

  it("rejects success whose authenticated result hash disagrees with the actual parser hash", async () => {
    const f = await fixture(h(999));
    expect(() => f.validate(f.fact, f.trusted)).toThrow();
  });

  it.each(["review", "request", "providerState", "successEvidence"] as const)(
    "rejects structural DTO substituted for %s capability",
    async (field) => {
      const f = await fixture();
      expect(() =>
        f.validate(f.fact, { ...f.trusted, [field]: copy(f.trusted[field]) }),
      ).toThrow();
    },
  );

  it.each([
    "effectKey",
    "requestHash",
    "logicalKey",
    "remoteScopeHash",
    "authorityHash",
    "resultHash",
    "evidenceHash",
    "attempt",
    "originEpoch",
    "source",
    "reason",
    "disposition",
  ] as const)(
    "rejects separately constructed but unrelated evidence %s",
    async (field) => {
      const f = await fixture();
      const changed = { ...f.trusted.successEvidence };
      const value =
        field === "attempt" || field === "originEpoch"
          ? "2"
          : field === "source"
            ? "github_app_receipt"
            : field === "reason"
              ? "timeout"
              : field === "disposition"
                ? "indeterminate"
                : h(999);
      Reflect.set(changed, field, value);
      const evidence = f.issueEvidence(changed);
      expect(() =>
        f.validate(f.fact, { ...f.trusted, successEvidence: evidence }),
      ).toThrow();
    },
  );

  it("rejects authenticated request substitution even with recomputed request and output hashes", async () => {
    const f = await fixture();
    const dto = copy(f.fact);
    const request = f.identity.createForkRequest(
      f.trusted.review,
      f.trusted.request.effect,
      { ...f.trusted.request.facts, contextHash: h(999) },
    );
    dto.payload.contextHash = request.contextHash;
    dto.payload.requestHash = request.requestHash;
    const facts = { ...f.output };
    Reflect.deleteProperty(facts, "outputHash");
    dto.payload.outputCommitmentHash = f.canonical.fingerprint("fork-output", {
      ...facts,
      contextHash: request.contextHash,
      requestHash: request.requestHash,
    });
    expect(() => f.validate(dto, { ...f.trusted, request })).toThrow();
  });

  it("requires scope to agree with constructed review even if caller and DTO scopes agree", async () => {
    const f = await fixture();
    const dto = copy(f.fact);
    dto.scope.reviewHash = h(999);
    expect(() => f.validate(dto, { ...f.trusted, scope: dto.scope })).toThrow();
  });

  it("rejects prepared, in-flight and integrity-held states", async () => {
    const f = await fixture();
    for (const providerState of [f.prepared, f.begun])
      expect(() =>
        f.validate(f.fact, { ...f.trusted, providerState }),
      ).toThrow();
    const authority = f.authority(f.trusted.providerState.revision);
    const conflict = f.issueEvidence({
      ...f.trusted.successEvidence,
      authorityHash: f.domain.forkAuthorityHash(authority),
      evidenceHash: h(999),
    });
    const providerState = f.domain.transitionForkEffect(
      f.trusted.providerState,
      authority,
      { kind: "evidence", evidence: conflict },
    );
    expect(providerState.integrityHold).toBe(true);
    expect(() => f.validate(f.fact, { ...f.trusted, providerState })).toThrow();
  });

  it("rejects getters, proxies, cycles and oversized storage DTOs without executing callbacks", async () => {
    const f = await fixture();
    let invoked = false;
    const getter = Object.defineProperty(copy(f.fact), "payload", {
      enumerable: true,
      get() {
        invoked = true;
        throw new Error("getter");
      },
    });
    const proxy = new Proxy(f.fact, {
      get() {
        invoked = true;
        throw new Error("proxy");
      },
    });
    const cycle = copy(f.fact);
    Reflect.set(cycle.payload, "sourceArtifact", cycle);
    const huge = copy(f.fact);
    huge.payload.outputBytes = "x".repeat(8 * 1024 * 1024 + 1);
    for (const dto of [getter, proxy, cycle, huge])
      expect(() => f.validate(dto, f.trusted)).toThrow();
    expect(invoked).toBe(false);
  });

  it("does not interpret metadata, expired provenance or source artifacts as commit/current authority", async () => {
    const f = await fixture();
    const dto = copy(f.fact);
    dto.provenance.producerId = "unverified producer";
    dto.payload.commitIdentity = "not a commit proof";
    dto.payload.committedAtMs = Number.MAX_SAFE_INTEGER;
    Reflect.set(dto.payload, "sourceArtifact", { missing: true });
    const result = f.validate(dto, f.trusted);
    expect(Object.keys(result).sort()).toEqual([
      "modelOutput",
      "output",
      "outputBytes",
    ]);
    expect(result.output).toEqual(f.output);
    expect(() => f.canonical.authentic("authority", result)).toThrow();
    expect(() => f.canonical.authentic("durability", result.output)).toThrow();
  });

  it("survives a fresh module registry only after independent capability reconstruction", async () => {
    const warm = await fixture();
    const persisted = JSON.stringify(warm.fact);
    vi.resetModules();
    const cold = await fixture();
    expect(() => cold.validate(JSON.parse(persisted), warm.trusted)).toThrow();
    const restored = cold.validate(JSON.parse(persisted), cold.trusted);
    expect(restored.output).toEqual(warm.output);
    expect(cold.canonical.authentic("output", restored.output)).toBe(
      restored.output,
    );
  });
});
