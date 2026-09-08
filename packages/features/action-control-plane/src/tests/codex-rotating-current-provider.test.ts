import { lockCodexRotatingCurrentProvider } from "../infrastructure/prisma/codex-rotating-current-provider.js";
import { assertLockedCodexRotatingLeaseFence } from "../infrastructure/prisma/codex-rotating-current-provider.js";
import {
  createVersionedSecretWorkflowSourceAttestation,
  fingerprintDatabaseRecoveryWitness,
  WorkflowSourceTrust,
} from "@reviewrouter/features-codex-oauth-rotating";
import {
  assertLockedCodexRotatingNewWork,
  type LockedCodexRotatingCurrentProvider,
} from "../infrastructure/prisma/codex-rotating-current-provider.js";
import { allocateVersionedProviderSecretNamespace } from "@reviewrouter/features-codex-oauth-rotating";
import { describe, expect, it, vi } from "vitest";
import { readLockedCodexRotatingCurrentProvider } from "../infrastructure/prisma/codex-rotating-current-provider.js";

const scope = {
  workspaceId: "workspace",
  repositoryId: "repository",
  githubRepositoryId: "123456",
  providerInstanceId: "codex-rotating:123456",
};

describe("locked current provider reader", () => {
  it("reads the complete linked view after provider then namespace SHARE locks", async () => {
    const ns = allocateVersionedProviderSecretNamespace({
      scope: {
        repositoryId: scope.githubRepositoryId,
        providerInstanceId: scope.providerInstanceId,
      },
      epoch: 1n,
      randomBytes: () => new Uint8Array(16).fill(0x44),
    });
    const order: string[] = [];
    const provider = {
      id: "provider",
      ...scope,
      authMode: "codex_subscription_oauth_rotating",
      secretName: "REVIEWROUTER_CODEX_AUTH_JSON",
      activeSecretNamespaceId: ns.namespaceId,
      activeSecretNamespaceEpoch: ns.epoch,
      activeSecretNamespaceName: ns.name,
      activeLeaseId: "lease",
    };
    const namespace = {
      id: ns.namespaceId,
      providerInstanceRowId: "provider",
      githubRepositoryId: scope.githubRepositoryId,
      namespaceEpoch: ns.epoch,
      secretName: ns.name,
      status: "active",
      permanentlyRetired: false,
    };
    const retireAt = new Date("2026-09-09T00:00:00Z");
    const expiresAt = new Date("2026-09-09T01:00:00Z");
    const query = vi.fn(async (q: { strings: readonly string[] }) => {
      const sql = q.strings.join("");
      if (sql.includes('FROM "CodexOAuthProviderInstance"')) {
        expect(sql).toContain("FOR SHARE");
        order.push("provider lock");
        return [{ id: "provider" }];
      }
      if (sql.includes('FROM "CodexOAuthSecretNamespace"')) {
        expect(sql).toContain("FOR SHARE");
        order.push("namespace lock");
        return [namespace];
      }
      expect(sql).toContain('FROM "CodexOAuthWorkflowCompatibility"');
      order.push("compatibility");
      return [{ ...namespace, retireAt }];
    });
    const tx = {
      $queryRaw: query,
      codexOAuthProviderInstance: {
        findUnique: vi.fn(async () => {
          order.push("provider read");
          return provider;
        }),
      },
      codexOAuthWritebackIntent: {
        findMany: vi.fn(async () => {
          order.push("intents");
          return [];
        }),
      },
      codexOAuthSetupManifest: {
        findMany: vi.fn(async () => {
          order.push("manifests");
          return [{ id: "manifest", status: "issued", expiresAt }];
        }),
      },
      codexOAuthLease: {
        findUnique: vi.fn(async () => {
          order.push("lease");
          return { id: "lease", providerInstanceRowId: "provider", expiresAt };
        }),
      },
    };
    const view = await readLockedCodexRotatingCurrentProvider(
      tx as never,
      scope,
    );
    expect(order).toEqual([
      "provider lock",
      "provider read",
      "namespace lock",
      "intents",
      "manifests",
      "compatibility",
      "lease",
    ]);
    expect(view.canonicalNamespace).toEqual(ns);
    expect(view.compatibility?.retireAt).toEqual(retireAt);
    expect(view.manifests[0]?.expiresAt).toEqual(expiresAt);
    expect(view.lease?.expiresAt).toEqual(expiresAt);
    expect(tx.codexOAuthWritebackIntent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ providerInstanceRowId: "provider" }),
      }),
    );
  });
  it("rejects a root client before SQL", async () => {
    const query = vi.fn();
    await expect(
      readLockedCodexRotatingCurrentProvider(
        { $connect: vi.fn(), $queryRaw: query } as never,
        scope,
      ),
    ).rejects.toThrow("codex_rotating_transaction_required");
    expect(query).not.toHaveBeenCalled();
  });
  it("rejects absent provider before reading eligibility", async () => {
    const findUnique = vi.fn();
    const query = vi.fn(async () => []);
    await expect(
      readLockedCodexRotatingCurrentProvider(
        {
          $queryRaw: query,
          codexOAuthProviderInstance: { findUnique },
        } as never,
        scope,
      ),
    ).rejects.toThrow("codex_rotating_provider_not_found");
    expect(findUnique).not.toHaveBeenCalled();
    expect(query.mock.calls).toHaveLength(1);
  });
  it.each([
    "workspaceId",
    "repositoryId",
    "providerInstanceId",
    "authMode",
    "secretName",
  ] as const)(
    "rejects changed %s before namespace acquisition",
    async (field) => {
      const query = vi.fn(async () => [{ id: "provider" }]);
      const findUnique = vi.fn<
        (_args: unknown) => Promise<Record<string, unknown>>
      >(async () => ({
        id: "provider",
        ...scope,
        authMode: "codex_subscription_oauth_rotating",
        secretName: "REVIEWROUTER_CODEX_AUTH_JSON",
        [field]: "changed",
      }));
      await expect(
        readLockedCodexRotatingCurrentProvider(
          {
            $queryRaw: query,
            codexOAuthProviderInstance: { findUnique },
          } as never,
          scope,
        ),
      ).rejects.toThrow("codex_rotating_provider_identity_mismatch");
      expect(query).toHaveBeenCalledOnce();
      expect(findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "provider" } }),
      );
      const selected = findUnique.mock.calls[0]?.[0] as unknown as {
        select: Record<string, unknown>;
      };
      expect(selected.select).not.toHaveProperty("generationHashSalt");
      expect(selected.select).not.toHaveProperty("accountFingerprintSalt");
    },
  );
});

describe("locked provider new-work eligibility", () => {
  function fixture() {
    const witness = "witness_generation_one_12345678901234567890";
    const ns = allocateVersionedProviderSecretNamespace({
      scope: {
        repositoryId: scope.githubRepositoryId,
        providerInstanceId: scope.providerInstanceId,
      },
      epoch: 1n,
      randomBytes: () => new Uint8Array(16).fill(0x44),
    });
    const verified = createVersionedSecretWorkflowSourceAttestation({
      repositoryId: scope.githubRepositoryId,
      workflowPath: ".github/workflows/reviewrouter-codex.yml",
      workflowSourceCommitSha: "a".repeat(40),
      workflowSourceBlobSha: "b".repeat(40),
      workflowSourceSha256: "c".repeat(64),
      workflowSemanticSha256: "d".repeat(64),
      workflowSchemaVersion: 4,
      sourceTrust: WorkflowSourceTrust.TrustedDefaultBranchRevision,
      secretNamespace: ns,
    });
    const namespace = {
      ...verified,
      id: ns.namespaceId,
      providerInstanceRowId: "provider",
      githubRepositoryId: scope.githubRepositoryId,
      namespaceEpoch: ns.epoch,
      secretName: ns.name,
      status: "active",
      permanentlyRetired: false,
      attestedRepositoryId: scope.githubRepositoryId,
      workflowSourceTrust: verified.sourceTrust,
      databaseRecoveryWitness: fingerprintDatabaseRecoveryWitness(witness),
    };
    const view: LockedCodexRotatingCurrentProvider = {
      provider: {
        id: "provider",
        workspaceId: scope.workspaceId,
        repositoryId: scope.repositoryId,
        providerInstanceId: scope.providerInstanceId,
        authMode: "codex_subscription_oauth_rotating",
        secretName: "REVIEWROUTER_CODEX_AUTH_JSON",
        state: "active",
        mutationEpoch: 1n,
        mutationOwner: null,
        mutationOwnerId: null,
        activeLeaseId: null,
        activeLeaseExpiresAt: null,
        activeSecretNamespaceId: ns.namespaceId,
        activeSecretNamespaceEpoch: ns.epoch,
        activeSecretNamespaceName: ns.name,
      },
      namespace,
      canonicalNamespace: ns,
      compatibility: null,
      lease: null,
      intents: [],
      manifests: [],
    };
    return {
      view,
      verified,
      currentRecoveryWitness: witness,
      at: new Date("2026-09-09T00:00:00Z"),
      newWorkAdmissionBarrier: { assertAdmitted: vi.fn() },
    };
  }
  it("keeps current decisions private and closes the transaction handle", async () => {
    const input = fixture();
    const expiresAt = new Date(input.at.getTime() - 1);
    input.view.manifests.push({ id: "expired", status: "issued", expiresAt });
    const tx = {
      $queryRaw: vi.fn(async (q: { strings: readonly string[] }) => {
        const sql = q.strings.join("");
        if (sql.includes('FROM "CodexOAuthProviderInstance"'))
          return [{ id: "provider" }];
        if (sql.includes('FROM "CodexOAuthSecretNamespace"'))
          return [input.view.namespace];
        return [];
      }),
      codexOAuthProviderInstance: {
        findUnique: async () => input.view.provider,
      },
      codexOAuthWritebackIntent: { findMany: async () => input.view.intents },
      codexOAuthSetupManifest: { findMany: async () => input.view.manifests },
    };
    const handle = await lockCodexRotatingCurrentProvider(tx as never, scope);
    expect(handle.snapshot.manifests[0]?.expiresAtMs).toBe(expiresAt.getTime());
    expect(Object.isFrozen(handle.snapshot.manifests)).toBe(true);
    expect(handle.snapshot.namespace).not.toHaveProperty("secretNamespace");
    expect(handle.snapshot.namespace).not.toHaveProperty("retireAt");
    expect(
      Reflect.set(
        handle.snapshot.canonicalNamespace.scope,
        "repositoryId",
        "other",
      ),
    ).toBe(false);
    expect(
      Reflect.set(handle.snapshot.provider, "state", "needs_reconnect"),
    ).toBe(false);
    expect(handle.snapshot.provider.state).toBe("active");
    expiresAt.setTime(input.at.getTime() + 60000);
    input.view.provider.state = "needs_reconnect";
    expect(() => handle.assertNewWork(input)).not.toThrow();
    handle.close();
    handle.close();
    expect(() => handle.assertNewWork(input)).toThrow(
      "codex_rotating_current_view_closed",
    );
    expect(() =>
      handle.assertLeaseFence({
        at: input.at,
        leaseId: "x",
        githubRunId: "1",
        githubRunAttempt: "1",
        pullRequestNumber: 1,
        status: "preleased",
      }),
    ).toThrow("codex_rotating_current_view_closed");
  });
  it("admits the exact active source", () => {
    const input = fixture();
    expect(assertLockedCodexRotatingNewWork(input)).toBe(input.view.namespace);
    expect(input.newWorkAdmissionBarrier.assertAdmitted).toHaveBeenCalledOnce();
  });
  it.each(["unknown_auth_state", "needs_reconnect", "permission_required"])(
    "rejects %s",
    (state) => {
      const input = fixture();
      input.view.provider.state = state;
      expect(() => assertLockedCodexRotatingNewWork(input)).toThrow(
        `codex_rotating_provider_${state}`,
      );
    },
  );
  it.each(["setup", "recovery"])("rejects %s ownership", (owner) => {
    const input = fixture();
    input.view.provider.mutationOwner = owner;
    expect(() => assertLockedCodexRotatingNewWork(input)).toThrow(
      "codex_rotating_mutation_fence_conflict",
    );
  });
  it.each(["pending", "remote_outcome_unknown"])(
    "rejects unresolved %s",
    (status) => {
      const input = fixture();
      input.view.intents.push({
        id: "intent",
        status,
        recoveryResolvedAt: null,
      });
      expect(() => assertLockedCodexRotatingNewWork(input)).toThrow(
        "codex_rotating_mutation_fence_conflict",
      );
    },
  );
  it("permits resolved remote outcome history", () => {
    const input = fixture();
    input.view.intents.push({
      id: "intent",
      status: "remote_outcome_unknown",
      recoveryResolvedAt: input.at,
    });
    expect(() => assertLockedCodexRotatingNewWork(input)).not.toThrow();
  });
  it("fails a live lease pointer with missing lease", () => {
    const input = fixture();
    input.view.provider.activeLeaseId = "missing";
    input.view.provider.activeLeaseExpiresAt = new Date(input.at.getTime() + 1);
    expect(() => assertLockedCodexRotatingNewWork(input)).toThrow(
      "codex_rotating_active_lease_conflict",
    );
  });
  it.each([
    ["issued", -1, false],
    ["issued", 0, false],
    ["issued", 1, true],
    ["fetched", -1, true],
    ["fetched", 0, true],
    ["fetched", 1, true],
  ] as const)(
    "evaluates %s manifest at deadline offset %s",
    (status, offset, blocked) => {
      const input = fixture();
      input.view.manifests.push({
        id: "manifest",
        status,
        expiresAt: new Date(input.at.getTime() + offset),
      });
      if (blocked)
        expect(() => assertLockedCodexRotatingNewWork(input)).toThrow(
          "codex_rotating_mutation_fence_conflict",
        );
      else expect(() => assertLockedCodexRotatingNewWork(input)).not.toThrow();
    },
  );
  it.each([-1, 0, 1])(
    "evaluates a live lease at deadline offset %s",
    (offset) => {
      const input = fixture();
      input.view.provider.activeLeaseId = "lease";
      input.view.provider.activeLeaseExpiresAt = new Date(
        input.at.getTime() + offset,
      );
      input.view.lease = {
        id: "lease",
        providerInstanceRowId: "provider",
        githubRunId: "1",
        githubRunAttempt: "1",
        pullRequestNumber: 1,
        status: "preleased",
        expiresAt: new Date(input.at.getTime() + offset),
        mutationEpoch: 1n,
        secretNamespaceId: input.view.namespace.id,
        secretNamespaceEpoch: 1n,
      };
      if (offset > 0)
        expect(() => assertLockedCodexRotatingNewWork(input)).toThrow(
          "codex_rotating_active_lease_conflict",
        );
      else expect(() => assertLockedCodexRotatingNewWork(input)).not.toThrow();
    },
  );
  it("rejects invalid final storage time before the barrier", () => {
    const input = fixture();
    input.at = new Date(NaN);
    expect(() => assertLockedCodexRotatingNewWork(input)).toThrow(
      "codex_rotating_storage_time_invalid",
    );
    expect(input.newWorkAdmissionBarrier.assertAdmitted).not.toHaveBeenCalled();
  });
  function activeLeaseFixture() {
    const input = fixture();
    input.view.provider.activeLeaseId = "lease";
    input.view.provider.activeLeaseExpiresAt = new Date(
      input.at.getTime() + 1000,
    );
    input.view.provider.mutationOwner = "runtime";
    input.view.provider.mutationOwnerId = "lease";
    input.view.lease = {
      id: "lease",
      providerInstanceRowId: "provider",
      githubRunId: "1",
      githubRunAttempt: "2",
      pullRequestNumber: 7,
      status: "finalized",
      expiresAt: new Date(input.at.getTime() + 1000),
      mutationEpoch: 1n,
      secretNamespaceId: input.view.namespace.id,
      secretNamespaceEpoch: 1n,
    };
    return {
      ...input,
      leaseId: "lease",
      githubRunId: "1",
      githubRunAttempt: "2",
      pullRequestNumber: 7,
      status: "finalized" as const,
    };
  }
  it("accepts an exact active lease even though new work conflicts", () => {
    const input = activeLeaseFixture();
    expect(() => assertLockedCodexRotatingLeaseFence(input)).not.toThrow();
    expect(() => assertLockedCodexRotatingNewWork(input)).toThrow(
      "codex_rotating_active_lease_conflict",
    );
  });
  it.each(["leaseId", "githubRunId", "githubRunAttempt"] as const)(
    "rejects mismatched lease command %s",
    (key) => {
      const input = activeLeaseFixture();
      input[key] = "other";
      expect(() => assertLockedCodexRotatingLeaseFence(input)).toThrow(
        "codex_rotating_lease_not_active",
      );
    },
  );
  it("rejects a different PR", () => {
    const input = activeLeaseFixture();
    input.pullRequestNumber++;
    expect(() => assertLockedCodexRotatingLeaseFence(input)).toThrow(
      "codex_rotating_lease_not_active",
    );
  });
  it.each(["mutationOwner", "mutationOwnerId", "activeLeaseId"] as const)(
    "rejects changed provider %s",
    (key) => {
      const input = activeLeaseFixture();
      input.view.provider[key] = "other";
      expect(() => assertLockedCodexRotatingLeaseFence(input)).toThrow(
        "codex_rotating_lease_not_active",
      );
    },
  );
  it("rejects a newer mutation epoch", () => {
    const input = activeLeaseFixture();
    input.view.provider.mutationEpoch++;
    expect(() => assertLockedCodexRotatingLeaseFence(input)).toThrow(
      "codex_rotating_lease_not_active",
    );
  });
  it.each(["provider", "lease"] as const)(
    "rejects %s deadline equality independently",
    (source) => {
      const input = activeLeaseFixture();
      if (source === "provider")
        input.view.provider.activeLeaseExpiresAt = input.at;
      else input.view.lease!.expiresAt = input.at;
      expect(() => assertLockedCodexRotatingLeaseFence(input)).toThrow(
        "codex_rotating_lease_not_active",
      );
    },
  );
  it("propagates the final closed barrier", () => {
    const input = fixture();
    input.newWorkAdmissionBarrier.assertAdmitted.mockImplementation(() => {
      throw new Error("closed");
    });
    expect(() => assertLockedCodexRotatingNewWork(input)).toThrow("closed");
  });
});
