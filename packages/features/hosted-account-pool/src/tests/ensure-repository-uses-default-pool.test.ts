import { describe, expect, it, vi } from "vitest";
import {
  bindRepositoryToHostedPool,
  createDefaultHostedAccountPool,
  type HostedPoolRepositoryBinding,
} from "../domain/account-pool";
import {
  hostedBindingId,
  hostedPoolId,
  repositoryId,
  workspaceId,
} from "../domain/identifiers";
import { ensureRepositoryUsesDefaultPool } from "../application/use-cases/ensure-repository-uses-default-pool";

const now = new Date("2026-09-06T00:00:00Z");
function fixture(
  status: HostedPoolRepositoryBinding["status"] | null = "active",
) {
  const pool = createDefaultHostedAccountPool({
    id: hostedPoolId("pool"),
    workspaceId: workspaceId("workspace"),
    now,
  });
  let binding: HostedPoolRepositoryBinding | null = status
    ? {
        ...bindRepositoryToHostedPool({
          id: hostedBindingId("original"),
          repositoryId: repositoryId("repo"),
          workspaceId: pool.workspaceId,
          pool,
          now,
        }),
        status,
        attestedBindingRevision: status === "active" ? 1 : null,
      }
    : null;
  const save = vi.fn(
    async (input: {
      binding: HostedPoolRepositoryBinding;
      expectedRevision: number | null;
    }) => {
      if ((binding?.revision ?? null) !== input.expectedRevision) return false;
      binding = input.binding;
      return true;
    },
  );
  const dependencies = {
    pools: {
      findDefaultByWorkspaceId: async () => pool,
      findById: async () => pool,
      insertDefault: async () => pool,
      advanceRevision: async () => pool,
    },
    bindings: { findByRepositoryId: async () => binding, save },
  };
  const input = {
    bindingId: hostedBindingId("new-id"),
    repositoryId: repositoryId("repo"),
    workspaceId: pool.workspaceId,
    expectedRevision: binding?.revision ?? null,
    now,
  };
  return {
    input,
    dependencies,
    save,
    binding,
    replace: (next: HostedPoolRepositoryBinding) => {
      binding = next;
    },
  };
}

describe("ensure default pool binding", () => {
  it("returns active unchanged without any save or configuration write", async () => {
    const f = fixture();
    const result = await ensureRepositoryUsesDefaultPool(
      f.input,
      f.dependencies,
    );
    expect(result).toEqual({ status: "already_active", binding: f.binding });
    expect(result.binding).toBe(f.binding);
    expect(f.save).not.toHaveBeenCalled();
  });
  it("resumes the exact pending binding and revision", async () => {
    const f = fixture("pending_activation");
    const result = await ensureRepositoryUsesDefaultPool(
      f.input,
      f.dependencies,
    );
    expect(result.binding.bindingId).toBe("original");
    expect(result.binding.revision).toBe(1);
    expect(result.status).toBe("pending_activation");
    expect(f.save).not.toHaveBeenCalled();
  });
  it("creates only once and reconciles a subsequent call", async () => {
    const f = fixture(null);
    const first = await ensureRepositoryUsesDefaultPool(
      f.input,
      f.dependencies,
    );
    const second = await ensureRepositoryUsesDefaultPool(
      { ...f.input, expectedRevision: first.binding.revision },
      f.dependencies,
    );
    expect(second.binding).toBe(first.binding);
    expect(f.save).toHaveBeenCalledTimes(1);
  });
  it.each([
    { status: "draining" as const },
    { poolId: hostedPoolId("other") },
    { workspaceId: workspaceId("other") },
    { repositoryId: repositoryId("other") },
    { revision: 2 },
    { attestedBindingRevision: null },
  ])("rejects incompatible or moved binding %j", async (change) => {
    const f = fixture();
    f.replace({ ...f.binding!, ...change });
    await expect(
      ensureRepositoryUsesDefaultPool(f.input, f.dependencies),
    ).rejects.toThrow(/conflict/);
    expect(f.save).not.toHaveBeenCalled();
  });
});
