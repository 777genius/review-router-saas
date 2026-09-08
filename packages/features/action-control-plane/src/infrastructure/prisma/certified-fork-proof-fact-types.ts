import { createHash } from "node:crypto";
import { types } from "node:util";
import {
  choice,
  counter,
  hash,
  nullable,
  positive,
  record,
  requireFact,
} from "../../domain/certified-fork-effect-canonical.js";

// Storage DTOs, never restored domain capabilities or producer authentication.
// Producers must validate semantics and remove credentials before this boundary.
export type RetainedJson =
  | null
  | boolean
  | number
  | string
  | readonly RetainedJson[]
  | { readonly [key: string]: RetainedJson };
const MAX_BYTES = 8 * 1024 * 1024;
function string(value: unknown, max = 4096): string {
  requireFact(
    typeof value === "string" &&
      value.length > 0 &&
      Buffer.byteLength(value) <= max,
  );
  // PostgreSQL text cannot roundtrip NUL or unpaired UTF16 surrogate code units.
  requireFact(
    !value.includes("\0") &&
      !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
        value,
      ),
  );
  return value;
}
export const retainedText = (value: unknown) => string(value);
export const retainedReference = (value: unknown) => string(value, 4096);
const sourceIdentity = (value: unknown) => string(value, 1024 * 1024);
const retainedBytes = (value: unknown) => {
  requireFact(typeof value === "string");
  return captureRetainedJson(value) as string;
};

/** Copy descriptor values without executing getters/toJSON, rejecting cycles,
 * proxies, sparse arrays, symbols, exotic prototypes and resource bombs.
 * The limits bound a single ingestion, never total retained history. */
export function captureRetainedJson(input: unknown): RetainedJson {
  let nodes = 0,
    bytes = 0;
  const ancestors = new Set<object>();
  const visit = (value: unknown, depth: number): RetainedJson => {
    requireFact(++nodes <= 100_000 && depth <= 48 && bytes <= MAX_BYTES);
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number") {
      requireFact(
        Number.isFinite(value) &&
          !Object.is(value, -0) &&
          (!Number.isInteger(value) || Number.isSafeInteger(value)),
      );
      return value;
    }
    if (typeof value === "string") {
      if (value.length) string(value, MAX_BYTES);
      bytes += Buffer.byteLength(value);
      requireFact(bytes <= MAX_BYTES);
      return value;
    }
    requireFact(
      typeof value === "object" && value !== null && !types.isProxy(value),
    );
    requireFact(!ancestors.has(value));
    ancestors.add(value);
    const array = Array.isArray(value);
    requireFact(
      Object.getPrototypeOf(value) ===
        (array ? Array.prototype : Object.prototype) ||
        (!array && Object.getPrototypeOf(value) === null),
    );
    const keys = Reflect.ownKeys(value);
    requireFact(
      keys.length <= 100_001 && keys.every((k) => typeof k === "string"),
    );
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const [key, d] of Object.entries(descriptors)) {
      requireFact(
        "value" in d && ((array && key === "length") || d.enumerable),
      );
      if (key.length) string(key, 4096);
      bytes += Buffer.byteLength(key);
    }
    let result: RetainedJson;
    if (array) {
      requireFact(value.length <= 100_000 && keys.length === value.length + 1);
      const out: RetainedJson[] = [];
      for (let i = 0; i < value.length; i++) {
        requireFact(Object.hasOwn(descriptors, String(i)));
        out.push(visit(descriptors[String(i)]!.value, depth + 1));
      }
      result = Object.freeze(out);
    } else {
      const out: Record<string, RetainedJson> = {};
      // Define own data so __proto__ never invokes Object.prototype setters.
      for (const key of Object.keys(descriptors).sort())
        Object.defineProperty(out, key, {
          value: visit(descriptors[key]!.value, depth + 1),
          enumerable: true,
        });
      result = Object.freeze(out);
    }
    ancestors.delete(value);
    return result;
  };
  const result = visit(input, 0);
  requireFact(Buffer.byteLength(JSON.stringify(result)) <= MAX_BYTES);
  return result;
}
const object = (value: unknown) => {
  const parsed = captureRetainedJson(value);
  requireFact(
    parsed !== null && typeof parsed === "object" && !Array.isArray(parsed),
  );
  return parsed as { readonly [key: string]: RetainedJson };
};
const array = (value: unknown) => {
  const parsed = captureRetainedJson(value);
  requireFact(Array.isArray(parsed));
  return parsed as readonly RetainedJson[];
};
const strings = (value: unknown) => {
  const parsed = array(value);
  return Object.freeze(parsed.map(retainedText));
};
const payloads = {
  admission: record({
    seed: object,
    binding: object,
    packet: object,
    requests: array,
    remoteScopes: array,
    decisions: object,
    gatewayObservation: object,
    observationDeadlineMs: positive,
    policyVersion: retainedText,
    predecessor: nullable(object),
  }),
  authority: record({
    authority: object,
    transactionTimeMs: positive,
    expiresAtMs: positive,
    claim: object,
    fence: counter,
    version: counter,
    commandId: retainedReference,
    admissionProof: retainedReference,
    principal: object,
  }),
  evidence: record({
    evidence: object,
    authorityProof: retainedReference,
    response: object,
    bodyBytes: retainedBytes,
    senderClosure: object,
    originalScope: object,
  }),
  inventory: record({
    plan: array,
    dependencies: array,
    expectedEffectKeys: strings,
    plannerVersion: retainedText,
    renderVersion: retainedText,
    limitsVersion: retainedText,
    outputProof: nullable(retainedReference),
  }),
  output: record({
    modelOutput: object,
    outputBytes: retainedBytes,
    filePaths: strings,
    bindingHash: hash,
    contextHash: hash,
    requestHash: hash,
    effectKey: hash,
    successEvidenceProof: retainedReference,
    outputCommitmentHash: hash,
    commitIdentity: retainedReference,
    committedAtMs: positive,
    sourceArtifact: nullable(object),
  }),
  command: record({
    operation: choice(
      "acquireClaim",
      "renewClaim",
      "releaseClaim",
      "compareAndCommit",
    ),
    preimage: object,
    comparison: nullable(object),
    principal: object,
    claim: nullable(object),
    version: counter,
    commandId: retainedReference,
    commandHash: hash,
    admissionProof: retainedReference,
    authorityProofs: strings,
  }),
};
export type RetainedFactKind = keyof typeof payloads;
export type RetainedPayloads = {
  readonly [K in RetainedFactKind]: ReturnType<(typeof payloads)[K]>;
};
export const retainedKind = choice(
  "admission",
  "authority",
  "evidence",
  "inventory",
  "output",
  "command",
);
export const parseFactScope = record({
  workspaceId: retainedText,
  repositoryConnectionId: retainedText,
  familyKey: hash,
  reviewHash: hash,
});
export type RetainedFactScope = ReturnType<typeof parseFactScope>;
const provenance = record({
  producerKind: retainedText,
  producerId: retainedText,
  producerVersion: retainedText,
  sourceKey: sourceIdentity,
  sourceRevision: sourceIdentity,
  observedAtMs: positive,
  validUntilMs: nullable(positive),
});
export type RetainedFactInput<K extends RetainedFactKind> = Readonly<{
  proofId: string;
  kind: K;
  scope: RetainedFactScope;
  provenance: ReturnType<typeof provenance>;
  payload: RetainedPayloads[K];
}>;
export type AnyRetainedFactInput = {
  [K in RetainedFactKind]: RetainedFactInput<K>;
}[RetainedFactKind];
export function parseRetainedFact(value: unknown): AnyRetainedFactInput {
  // First captures the entire graph, before any caller property is accessed.
  const captured = object(value);
  const kind = retainedKind(captured.kind);
  const parsed = record({
    proofId: retainedReference,
    kind: retainedKind,
    scope: parseFactScope,
    provenance,
    payload: payloads[kind],
  })(captured);
  requireFact(
    parsed.provenance.validUntilMs === null ||
      parsed.provenance.validUntilMs >= parsed.provenance.observedAtMs,
  );
  return parsed as AnyRetainedFactInput;
}
export const factSha256 = (value: string) =>
  createHash("sha256").update(value, "utf8").digest();
export function factSourceSha256(fact: AnyRetainedFactInput): Buffer {
  const p = fact.provenance;
  return factSha256(
    [
      "certified-fork-fact-source-v1",
      fact.kind,
      p.producerKind,
      p.producerId,
      p.sourceKey,
      p.sourceRevision,
    ]
      .map((v) => `${Buffer.byteLength(v)}:${v}`)
      .join(""),
  );
}
export const canonicalRetainedBytes = (value: unknown) =>
  JSON.stringify(captureRetainedJson(value));
