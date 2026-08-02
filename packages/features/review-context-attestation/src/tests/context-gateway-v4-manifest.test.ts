import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ContextGatewayV4FailureClass,
  ContextGatewayV4OperationKind,
  ContextGatewayV4OutcomeKind,
  canonicalContextGatewayV4Manifest,
  contextGatewayV4ManifestVersion,
  contextGatewayV4PolicyVersion,
  createContextGatewayV4Manifest,
  successfulContextGatewayV4Receipts,
  type ContextGatewayV4Event,
} from "../domain/context-gateway-v4-manifest";
import {
  ContextDependencyReplayStatus,
  decideContextGatewayV4Replay,
} from "../domain/context-replay-decision";

describe("ContextGatewayV4Manifest", () => {
  it("accepts recoverable rejection followed by a complete authenticated page chain", () => {
    const manifest = createContextGatewayV4Manifest(candidate(validEvents()));
    expect(manifest.events).toHaveLength(4);
    expect(successfulContextGatewayV4Receipts(manifest)).toHaveLength(3);
    expect(canonicalContextGatewayV4Manifest(manifest)).not.toContain(
      "raw-search-query",
    );
  });

  it("rejects incomplete or reordered pagination", () => {
    expect(() =>
      createContextGatewayV4Manifest(candidate(validEvents().slice(0, 2))),
    ).toThrow("context_gateway_v4_page_chain_incomplete");
    const reordered = validEvents();
    reordered[1] = successPage(2, 1, true, hash("event-1"));
    reordered[2] = successPage(3, 0, false, reordered[1].eventHash);
    expect(() => createContextGatewayV4Manifest(candidate(reordered))).toThrow(
      "context_gateway_v4_page_chain_invalid",
    );
  });

  it("rejects confinement and infrastructure events even when the envelope lies", () => {
    const events = validEvents();
    const first = events[0];
    if (!first) throw new Error("test_event_missing");
    events[0] = Object.freeze({
      ...first,
      failureClass: ContextGatewayV4FailureClass.ConfinementViolation,
      sanitizedReason: "path_escape",
    });
    expect(() =>
      createContextGatewayV4Manifest(
        candidate(events, { confinementTainted: false }),
      ),
    ).toThrow("context_gateway_v4_terminal_failure_present");
  });

  it("requires file byte ranges to cover the blob through EOF", () => {
    const first = successFile(1, 0, 4, false, hash("seed"));
    const gap = successFile(2, 8, 4, true, first.eventHash);
    expect(() =>
      createContextGatewayV4Manifest(candidate([first, gap])),
    ).toThrow("context_gateway_v4_file_range_gap");
  });

  it("replays only the selected receipt group and ignores revision tree identity", () => {
    const source = createContextGatewayV4Manifest(candidate(validEvents()));
    const targetEvents = rechain([
      successPage(1, 0, false, hash("target-seed")),
      successPage(2, 1, true, hash("unused")),
    ], hash("target-seed"));
    const target = createContextGatewayV4Manifest({
      ...candidate(targetEvents),
      checkoutTreeOid: "c".repeat(40),
      eventChainSeedHash: hash("target-seed"),
      authenticatedChainHash: targetEvents.at(-1)!.eventHash,
    });

    expect(
      decideContextGatewayV4Replay(source, target, [hash("receipt-1")]),
    ).toMatchObject({ status: ContextDependencyReplayStatus.Matched });

    const changed = targetEvents.map((entry, index) =>
      index === 1
        ? Object.freeze({
            ...entry,
            result: Object.freeze({
              ...entry.result,
              aggregateHash: hash("changed-aggregate"),
            }),
          })
        : entry,
    );
    const changedTarget = createContextGatewayV4Manifest({
      ...candidate(changed),
      checkoutTreeOid: "c".repeat(40),
      eventChainSeedHash: hash("target-seed"),
      authenticatedChainHash: changed.at(-1)!.eventHash,
    });
    expect(
      decideContextGatewayV4Replay(source, changedTarget, [hash("receipt-1")]),
    ).toMatchObject({ status: ContextDependencyReplayStatus.Denied });
  });
});

function validEvents(): ContextGatewayV4Event[] {
  const rejected = event({
    sequence: 1,
    previousEventHash: hash("seed"),
    operationKind: ContextGatewayV4OperationKind.TextSearch,
    outcome: ContextGatewayV4OutcomeKind.Rejected,
    failureClass: ContextGatewayV4FailureClass.RecoverableRequest,
    operation: {
      kind: ContextGatewayV4OperationKind.TextSearch,
      inputHash: hash("invalid-query-input"),
    },
    result: null,
    operationReceiptId: null,
    sanitizedReason: "text_search_query_invalid",
  });
  const first = successPage(2, 0, false, rejected.eventHash);
  const second = successPage(3, 1, true, first.eventHash);
  const gitFact = event({
    sequence: 4,
    previousEventHash: second.eventHash,
    operationKind: ContextGatewayV4OperationKind.GitFact,
    outcome: ContextGatewayV4OutcomeKind.Succeeded,
    failureClass: null,
    operation: {
      kind: ContextGatewayV4OperationKind.GitFact,
      fact: "merge_base",
    },
    result: {
      complete: true,
      fact: "merge_base",
      itemCount: 1,
      resultHash: hash("merge-base-result"),
    },
    operationReceiptId: hash("git-fact-receipt"),
    sanitizedReason: null,
  });
  return [rejected, first, second, gitFact];
}

function successPage(
  sequence: number,
  pageOrdinal: number,
  complete: boolean,
  previousEventHash: string,
): ContextGatewayV4Event {
  return event({
    sequence,
    previousEventHash,
    operationKind: ContextGatewayV4OperationKind.TextSearch,
    outcome: ContextGatewayV4OutcomeKind.Succeeded,
    failureClass: null,
    operation: {
      kind: ContextGatewayV4OperationKind.TextSearch,
      inputHash: hash(`page-input-${pageOrdinal}`),
    },
    result: {
      treeOid: "a".repeat(40),
      queryDigest: hash("query"),
      pageOrdinal,
      pageItemCount: pageOrdinal === 0 ? 2 : 1,
      pageItemsHash: hash(`page-${pageOrdinal}`),
      aggregateItemCount: pageOrdinal === 0 ? 2 : 3,
      aggregateHash: hash(`aggregate-${pageOrdinal}`),
      complete,
      nextCursorHash: complete ? null : hash("cursor"),
    },
    operationReceiptId: hash(`receipt-${pageOrdinal}`),
    sanitizedReason: null,
  });
}

function successFile(
  sequence: number,
  startByte: number,
  byteCount: number,
  eof: boolean,
  previousEventHash: string,
): ContextGatewayV4Event {
  return event({
    sequence,
    previousEventHash,
    operationKind: ContextGatewayV4OperationKind.FileRead,
    outcome: ContextGatewayV4OutcomeKind.Succeeded,
    failureClass: null,
    operation: {
      kind: ContextGatewayV4OperationKind.FileRead,
      inputHash: hash(`file-${startByte}`),
    },
    result: {
      revision: "head",
      treeOid: "a".repeat(40),
      pathHash: hash("path"),
      mode: "100644",
      blobOid: "b".repeat(40),
      contentHash: hash(`content-${startByte}`),
      byteCount,
      startByte,
      eof,
      complete: eof,
    },
    operationReceiptId: hash(`file-receipt-${startByte}`),
    sanitizedReason: null,
  });
}

function event(
  input: Omit<ContextGatewayV4Event, "eventHash" | "operationKey">,
): ContextGatewayV4Event {
  return Object.freeze({
    ...input,
    eventHash: hash(`event-${input.sequence}`),
    operationKey: hash(`operation-${input.sequence}`),
  });
}

function rechain(
  events: readonly ContextGatewayV4Event[],
  seed: string,
): ContextGatewayV4Event[] {
  let previous = seed;
  return events.map((entry, index) => {
    const eventHash = hash(`target-event-${index}`);
    const chained = Object.freeze({
      ...entry,
      sequence: index + 1,
      previousEventHash: previous,
      eventHash,
    });
    previous = eventHash;
    return chained;
  });
}

function candidate(
  events: readonly ContextGatewayV4Event[],
  overrides: Partial<{
    confinementTainted: boolean;
  }> = {},
) {
  return {
    manifestVersion: contextGatewayV4ManifestVersion,
    gatewayPolicyVersion: contextGatewayV4PolicyVersion,
    gatewayBinaryHash: hash("binary"),
    checkoutTreeOid: "a".repeat(40),
    eventChainSeedHash: hash("seed"),
    authenticatedChainHash: events.at(-1)?.eventHash ?? hash("seed"),
    complete: true,
    confinementTainted: overrides.confinementTainted ?? false,
    terminalFailureClass: null,
    events,
  } as const;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
