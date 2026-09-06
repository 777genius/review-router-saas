import { describe, expect, it, vi } from "vitest";
import { operatorConnectRepository } from "../application/use-cases/operator-connect-repository";
import {
  createDefaultHostedAccountPool,
  bindRepositoryToHostedPool,
  type HostedPoolRepositoryBinding,
} from "../domain/account-pool";
import {
  hostedPoolId,
  hostedBindingId,
  workspaceId,
  repositoryId,
} from "../domain/identifiers";

function fixture(
  status: "active" | "pending_activation" = "pending_activation",
) {
  const now = new Date();
  const pool = createDefaultHostedAccountPool({
    id: hostedPoolId("pool"),
    workspaceId: workspaceId("workspace"),
    now,
  });
  let binding: HostedPoolRepositoryBinding = {
    ...bindRepositoryToHostedPool({
      id: hostedBindingId("original"),
      pool,
      workspaceId: pool.workspaceId,
      repositoryId: repositoryId("repo"),
      now,
    }),
    status,
    attestedBindingRevision: status === "active" ? 1 : null,
  };
  const input = {
    bindingId: hostedBindingId("candidate"),
    repositoryId: binding.repositoryId,
    workspaceId: pool.workspaceId,
    expectedRevision: binding.revision,
    now,
  };
  const dependencies = {
    pools: {
      findDefaultByWorkspaceId: async () => pool,
      findById: async () => pool,
      insertDefault: async () => pool,
      advanceRevision: async () => pool,
    },
    bindings: {
      findByRepositoryId: async () => binding,
      save: vi.fn(async () => {
        throw new Error("retry must not rebind");
      }),
    },
    assertRepositoryAuthority: vi.fn(async () => {}),
    withRepositoryLock: async <T>(work: () => Promise<T>) => work(),
    activateExact: vi.fn(async (): Promise<"active" | "pending"> => "pending"),
    provisionOrResume: vi.fn(async () => ({
      pullRequestUrl: "https://github.invalid/owner/repo/pull/1",
    })),
  };
  return {
    input,
    dependencies,
    move: () => {
      binding = { ...binding, revision: 2 };
    },
  };
}
describe("operator repository connect orchestration", () => {
  it("active same-pool reconnect is a no-op without workflow or configuration writes", async () => {
    const f = fixture("active");
    expect(
      await operatorConnectRepository(f.input, f.dependencies),
    ).toMatchObject({
      status: "already_active",
      bindingId: "original",
      bindingRevision: 1,
    });
    expect(f.dependencies.activateExact).not.toHaveBeenCalled();
    expect(f.dependencies.provisionOrResume).not.toHaveBeenCalled();
    expect(f.dependencies.bindings.save).not.toHaveBeenCalled();
  });
  it("pending resumes the same binding and setup PR", async () => {
    const f = fixture();
    for (let i = 0; i < 2; i++)
      expect(
        await operatorConnectRepository(f.input, f.dependencies),
      ).toMatchObject({
        status: "setup_pr_open",
        bindingId: "original",
        bindingRevision: 1,
        setupPrUrl: "https://github.invalid/owner/repo/pull/1",
      });
    expect(f.dependencies.bindings.save).not.toHaveBeenCalled();
  });
  it("recovers missing activation using the exact verifier before provisioning", async () => {
    const f = fixture();
    f.dependencies.activateExact.mockResolvedValue("active");
    expect(
      await operatorConnectRepository(f.input, f.dependencies),
    ).toMatchObject({ status: "already_active" });
    expect(f.dependencies.provisionOrResume).not.toHaveBeenCalled();
  });
  it("rejects revoked authority before reads and effects", async () => {
    const f = fixture();
    f.dependencies.assertRepositoryAuthority.mockRejectedValue(
      new Error("revoked"),
    );
    await expect(
      operatorConnectRepository(f.input, f.dependencies),
    ).rejects.toThrow("revoked");
    expect(f.dependencies.activateExact).not.toHaveBeenCalled();
  });
  it("rejects a moved binding while workflow verification was in flight", async () => {
    const f = fixture();
    f.dependencies.activateExact.mockImplementation(async () => {
      f.move();
      return "pending";
    });
    await expect(
      operatorConnectRepository(f.input, f.dependencies),
    ).rejects.toThrow("conflict");
    expect(f.dependencies.provisionOrResume).not.toHaveBeenCalled();
  });
});
