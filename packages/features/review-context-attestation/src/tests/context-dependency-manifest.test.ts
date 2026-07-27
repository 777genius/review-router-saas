import { describe, expect, it } from "vitest";
import {
  ContextDependencyKind,
  ContextDependencyReplayDenialReason,
  ContextDependencyReplayStatus,
  ContextFileKind,
  ContextProviderKind,
  GatewaySessionState,
  activateGatewaySession,
  canonicalContextDependencyManifest,
  contextDependencyManifestVersion,
  createAcceptedDependencyAttestation,
  createContextDependencyManifest,
  decideContextDependencyReplay,
  openGatewaySession,
  sealGatewaySession,
  type ContextDependencyEntry,
  type ContextDependencyManifest,
  type FileReadDependencyResult,
} from "../index";

const hash = (value: string) => value.repeat(64);
const oid = (value: string) => value.repeat(40);

function fileDependency(
  overrides: Partial<ContextDependencyEntry> = {},
): ContextDependencyEntry {
  return {
    sequence: 1,
    previousEventHash: hash("0"),
    eventHash: hash("1"),
    operationKey: hash("a"),
    operation: {
      kind: ContextDependencyKind.FileRead,
      path: "src/a.ts",
      startByte: 0,
      maxBytes: 64_000,
    },
    result: fileResult(),
    ...overrides,
  };
}

function fileResult(
  overrides: Partial<FileReadDependencyResult> = {},
): FileReadDependencyResult {
  return {
    kind: ContextDependencyKind.FileRead,
    fileKind: ContextFileKind.Regular,
    mode: 0o100644,
    blobOid: oid("b"),
    symlinkTargetHash: null,
    contentHash: hash("b"),
    byteCount: 120,
    eof: true,
    complete: true,
    truncated: false,
    ...overrides,
  };
}

function manifest(
  dependencies: readonly ContextDependencyEntry[] = [fileDependency()],
): ContextDependencyManifest {
  return createContextDependencyManifest({
    manifestVersion: contextDependencyManifestVersion,
    gatewayPolicyVersion: "context-gateway-v2",
    gatewayBinaryHash: hash("c"),
    checkoutTreeOid: oid("d"),
    authenticatedChainHash: hash("d"),
    complete: true,
    dependencies,
  });
}

describe("ContextDependencyManifest", () => {
  it("preserves the authenticated sequence and rejects empty evidence", () => {
    expect(manifest().dependencies[0]?.sequence).toBe(1);
    expect(() => manifest([])).toThrow(
      "context_dependency_manifest_entry_count_invalid",
    );
  });

  it("rejects traversal, inconsistent duplicate operations, truncation and broken chains", () => {
    expect(() =>
      manifest([
        fileDependency({
          operation: {
            kind: ContextDependencyKind.FileRead,
            path: "../secret",
            startByte: 0,
            maxBytes: 1,
          },
        }),
      ]),
    ).toThrow("context_dependency_path_invalid");

    expect(() =>
      manifest([
        fileDependency(),
        fileDependency({
          sequence: 2,
          previousEventHash: hash("1"),
          eventHash: hash("2"),
          result: fileResult({ contentHash: hash("e") }),
        }),
      ]),
    ).toThrow("context_dependency_operation_result_mismatch");

    expect(
      manifest([
        fileDependency(),
        fileDependency({
          sequence: 2,
          previousEventHash: hash("1"),
          eventHash: hash("2"),
        }),
      ]).dependencies,
    ).toHaveLength(2);

    expect(() =>
      manifest([
        fileDependency({
          result: {
            ...fileResult(),
            truncated: true,
          } as unknown as ContextDependencyEntry["result"],
        }),
      ]),
    ).toThrow("context_dependency_result_truncated");

    expect(() =>
      manifest([
        fileDependency(),
        fileDependency({
          sequence: 2,
          operationKey: hash("e"),
          previousEventHash: hash("f"),
          eventHash: hash("2"),
        }),
      ]),
    ).toThrow("context_dependency_event_chain_invalid");
  });

  it("matches only an exact replay of every operation and result", () => {
    const source = manifest();
    expect(decideContextDependencyReplay(source, manifest())).toMatchObject({
      status: ContextDependencyReplayStatus.Matched,
      reason: ContextDependencyReplayDenialReason.None,
    });

    const changedResult = fileDependency({
      result: fileResult({ contentHash: hash("e") }),
    });
    expect(
      decideContextDependencyReplay(source, manifest([changedResult])),
    ).toMatchObject({
      status: ContextDependencyReplayStatus.Denied,
      reason: ContextDependencyReplayDenialReason.ResultMismatch,
      mismatchedOperationKey: hash("a"),
    });
  });

  it("denies gateway policy and binary drift", () => {
    const source = manifest();
    expect(
      decideContextDependencyReplay(
        source,
        createContextDependencyManifest({
          ...source,
          gatewayPolicyVersion: "context-gateway-v3",
        }),
      ).reason,
    ).toBe(ContextDependencyReplayDenialReason.GatewayPolicyMismatch);
    expect(
      decideContextDependencyReplay(
        source,
        createContextDependencyManifest({
          ...source,
          gatewayBinaryHash: hash("e"),
        }),
      ).reason,
    ).toBe(ContextDependencyReplayDenialReason.GatewayBinaryMismatch);
  });

  it("accepts large but bounded dependency manifests for batched reviews", () => {
    const hex = (value: number) => value.toString(16).padStart(64, "0");
    const dependencies: ContextDependencyEntry[] = [];
    let previousEventHash = hash("0");
    for (let index = 1; index <= 900; index += 1) {
      const eventHash = hex(index);
      dependencies.push(
        fileDependency({
          sequence: index,
          operationKey: hex(index + 10_000),
          previousEventHash,
          eventHash,
          operation: {
            kind: ContextDependencyKind.FileRead,
            path: `src/generated/${index}.ts`,
            startByte: 0,
            maxBytes: 64_000,
          },
        }),
      );
      previousEventHash = eventHash;
    }

    const large = createContextDependencyManifest({
      manifestVersion: contextDependencyManifestVersion,
      gatewayPolicyVersion: "context-gateway-v2",
      gatewayBinaryHash: hash("c"),
      checkoutTreeOid: oid("d"),
      authenticatedChainHash: previousEventHash,
      complete: true,
      dependencies,
    });
    const byteLength = Buffer.byteLength(
      canonicalContextDependencyManifest(large),
      "utf8",
    );

    expect(byteLength).toBeGreaterThan(512 * 1024);
    expect(byteLength).toBeLessThan(2 * 1024 * 1024);
    expect(large.dependencies).toHaveLength(900);
  });
});

describe("AcceptedDependencyAttestation", () => {
  it("binds a sealed session to an immutable attestation", () => {
    const opened = openGatewaySession({
      sessionId: "gateway-session-1",
      scope: {
        workspaceId: "workspace-1",
        repositoryConnectionId: "connection-1",
        scmRepositoryIdentityId: "repository-1",
        pullRequestNumber: 42,
      },
      sourceRevision: {
        baseSha: oid("a"),
        mergeBaseSha: oid("b"),
        headSha: oid("c"),
        reviewRevisionHash: hash("a"),
        checkoutTreeOid: oid("d"),
      },
      sourceExecutionId: "execution-1",
      sourceWorkSlotId: "slot-1",
      attemptId: "attempt-1",
      sourceLeaseId: "lease-1",
      sourceFencingToken: "1",
      providerKind: ContextProviderKind.Codex,
      requestedModel: "gpt-5.3-codex",
      trustedCapabilityProfile: "context-gateway-v2",
      gatewayBinaryHash: hash("c"),
      gatewayPolicyVersion: "context-gateway-v2",
      producerReleaseId: "release-1",
      selectedProtocolVersion: "review-action-v2",
      confinementProofHash: hash("e"),
      eventChainSeedHash: hash("0"),
      openedAtMs: 1_000,
      expiresAtMs: 61_000,
    });
    const sealed = sealGatewaySession(activateGatewaySession(opened, 2_000), {
      eventCount: 1,
      sealedAtMs: 3_000,
    });
    const accepted = createAcceptedDependencyAttestation({
      attestationId: "attestation-1",
      attestationHash: hash("f"),
      session: sealed,
      manifest: manifest(),
      actualModel: "gpt-5.3-codex",
      terminalOutcomeHash: hash("a"),
      replayMaterialHash: hash("b"),
      acceptedAtMs: 4_000,
      reuseExpiresAtMs: 50_000,
    });

    expect(accepted.session.state).toBe(GatewaySessionState.Accepted);
    expect(accepted.attestation.sourceFencingToken).toBe("1");
    expect(accepted.attestation.manifest.dependencies).toHaveLength(1);
  });
});
