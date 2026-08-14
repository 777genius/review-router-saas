import { describe, expect, it, vi } from "vitest";
import {
  allocateVersionedProviderSecretNamespace,
  codexRotatingAuthMode,
} from "@reviewrouter/features-codex-oauth-rotating";
import { PrismaCodexRotatingOAuthRepository } from "../infrastructure/prisma/prisma-codex-rotating-oauth-repository.js";

describe("PrismaCodexRotatingOAuthRepository provider binding", () => {
  it("accepts an attested workflow binding without duplicating the database workflow source", async () => {
    const activeSecretNamespace = allocateVersionedProviderSecretNamespace({
      scope: {
        repositoryId: "123456",
        providerInstanceId: "codex-rotating:123456",
      },
      epoch: 2n,
      randomBytes: () => new Uint8Array(16).fill(0x44),
    });
    const existing = {
      id: "provider_1",
      workspaceId: "workspace_1",
      repositoryId: "repo_1",
      providerInstanceId: "codex-rotating:123456",
      authMode: codexRotatingAuthMode,
      activeSecretNamespaceId: activeSecretNamespace.namespaceId,
    };
    const tx = {
      codexOAuthProviderInstance: {
        findUnique: vi.fn().mockResolvedValue(existing),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (operation: (client: typeof tx) => unknown) =>
        operation(tx),
      ),
    };
    const repository = new PrismaCodexRotatingOAuthRepository(prisma as never, {
      actionOwnerRepo: "777genius/review-router",
    });

    await expect(
      repository.ensureVerifiedProviderBinding({
        repository: {
          workspaceId: "workspace_1",
          repositoryId: "repo_1",
          githubRepositoryId: "123456",
          githubInstallationId: "789",
          fullName: "777genius/example",
          owner: "777genius",
          selected: true,
          installationStatus: "active",
        },
        binding: {
          providerInstanceId: "codex-rotating:123456",
          repositoryFullName: "777genius/example",
          githubRepositoryId: "123456",
          actionRef:
            "777genius/review-router@0123456789abcdef0123456789abcdef01234567",
          workflowPath: ".github/workflows/reviewrouter-codex.yml",
          workflowSchemaVersion: 4,
          activeSecretNamespace,
        },
      }),
    ).resolves.toBeUndefined();
    expect(tx.codexOAuthProviderInstance.findUnique).toHaveBeenCalledOnce();
  });
});
