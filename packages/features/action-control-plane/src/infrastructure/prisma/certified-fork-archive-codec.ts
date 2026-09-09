import { types } from "node:util";
import {
  record,
  hash,
  sha,
  opaqueId,
  counter,
  positive,
  nullable,
  choice,
  requireFact,
  type Parser,
} from "../../domain/certified-fork-effect-canonical.js";
import type {
  ForkCheckpoint,
  ForkCheckpointState,
} from "../../application/ports/certified-fork-effect-proof-port.js";
import type {
  ForkLedgerSnapshot,
  ForkComparison,
} from "../../application/ports/certified-fork-effect-repository-port.js";
import {
  checkpointAnchor,
  forkLedgerHash,
  validateForkSnapshot,
} from "../../application/services/certified-fork-effect-ledger.js";

/** Exact data parsers only. These functions NEVER restore capability brands.
 * Arrays containing durable history have no arbitrary total-history limit. */
export function archiveArray<T>(parse: Parser<T>): Parser<readonly T[]> {
  return (value) => {
    requireFact(
      typeof value === "object" && value !== null && !types.isProxy(value),
    );
    requireFact(
      Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype,
    );
    const descriptors = Object.getOwnPropertyDescriptors(value);
    requireFact(Reflect.ownKeys(value).length === value.length + 1);
    const result: T[] = [];
    for (let i = 0; i < value.length; i++) {
      const d = descriptors[String(i)];
      requireFact(d && "value" in d && d.enumerable);
      result.push(parse(d.value));
    }
    return Object.freeze(result);
  };
}
const bool: Parser<boolean> = (v) => {
  requireFact(typeof v === "boolean");
  return v;
};
export const archiveReference: Parser<string> = (v) => {
  requireFact(
    typeof v === "string" &&
      v.length > 0 &&
      v.length <= 4096 &&
      !v.includes("\0"),
  );
  return v;
};
/** pg may return bigint or decimal text. Never accept rounded JS counters. */
export function archiveCounter(v: unknown): string {
  requireFact(typeof v === "bigint" || typeof v === "string");
  return counter(String(v));
}
export function archiveTime(v: unknown): number {
  requireFact(
    typeof v === "bigint" || typeof v === "string" || typeof v === "number",
  );
  requireFact(/^[1-9][0-9]*$/u.test(String(v)));
  return positive(Number(v));
}
const facts = record({
  workspaceId: opaqueId,
  repositoryId: opaqueId,
  sourceRepositoryId: opaqueId,
  baseRepositoryId: opaqueId,
  pullRequest: positive,
  headSha: sha,
  baseSha: sha,
  trustDomain: choice("fork"),
  generation: counter,
});
const seed = record({
  facts,
  bindingHash: hash,
  admissionHash: nullable(hash),
  predecessor: nullable(archiveReference),
});
const review = record({
  facts,
  logicalKey: hash,
  familyKey: hash,
  bindingHash: hash,
  admissionHash: nullable(hash),
});
const slot = record({
  stage: choice("provider", "publication"),
  role: choice("review", "advisory", "summary", "inline"),
  slot: positive,
});
const effect = record({ logicalKey: hash, effectKey: hash, slot });
const common = {
  contextHash: hash,
  adapterContractHash: hash,
  schemaHash: hash,
};
const provider = record({
  ...common,
  providerInstanceId: opaqueId,
  accountScopeHash: hash,
  modelHash: hash,
  settingsHash: hash,
  trustedInstructionsHash: hash,
  effectiveInputHash: hash,
  toolsOutputSchemaHash: hash,
  executionPolicyHash: hash,
});
const publication = record({
  ...common,
  outputCommitmentHash: hash,
  frozenPlanHash: hash,
  appId: opaqueId,
  installationId: opaqueId,
  baseRepositoryId: opaqueId,
  pullRequest: positive,
  commitSha: sha,
  objectTargetHash: hash,
  renderPolicyHash: hash,
  payloadHashes: archiveArray(hash),
  markerHash: hash,
});
const requestFacts: Parser<
  ReturnType<typeof provider> | ReturnType<typeof publication>
> = (v) => {
  requireFact(typeof v === "object" && v !== null && !types.isProxy(v));
  return Object.hasOwn(v, "providerInstanceId") ? provider(v) : publication(v);
};
const request = record({
  effect,
  review,
  bindingHash: hash,
  contextHash: hash,
  facts: requestFacts,
  requestHash: hash,
  remoteScopeHash: hash,
});
const authority = record({
  logicalKey: hash,
  reviewHash: hash,
  epoch: counter,
  claimHash: hash,
  ownerHash: hash,
  revision: counter,
  mode: choice("execute", "reconcile"),
  validUntilHash: hash,
});
const evidence = record({
  logicalKey: hash,
  effectKey: hash,
  requestHash: hash,
  attempt: counter,
  originEpoch: counter,
  remoteScopeHash: hash,
  authorityHash: hash,
  kind: choice("success", "no_effect", "unknown", "conflict"),
  source: choice(
    "provider_receipt",
    "github_app_receipt",
    "dispatch_journal",
    "observation",
  ),
  verifierHash: hash,
  evidenceHash: hash,
  externalRefHash: nullable(hash),
  resultHash: nullable(hash),
  disposition: choice(
    "authenticated_success",
    "definitive_no_effect",
    "indeterminate",
    "duplicate_effects",
  ),
  senderClosure: choice("closed", "open"),
  reason: choice(
    "confirmed",
    "never_dispatched",
    "rejected",
    "timeout",
    "absent",
    "listing_empty",
    "conflicting",
    "duplicate_remote_effects",
  ),
});
const stops = archiveArray(choice("stale", "cancelled"));
const state = record({
  request,
  revision: counter,
  authority,
  attempts: archiveArray(
    record({
      ordinal: counter,
      originEpoch: counter,
      originClaimHash: hash,
      originOwnerHash: hash,
      status: choice(
        "prepared",
        "in_flight",
        "succeeded",
        "no_effect",
        "unknown",
      ),
      evidence: archiveArray(evidence),
    }),
  ),
  stops,
  sealed: bool,
  integrityHold: bool,
  inventoryHash: nullable(hash),
});
const output = record({
  logicalKey: hash,
  effectKey: hash,
  requestHash: hash,
  successEvidenceHash: hash,
  bindingHash: hash,
  contextHash: hash,
  canonicalOutputHash: hash,
  outputHash: hash,
});
const inventory = record({
  review,
  logicalKey: hash,
  entries: archiveArray(record({ request, dependencies: archiveArray(hash) })),
  inventoryHash: hash,
  output: nullable(output),
  durability: nullable(
    record({
      disposition: choice("durably_committed"),
      outputCommitmentHash: hash,
      commitReceiptHash: hash,
    }),
  ),
});
const outcome = record({
  review,
  inventory,
  states: archiveArray(state),
  output: nullable(output),
  outputAvailability: choice("available", "unavailable"),
  stops,
  predecessorHash: nullable(hash),
  status: choice(
    "completed",
    "stopped_no_effect",
    "stopped_with_effect",
    "output_unavailable",
    "unresolved",
  ),
  outcomeHash: hash,
});
export const archiveState: Parser<ForkCheckpointState> = record({
  review,
  states: archiveArray(state),
  inventory: nullable(inventory),
  outcome: nullable(outcome),
});
export const archivePosition = record({
  commandId: opaqueId,
  commandHash: hash,
});
const nonnegative: Parser<number> = (v) => {
  requireFact(
    typeof v === "number" &&
      Number.isSafeInteger(v) &&
      v >= 0 &&
      !Object.is(v, -0),
  );
  return v;
};
export const archiveCheckpoint: Parser<ForkCheckpoint> = record({
  proof: archiveReference,
  prefixLength: nonnegative,
  prefixHash: hash,
  anchorHash: hash,
  position: nullable(archivePosition),
  state: archiveState,
});
const input: Parser<ForkLedgerSnapshot["events"][number]["input"]> = (v) => {
  requireFact(typeof v === "object" && v !== null && !types.isProxy(v));
  const d = Object.getOwnPropertyDescriptor(v, "kind");
  requireFact(d && "value" in d);
  switch (d.value) {
    case "prepare":
      return record({
        kind: choice("prepare"),
        request: record({ slot, facts: requestFacts }),
      })(v);
    case "begin":
    case "retry":
    case "seal":
      return record({
        kind: choice("begin", "retry", "seal"),
        effectKey: hash,
      })(v);
    case "stop":
      return record({
        kind: choice("stop"),
        effectKey: hash,
        reason: choice("stale", "cancelled"),
      })(v);
    case "evidence":
      return record({
        kind: choice("evidence"),
        effectKey: hash,
        proof: archiveReference,
      })(v);
    case "inventory":
      return record({
        kind: choice("inventory"),
        entries: archiveArray(
          record({ effectKey: hash, dependencies: archiveArray(hash) }),
        ),
        completenessProof: archiveReference,
        output: nullable(
          record({
            effectKey: hash,
            canonicalOutputHash: hash,
            durabilityProof: archiveReference,
          }),
        ),
      })(v);
    default:
      return record({
        kind: choice("outcome"),
        availability: choice("available", "unavailable"),
        retainedProof: nullable(archiveReference),
      })(v);
  }
};
const claim = nullable(
  record({
    ownerHash: hash,
    claimHash: hash,
    epoch: counter,
    expiresAt: positive,
  }),
);
const snapshotFields = {
  seed,
  admissionProof: archiveReference,
  reviewHash: hash,
  familyKey: hash,
  version: counter,
  fence: counter,
  claim,
  events: archiveArray(
    record({ at: positive, authorityProof: nullable(archiveReference), input }),
  ),
};
export function archiveSnapshot(v: unknown): ForkLedgerSnapshot {
  requireFact(typeof v === "object" && v !== null && !types.isProxy(v));
  const result = Object.hasOwn(v, "checkpoint")
    ? record({ ...snapshotFields, checkpoint: archiveCheckpoint })(v)
    : record(snapshotFields)(v);
  validateForkSnapshot(result);
  return result;
}
export const archiveReceipt = record({
  ownerHash: hash,
  commandId: opaqueId,
  commandHash: hash,
  reviewHash: hash,
  version: counter,
});
export const archiveComparison: Parser<ForkComparison> = record({
  reviewHash: hash,
  version: counter,
  fence: counter,
  claim,
  ledgerHash: hash,
  outcomeHash: nullable(hash),
  revisions: archiveArray(record({ effectKey: hash, revision: counter })),
});

/** Deterministic lossless JSON for already parsed archive data, independent of
 * jsonb key order. No BigInt conversion, toJSON, accessors or unsafe numbers. */
export function archiveJson(value: unknown): string {
  const active = new Set<object>();
  function encode(v: unknown): string {
    if (v === null || typeof v === "boolean") return String(v);
    if (typeof v === "string") {
      requireFact(
        !v.includes("\0") && Buffer.from(v, "utf8").toString("utf8") === v,
      );
      return JSON.stringify(v);
    }
    if (typeof v === "number") {
      nonnegative(Math.abs(v));
      requireFact(!Object.is(v, -0));
      return String(v);
    }
    requireFact(
      typeof v === "object" &&
        v !== null &&
        !types.isProxy(v) &&
        !active.has(v),
    );
    active.add(v);
    let result: string;
    if (Array.isArray(v)) result = `[${archiveArray(encode)(v).join(",")}]`;
    else {
      requireFact(Object.getPrototypeOf(v) === Object.prototype);
      const keys = Reflect.ownKeys(v);
      requireFact(keys.every((k) => typeof k === "string"));
      const entries = (keys as string[]).sort().map((k) => {
        const d = Object.getOwnPropertyDescriptor(v, k)!;
        requireFact(d.enumerable && "value" in d);
        return `${encode(k)}:${encode(d.value)}`;
      });
      result = `{${entries.join(",")}}`;
    }
    active.delete(v);
    return result;
  }
  return encode(value);
}
export function sameArchive(a: unknown, b: unknown): boolean {
  return archiveJson(a) === archiveJson(b);
}
export function checkpointComparison(
  snapshot: ForkLedgerSnapshot,
): ForkComparison {
  const cp = snapshot.checkpoint;
  requireFact(
    cp &&
      cp.position &&
      cp.prefixLength === snapshot.events.length &&
      cp.prefixHash === forkLedgerHash(snapshot) &&
      cp.anchorHash === checkpointAnchor(snapshot),
  );
  const revisions = cp.state.states
    .map((s) => ({
      effectKey: s.request.effect.effectKey,
      revision: s.revision,
    }))
    .sort((a, b) =>
      a.effectKey < b.effectKey ? -1 : a.effectKey > b.effectKey ? 1 : 0,
    );
  requireFact(
    new Set(revisions.map((r) => r.effectKey)).size === revisions.length,
  );
  return archiveComparison({
    reviewHash: snapshot.reviewHash,
    version: snapshot.version,
    fence: snapshot.fence,
    claim: snapshot.claim,
    ledgerHash: cp.prefixHash,
    outcomeHash: cp.state.outcome?.outcomeHash ?? null,
    revisions,
  });
}
