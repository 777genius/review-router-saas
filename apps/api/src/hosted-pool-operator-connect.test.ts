import { renderCanonicalCodexRotatingT0WorkflowV2 } from "@reviewrouter/features-codex-oauth-rotating";
import type { PrismaClient } from "@reviewrouter/platform-db";
import {
  canonicalHostedPoolProviderInstanceId,
  renderCanonicalHostedPoolWorkflowV2,
} from "@reviewrouter/features-workflow-provisioning";
import { describe, expect, it, vi } from "vitest";
import { createHostedPoolOperatorConnect } from "./hosted-pool-operator-connect";

function fixture(status = "setup_pr_open") {
  const now = new Date();
  const sha = "a".repeat(40);
  const actionRef = `777genius/review-router@${sha}`;
  const binding = {
    id: "binding",
    repositoryConnectionId: "repo",
    workspaceId: "workspace",
    poolId: "pool",
    status: "pending_activation",
    revision: 1n,
    stateVersion: 1n,
    attestedBindingRevision: null,
    activatedAt: null,
    drainingAt: null,
    tombstonedAt: null,
    createdAt: new Date(now.getTime() - 1000),
    updatedAt: now,
  };
  const repository = {
    id: "repo",
    workspaceId: "workspace",
    fullName: "owner/repo",
    owner: "owner",
    name: "repo",
    defaultBranch: "main",
    githubRepositoryId: 42n,
    provider: "github",
    selected: true,
    archived: false,
    visibility: "private",
    installationId: "installation",
    installation: {
      id: "installation",
      githubInstallationId: 8n,
      status: "active",
    },
  };
  let setup = {
    repositoryId: "repo",
    workspaceId: "workspace",
    installationId: "installation",
    attemptId: "attempt-original",
    revision: 4,
    branch: "rr-setup-original",
    workflowStyle: "reusable",
    workflowPath: ".github/workflows/reviewrouter-codex.yml",
    actionVersion: actionRef,
    status,
    pullRequestUrl:
      status === "setup_pr_open"
        ? "https://github.invalid/owner/repo/pull/1"
        : null,
    updatedAt: now,
  };
  const update = vi.fn(async ({ where, data }) => {
    if (where.revision !== setup.revision || where.status !== setup.status)
      return { count: 0 };
    setup = {
      ...setup,
      ...data,
      revision:
        typeof data.revision === "object" ? setup.revision + 1 : setup.revision,
    };
    return { count: 1 };
  });
  const tx = {
    repositoryConnection: {
      findFirst: vi.fn(async () => repository),
      findUnique: async () => repository,
    },
    hostedCodexPool: {
      findMany: async () => [
        {
          id: "pool",
          workspaceId: "workspace",
          isDefault: true,
          revision: 1n,
          status: "active",
          createdAt: now,
          updatedAt: now,
        },
      ],
    },
    hostedCodexRepositoryBinding: {
      findUnique: async () => binding,
      updateMany: vi.fn(async () => {
        throw new Error("must not rebind");
      }),
    },
    workflowProvisioning: { findUnique: async () => setup, updateMany: update },
  };
  const prisma = {
    ...tx,
    $transaction: async (work: (client: typeof tx) => Promise<unknown>) =>
      work(tx),
  } as unknown as PrismaClient;
  let content = renderCanonicalHostedPoolWorkflowV2({
    actionRef,
    apiUrl: "https://rr.invalid",
    providerInstanceId: canonicalHostedPoolProviderInstanceId("42"),
    bindingId: "binding",
    bindingRevision: 1,
  });
  const pull = {
    number: 1,
    html_url: "https://github.invalid/owner/repo/pull/1",
    head: { sha, ref: "rr-setup-original", repo: { id: 42 } },
    base: { ref: "main", repo: { id: 42 } },
    state: "open",
    merged_at: null as string | null,
  };
  const request = vi.fn(
    async (route: string, params?: Record<string, unknown>) => {
      if (route === "GET /repos/{owner}/{repo}")
        return {
          data: {
            id: 42,
            full_name: "owner/repo",
            archived: false,
            default_branch: "main",
          },
        };
      if (route === "GET /repos/{owner}/{repo}/contents/{path}") {
        if (params?.path !== setup.workflowPath) throw { status: 404 };
        return {
          data: {
            type: "file",
            content: Buffer.from(content).toString("base64"),
            encoding: "base64",
            sha,
          },
        };
      }
      if (route === "PUT /repos/{owner}/{repo}/contents/{path}") {
        content = Buffer.from(String(params?.content), "base64").toString(
          "utf8",
        );
        return { data: {} };
      }
      if (route === "GET /repos/{owner}/{repo}/git/ref/{ref}")
        return { data: { object: { sha } } };
      if (route === "PATCH /repos/{owner}/{repo}/git/refs/{ref}")
        return { data: { object: { sha } } };
      if (route === "POST /repos/{owner}/{repo}/git/refs")
        throw { status: 422 };
      if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}")
        return { data: pull };
      if (route === "GET /repos/{owner}/{repo}/pulls")
        return { data: params?.state === pull.state ? [pull] : [] };

      if (route === "PATCH /repos/{owner}/{repo}/pulls/{pull_number}") {
        if (params?.state === "open") pull.state = "open";
        return { data: pull };
      }

      throw new Error(`unexpected fake GitHub request: ${route}`);
    },
  );
  const lock = vi.fn((key: string) => {
    expect(key).toBe("repo:repo:workflow-provision");
  });
  const connect = createHostedPoolOperatorConnect({
    prisma,
    actionRef,
    apiUrl: "https://rr.invalid",
    lock: {
      withLock: async (key, _ttl, work) => {
        lock(key);
        return work();
      },
    },
    authorize: async () => {},
    installationOctokit: async () => ({ request }),
    activateExact: async () => "pending",
  });
  return {
    connect: () =>
      connect({
        workspaceId: "workspace",
        operatorId: "operator",
        repository: "owner/repo",
        expectedRevision: 1,
      }),
    request,
    update,
    tx,
    setup: () => setup,
    lock,
    migrate: () => {
      content = renderCanonicalCodexRotatingT0WorkflowV2({
        actionRef,
        apiUrl: "https://rr.invalid",
        providerInstanceId: "native-repository-42",
        refreshScheduleCron: null,
      });
    },
    content: () => content,
    closePull: (merged = false) => {
      pull.state = "closed";
      pull.merged_at = merged ? now.toISOString() : null;
    },
    foreignSetup: () => {
      setup = { ...setup, workspaceId: "foreign" };
    },
    corrupt: () => {
      content = content.replace(
        'session_binding_id: "binding"',
        'session_binding_id: "other"',
      );
    },
  };
}

describe("operator connect with existing Prisma/provisioning/GitHub adapters", () => {
  it("keeps an open exact setup PR and binding without writes", async () => {
    const f = fixture();
    expect(await f.connect()).toMatchObject({
      status: "setup_pr_open",
      bindingId: "binding",
      bindingRevision: 1,
    });
    expect(await f.connect()).toMatchObject({
      setupPrUrl: "https://github.invalid/owner/repo/pull/1",
    });
    expect(f.update).not.toHaveBeenCalled();
    expect(f.tx.hostedCodexRepositoryBinding.updateMany).not.toHaveBeenCalled();
    expect(
      f.request.mock.calls.every(([route]) => route.startsWith("GET ")),
    ).toBe(true);
    expect(f.lock.mock.calls[0]?.[0]).toBe("repo:repo:workflow-provision");
  });
  it("reopens an unmerged closed setup PR without a new attempt or binding", async () => {
    const f = fixture();
    f.closePull();
    expect(await f.connect()).toMatchObject({ status: "setup_pr_open" });
    expect(f.request).toHaveBeenCalledWith(
      "GET /repos/{owner}/{repo}/pulls/{pull_number}",
      expect.objectContaining({ pull_number: 1 }),
    );
    expect(f.request).toHaveBeenCalledWith(
      "PATCH /repos/{owner}/{repo}/pulls/{pull_number}",
      expect.objectContaining({ pull_number: 1, state: "open" }),
    );
    expect(f.setup()).toMatchObject({
      attemptId: "attempt-original",
      branch: "rr-setup-original",
    });
    expect(f.tx.hostedCodexRepositoryBinding.updateMany).not.toHaveBeenCalled();
    expect(
      f.request.mock.calls.some(
        ([route]) => route === "POST /repos/{owner}/{repo}/pulls",
      ),
    ).toBe(false);
    const writes = f.update.mock.calls.length;
    await f.connect();
    expect(f.update).toHaveBeenCalledTimes(writes);
  });
  it("does not reopen a merged PR when canonical activation is still unconfirmed", async () => {
    const f = fixture();
    f.closePull(true);
    await expect(f.connect()).rejects.toThrow("setup_conflict");
    expect(f.update).not.toHaveBeenCalled();
    expect(
      f.request.mock.calls.every(([route]) => route.startsWith("GET ")),
    ).toBe(true);
  });
  it("reconciles an existing branch/PR after a lost response without allocating a new attempt", async () => {
    const f = fixture("failed");
    expect(await f.connect()).toMatchObject({ status: "setup_pr_open" });
    expect(f.setup()).toMatchObject({
      attemptId: "attempt-original",
      branch: "rr-setup-original",
      status: "setup_pr_open",
    });
    expect(
      f.request.mock.calls.some(
        ([route]) => route === "POST /repos/{owner}/{repo}/pulls",
      ),
    ).toBe(false);
    expect(f.update).toHaveBeenCalledTimes(2);
  });
  it("converts an existing canonical repository-owned setup in the same PR without re-enrollment", async () => {
    const f = fixture();
    f.migrate();
    expect(await f.connect()).toMatchObject({
      status: "setup_pr_open",
      bindingId: "binding",
      bindingRevision: 1,
    });
    expect(f.setup()).toMatchObject({
      attemptId: "attempt-original",
      branch: "rr-setup-original",
    });
    expect(f.content()).toContain('session_binding_id: "binding"');
    expect(f.content()).not.toContain("REVIEWROUTER_CODEX_AUTH_JSON");
    expect(
      f.request.mock.calls.some(
        ([route]) => route === "POST /repos/{owner}/{repo}/pulls",
      ),
    ).toBe(false);
    expect(f.tx.hostedCodexRepositoryBinding.updateMany).not.toHaveBeenCalled();
  });
  it("rejects a setup record outside the current workspace", async () => {
    const f = fixture();
    f.foreignSetup();
    await expect(f.connect()).rejects.toThrow("conflict");
    expect(f.update).not.toHaveBeenCalled();
  });
  it("rejects an attempt belonging to another binding before a GitHub write", async () => {
    const f = fixture("failed");
    f.corrupt();
    await expect(f.connect()).rejects.toThrow("setup_conflict");
    expect(f.update).not.toHaveBeenCalled();
    expect(
      f.request.mock.calls.every(([route]) => route.startsWith("GET ")),
    ).toBe(true);
  });
});
