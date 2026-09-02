import { describe, expect, it, vi } from "vitest";
import { CodexRotatingVersionedWritebackDispatcher } from "../application/services/codex-rotating-versioned-writeback-dispatcher.js";
import type {
  CodexRotatingVersionedWorkflowPublisherPort,
  CodexRotatingVersionedWritebackLedgerPort,
} from "../application/ports/codex-rotating-oauth-repository-port.js";
import { CodexRotatingSecretPutPreDispatchError } from "../application/ports/codex-rotating-oauth-repository-port.js";
import {
  allocateVersionedProviderSecretNamespace,
  createVersionedSecretWorkflowSourceAttestation,
  WorkflowSourceTrust,
} from "@reviewrouter/features-codex-oauth-rotating";

const now = new Date("2026-08-10T00:00:00.000Z");
const namespace = allocateVersionedProviderSecretNamespace({
  scope: {
    repositoryId: "123456",
    providerInstanceId: "codex-rotating:123456",
  },
  epoch: 2n,
  randomBytes: () => Buffer.alloc(16, 7),
});
const request = {
  protocolVersion: 1 as const,
  leaseId: "lease:runtime:1",
  providerInstanceId: "codex-rotating:123456",
  generation: 2,
  latestGenerationHash: "generation-hash-01234567890123456789",
  accountIdentityHash: "account-identity-01234567890123456789",
  accountIdentityAlgorithm: "provider_issuer_subject_account_v1" as const,
  encryptedValue: Buffer.from("ciphertext").toString("base64"),
  keyId: "key-1",
  idempotencyKey: "writeback:runtime:1",
};
const repository = {
  workspaceId: "workspace-1",
  repositoryId: "repository-1",
  githubRepositoryId: "123456",
  githubInstallationId: "789",
  fullName: "owner/repo",
  owner: "owner",
  selected: true,
  installationStatus: "active",
};
const retirementIdentity = {
  providerInstanceId: request.providerInstanceId,
  mutationOwner: "runtime" as const,
  mutationOwnerId: request.leaseId,
  mutationEpoch: 7n,
  namespaceId: namespace.namespaceId,
  generation: request.generation,
  latestGenerationHash: request.latestGenerationHash,
  accountIdentityHash: request.accountIdentityHash,
};

function harness() {
  const events: string[] = [];
  const attestation = createVersionedSecretWorkflowSourceAttestation({
    repositoryId: "123456",
    workflowPath: ".github/workflows/reviewrouter-codex.yml",
    workflowSourceCommitSha: "a".repeat(40),
    workflowSourceBlobSha: "b".repeat(40),
    workflowSourceSha256: "c".repeat(64),
    workflowSemanticSha256: "d".repeat(64),
    workflowSchemaVersion: 5,
    sourceTrust: WorkflowSourceTrust.TrustedDefaultBranchRevision,
    secretNamespace: namespace,
  });
  const ledger = {
    prepareVersionedWriteback: vi.fn(async () => {
      events.push("claim");
      return {
        status: "ready" as const,
        intentId: "intent-1",
        attemptId: "attempt-1",
        executorOwner: "executor-1",
        retirementIdentity,
        namespace,
        repository,
        writeTarget: {
          expectedProviderInstanceId: request.providerInstanceId,
          githubInstallationId: "789",
          githubRepositoryId: "123456",
          repositoryFullName: "owner/repo",
          owner: "owner",
          repo: "repo",
          secretName: namespace.name,
        },
      };
    }),
    confirmVersionedProviderWrite: vi.fn(async () => {
      events.push("confirm-provider");
    }),
    retirePreDispatchVersionedWriteback: vi.fn(async () => {
      events.push("retire-predispatch");
    }),
    retireAmbiguousVersionedWriteback: vi.fn(async () => {
      events.push("tombstone");
    }),
    activateVersionedWriteback: vi.fn(async () => {
      events.push("activate");
      return { generation: 2 };
    }),
  } satisfies CodexRotatingVersionedWritebackLedgerPort;
  const provider = {
    assertCanWriteRepositorySecret: vi.fn(),
    putEncryptedRepositorySecret: vi.fn(async () => {
      events.push("put");
      return { status: "accepted" as const, statusCode: 204 as const };
    }),
  };
  const workflows = {
    publishAndVerifyVersionedWorkflow: vi.fn(async () => {
      events.push("publish-verify-v4");
      return attestation;
    }),
  } satisfies CodexRotatingVersionedWorkflowPublisherPort;
  return { events, ledger, provider, workflows };
}

describe("versioned rotating runtime writeback dispatcher", () => {
  it("returns in-progress without a second provider mutation while the executor lease is live", async () => {
    const h = harness();
    let releasePut!: () => void;
    h.provider.putEncryptedRepositorySecret.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releasePut = () =>
            resolve({ status: "accepted" as const, statusCode: 204 as const });
        }),
    );
    h.ledger.prepareVersionedWriteback.mockResolvedValueOnce({
      status: "ready",
      intentId: "intent-1",
      attemptId: "attempt-1",
      executorOwner: "executor-1",
      retirementIdentity,
      namespace,
      repository,
      writeTarget: {
        expectedProviderInstanceId: request.providerInstanceId,
        githubInstallationId: "789",
        githubRepositoryId: "123456",
        repositoryFullName: "owner/repo",
        owner: "owner",
        repo: "repo",
        secretName: namespace.name,
      },
    });
    h.ledger.prepareVersionedWriteback.mockResolvedValueOnce({
      status: "in_progress",
      retryAfter: new Date(now.getTime() + 60_000),
    } as never);
    const dispatcher = new CodexRotatingVersionedWritebackDispatcher(
      h.ledger,
      h.provider,
      h.workflows,
      { now: () => now },
    );

    const first = dispatcher.dispatchOneShot({
      request,
      encryptedPayloadDigest: "digest-012345678901234567890123456789",
    });
    await vi.waitFor(() =>
      expect(h.provider.putEncryptedRepositorySecret).toHaveBeenCalledOnce(),
    );
    await expect(
      dispatcher.dispatchOneShot({
        request,
        encryptedPayloadDigest: "digest-012345678901234567890123456789",
      }),
    ).resolves.toEqual({
      status: "in_progress",
      retryAfter: new Date(now.getTime() + 60_000),
    });
    expect(h.provider.putEncryptedRepositorySecret).toHaveBeenCalledOnce();
    expect(h.ledger.retireAmbiguousVersionedWriteback).not.toHaveBeenCalled();
    releasePut();
    await expect(first).resolves.toEqual({ status: "accepted", generation: 2 });
  });

  it("lets the exact original dispatcher retire idempotently when a concurrent retry wins at executor expiry", async () => {
    const h = harness();
    const executorExpiry = new Date(now.getTime() + 60_000);
    let current = now;
    let rejectPut!: () => void;
    h.provider.putEncryptedRepositorySecret.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectPut = () => reject(new Error("response_dropped_after_retry"));
        }),
    );
    h.ledger.prepareVersionedWriteback.mockResolvedValueOnce({
      status: "ready",
      intentId: "intent-1",
      attemptId: "attempt-1",
      executorOwner: "executor-1",
      retirementIdentity,
      namespace,
      repository,
      writeTarget: {
        expectedProviderInstanceId: request.providerInstanceId,
        githubInstallationId: "789",
        githubRepositoryId: "123456",
        repositoryFullName: "owner/repo",
        owner: "owner",
        repo: "repo",
        secretName: namespace.name,
      },
    });
    h.ledger.prepareVersionedWriteback.mockResolvedValueOnce({
      status: "writeback_recovery_required",
    } as never);
    const dispatcher = new CodexRotatingVersionedWritebackDispatcher(
      h.ledger,
      h.provider,
      h.workflows,
      { now: () => current },
    );

    const original = dispatcher.dispatchOneShot({
      request,
      encryptedPayloadDigest: "digest-012345678901234567890123456789",
    });
    await vi.waitFor(() =>
      expect(h.provider.putEncryptedRepositorySecret).toHaveBeenCalledOnce(),
    );
    current = executorExpiry;
    await expect(
      dispatcher.dispatchOneShot({
        request,
        encryptedPayloadDigest: "digest-012345678901234567890123456789",
      }),
    ).resolves.toEqual({ status: "writeback_recovery_required" });
    expect(h.ledger.prepareVersionedWriteback).toHaveBeenLastCalledWith({
      request,
      encryptedPayloadDigest: "digest-012345678901234567890123456789",
    });
    expect(h.provider.putEncryptedRepositorySecret).toHaveBeenCalledOnce();

    rejectPut();
    await expect(original).resolves.toEqual({
      status: "writeback_recovery_required",
    });
    expect(h.ledger.retireAmbiguousVersionedWriteback).toHaveBeenCalledWith(
      expect.objectContaining({
        intentId: "intent-1",
        attemptId: "attempt-1",
        executorOwner: "executor-1",
        retirementIdentity,
      }),
    );
  });

  it("claims one name, performs one PUT, attests V4, then activates", async () => {
    const h = harness();
    const dispatcher = new CodexRotatingVersionedWritebackDispatcher(
      h.ledger,
      h.provider,
      h.workflows,
      { now: () => now },
    );
    await expect(
      dispatcher.dispatchOneShot({
        request,
        encryptedPayloadDigest: "digest-012345678901234567890123456789",
      }),
    ).resolves.toEqual({ status: "accepted", generation: 2 });
    expect(h.events).toEqual([
      "claim",
      "put",
      "confirm-provider",
      "publish-verify-v4",
      "activate",
    ]);
    expect(h.provider.putEncryptedRepositorySecret).toHaveBeenCalledTimes(1);
    expect(h.provider.putEncryptedRepositorySecret).toHaveBeenCalledWith(
      expect.objectContaining({ secretName: namespace.name }),
    );
  });

  it.each(["provider", "workflow"] as const)(
    "permanently tombstones the one name after an ambiguous %s edge",
    async (edge) => {
      const h = harness();
      if (edge === "provider") {
        h.provider.putEncryptedRepositorySecret.mockRejectedValueOnce(
          new Error("dropped"),
        );
      } else {
        h.workflows.publishAndVerifyVersionedWorkflow.mockRejectedValueOnce(
          new Error("dropped"),
        );
      }
      const dispatcher = new CodexRotatingVersionedWritebackDispatcher(
        h.ledger,
        h.provider,
        h.workflows,
        { now: () => now },
      );
      await expect(
        dispatcher.dispatchOneShot({
          request,
          encryptedPayloadDigest: "digest-012345678901234567890123456789",
        }),
      ).resolves.toEqual({ status: "writeback_recovery_required" });
      expect(h.provider.putEncryptedRepositorySecret).toHaveBeenCalledTimes(1);
      expect(h.ledger.retireAmbiguousVersionedWriteback).toHaveBeenCalledTimes(
        1,
      );
      expect(h.events.at(-1)).toBe("tombstone");
    },
  );

  it("tombstones the name when durable provider confirmation fails", async () => {
    const h = harness();
    h.ledger.confirmVersionedProviderWrite.mockRejectedValueOnce(
      new Error("database_confirmation_unknown"),
    );
    const dispatcher = new CodexRotatingVersionedWritebackDispatcher(
      h.ledger,
      h.provider,
      h.workflows,
      { now: () => now },
    );
    await expect(
      dispatcher.dispatchOneShot({
        request,
        encryptedPayloadDigest: "digest-012345678901234567890123456789",
      }),
    ).resolves.toEqual({ status: "writeback_recovery_required" });
    expect(h.provider.putEncryptedRepositorySecret).toHaveBeenCalledOnce();
    expect(h.ledger.retireAmbiguousVersionedWriteback).toHaveBeenCalledWith({
      intentId: "intent-1",
      attemptId: "attempt-1",
      executorOwner: "executor-1",
      retirementIdentity,
      safeErrorCode: "versioned_provider_confirmation_outcome_unknown",
    });
    expect(
      h.workflows.publishAndVerifyVersionedWorkflow,
    ).not.toHaveBeenCalled();
  });

  it.each([
    "dropped-response",
    "provider-success",
    "workflow-publication",
  ] as const)(
    "retires at the exact executor expiry after %s crosses the boundary",
    async (crossingEdge) => {
      const h = harness();
      const executorExpiry = new Date(now.getTime() + 60_000);
      let current = now;
      if (crossingEdge === "dropped-response") {
        h.provider.putEncryptedRepositorySecret.mockImplementationOnce(
          async () => {
            current = executorExpiry;
            throw new Error("response_dropped_at_expiry");
          },
        );
      } else if (crossingEdge === "provider-success") {
        h.provider.putEncryptedRepositorySecret.mockImplementationOnce(
          async () => {
            current = executorExpiry;
            return { status: "accepted" as const, statusCode: 204 as const };
          },
        );
      } else {
        h.workflows.publishAndVerifyVersionedWorkflow.mockImplementationOnce(
          async () => {
            current = executorExpiry;
            return createVersionedSecretWorkflowSourceAttestation({
              repositoryId: "123456",
              workflowPath: ".github/workflows/reviewrouter-codex.yml",
              workflowSourceCommitSha: "a".repeat(40),
              workflowSourceBlobSha: "b".repeat(40),
              workflowSourceSha256: "c".repeat(64),
              workflowSemanticSha256: "d".repeat(64),
              workflowSchemaVersion: 5,
              sourceTrust: WorkflowSourceTrust.TrustedDefaultBranchRevision,
              secretNamespace: namespace,
            });
          },
        );
      }
      h.ledger.confirmVersionedProviderWrite.mockImplementationOnce(
        async () => {
          h.events.push("confirm-provider");
          if (current >= executorExpiry) {
            throw new Error("confirmation_at_expiry");
          }
        },
      );
      h.ledger.activateVersionedWriteback.mockImplementationOnce(async () => {
        h.events.push("activate");
        if (current >= executorExpiry) {
          throw new Error("activation_at_expiry");
        }
        return { generation: 2 };
      });
      h.ledger.retireAmbiguousVersionedWriteback.mockImplementationOnce(
        async () => {
          h.events.push("tombstone");
        },
      );
      const dispatcher = new CodexRotatingVersionedWritebackDispatcher(
        h.ledger,
        h.provider,
        h.workflows,
        { now: () => current },
      );

      await expect(
        dispatcher.dispatchOneShot({
          request,
          encryptedPayloadDigest: "digest-012345678901234567890123456789",
        }),
      ).resolves.toEqual({ status: "writeback_recovery_required" });
      expect(h.ledger.retireAmbiguousVersionedWriteback).toHaveBeenCalledOnce();
      expect(h.ledger.retireAmbiguousVersionedWriteback).toHaveBeenCalledWith(
        expect.objectContaining({
          retirementIdentity,
        }),
      );
      expect(h.provider.putEncryptedRepositorySecret).toHaveBeenCalledOnce();
      if (crossingEdge === "workflow-publication") {
        expect(
          h.workflows.publishAndVerifyVersionedWorkflow,
        ).toHaveBeenCalledOnce();
      }
    },
  );

  it("retires a typed pre-dispatch failure without recording an unknown PUT outcome", async () => {
    const h = harness();
    h.provider.putEncryptedRepositorySecret.mockRejectedValueOnce(
      new CodexRotatingSecretPutPreDispatchError(),
    );
    const dispatcher = new CodexRotatingVersionedWritebackDispatcher(
      h.ledger,
      h.provider,
      h.workflows,
      { now: () => now },
    );

    await expect(
      dispatcher.dispatchOneShot({
        request,
        encryptedPayloadDigest: "digest-012345678901234567890123456789",
      }),
    ).resolves.toEqual({ status: "github_put_failed" });

    expect(h.ledger.retirePreDispatchVersionedWriteback).toHaveBeenCalledWith({
      intentId: "intent-1",
      attemptId: "attempt-1",
      executorOwner: "executor-1",
      safeErrorCode: "versioned_provider_pre_dispatch_failed_v1",
    });
    expect(h.ledger.retireAmbiguousVersionedWriteback).not.toHaveBeenCalled();
    expect(h.ledger.confirmVersionedProviderWrite).not.toHaveBeenCalled();
    expect(
      h.workflows.publishAndVerifyVersionedWorkflow,
    ).not.toHaveBeenCalled();
  });

  it("does not touch the provider for a proven unchanged generation", async () => {
    const h = harness();
    h.ledger.prepareVersionedWriteback.mockResolvedValueOnce({
      status: "unchanged_generation",
      generation: 2,
    } as never);
    const dispatcher = new CodexRotatingVersionedWritebackDispatcher(
      h.ledger,
      h.provider,
      h.workflows,
      { now: () => now },
    );
    await expect(
      dispatcher.dispatchOneShot({
        request,
        encryptedPayloadDigest: "digest-012345678901234567890123456789",
      }),
    ).resolves.toEqual({ status: "accepted", generation: 2 });
    expect(h.provider.putEncryptedRepositorySecret).not.toHaveBeenCalled();
    expect(
      h.workflows.publishAndVerifyVersionedWorkflow,
    ).not.toHaveBeenCalled();
  });

  it("leaves durable clock ownership inside the ledger", async () => {
    const h = harness();
    const instants = [0, 1_000, 2_000].map(
      (offset) => new Date(now.getTime() + offset),
    );
    let clockRead = 0;
    const dispatcher = new CodexRotatingVersionedWritebackDispatcher(
      h.ledger,
      h.provider,
      h.workflows,
      { now: () => instants[Math.min(clockRead++, instants.length - 1)]! },
    );

    await dispatcher.dispatchOneShot({
      request,
      encryptedPayloadDigest: "digest-012345678901234567890123456789",
    });

    const prepareInput = (
      h.ledger.prepareVersionedWriteback.mock.calls as unknown[][]
    )[0]?.[0];
    const confirmInput = (
      h.ledger.confirmVersionedProviderWrite.mock.calls as unknown[][]
    )[0]?.[0];
    const activateInput = (
      h.ledger.activateVersionedWriteback.mock.calls as unknown[][]
    )[0]?.[0];
    expect(prepareInput).not.toHaveProperty("now");
    expect(confirmInput).not.toHaveProperty("now");
    expect(activateInput).not.toHaveProperty("now");
    expect(clockRead).toBe(0);
  });
});
