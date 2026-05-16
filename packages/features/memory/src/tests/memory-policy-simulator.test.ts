import { describe, expect, it } from "vitest";
import type { MemoryActor } from "../domain/memory-actor";
import type { MemoryScope } from "../domain/memory-scope-policy";
import type {
  MemoryPermissionDecision,
  MemoryPermissionPort,
} from "../application/ports/memory-permission-port";
import {
  StaticMemoryPolicyConfig,
  type MemoryPolicyConfigPort,
} from "../application/ports/memory-policy-config-port";
import type {
  MemoryQuotaPolicyPort,
  MemoryWorkspaceQuota,
} from "../application/ports/memory-quota-policy-port";
import {
  simulateMemoryPolicyDecision,
  type MemoryPolicySimulationDependencies,
} from "../application/use-cases/simulate-memory-policy";

const actor: MemoryActor = {
  kind: "github_user",
  id: "user_1",
  githubUserId: "1001",
  login: "octo-admin",
};

describe("simulateMemoryPolicyDecision", () => {
  it("denies writes at policy before checking permission or quota", async () => {
    const permissions = new CapturingPermissions({ allowed: true });
    const dependencies = createDependencies({
      policy: new StaticMemoryPolicyConfig({ memoryEnabled: false }),
      permissions,
    });

    const result = await simulateMemoryPolicyDecision(
      input({ action: "direct_save", scope: "workspace" }),
      dependencies,
    );

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("memory_disabled");
    expect(result.blockedBy).toBe("policy");
    expect(result.invalidates).toEqual([
      "runtime_bundle",
      "pending_suggestions",
      "confirmed_memory",
    ]);
    expect(permissions.calls).toBe(0);
  });

  it("uses the same permission port as real confirmation mutations", async () => {
    const dependencies = createDependencies({
      permissions: new CapturingPermissions({
        allowed: false,
        reason: "not_workspace_admin",
        retryable: false,
      }),
    });

    const result = await simulateMemoryPolicyDecision(
      input({ action: "confirm_suggestion", scope: "workspace" }),
      dependencies,
    );

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("not_workspace_admin");
    expect(result.blockedBy).toBe("permission");
    expect(result.requiredAuthority).toBe("workspace_admin");
  });

  it("blocks synthetic unsafe fixtures without accepting raw memory text", async () => {
    const dependencies = createDependencies();

    const result = await simulateMemoryPolicyDecision(
      input({
        action: "propose_suggestion",
        scope: "repository",
        safetyFixture: "prompt_injection",
      }),
      dependencies,
    );

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("contains_prompt_injection");
    expect(result.blockedBy).toBe("safety");
    expect(result.safety.flags).toContain("contains_prompt_injection");
    expect(result.safety.mayUseInRuntimeBundle).toBe(false);
  });

  it("checks active memory quota for direct saves", async () => {
    const dependencies = createDependencies({
      activeCount: 1,
      quota: new StaticQuotaPolicy({
        activeItems: { limit: 1 },
        pendingSuggestions: { limit: null },
      }),
    });

    const result = await simulateMemoryPolicyDecision(
      input({ action: "direct_save", scope: "repository" }),
      dependencies,
    );

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("memory_active_item_quota_exceeded");
    expect(result.blockedBy).toBe("quota");
    expect(result.invalidates).toEqual(["confirmed_memory"]);
  });

  it("allows a safe pending suggestion when policy, safety and quota allow it", async () => {
    const dependencies = createDependencies({
      pendingCount: 0,
      quota: new StaticQuotaPolicy({
        activeItems: { limit: null },
        pendingSuggestions: { limit: 1 },
      }),
    });

    const result = await simulateMemoryPolicyDecision(
      input({ action: "propose_suggestion", scope: "repository" }),
      dependencies,
    );

    expect(result.allowed).toBe(true);
    expect(result.reason).toBe("allowed");
    expect(result.policyHash).toMatch(/^fnv1a:/);
    expect(result.precedence).toEqual([
      "scope",
      "policy",
      "safety",
      "pending_quota",
    ]);
  });
});

function input(
  overrides: Partial<Parameters<typeof simulateMemoryPolicyDecision>[0]> = {},
): Parameters<typeof simulateMemoryPolicyDecision>[0] {
  const scope = overrides.scope ?? "repository";
  return {
    workspaceId: "workspace_1",
    repositoryId:
      overrides.repositoryId === undefined
        ? scope === "repository"
          ? "repo_1"
          : null
        : overrides.repositoryId,
    userId:
      overrides.userId === undefined
        ? scope === "user_prefs"
          ? actor.id
          : null
        : overrides.userId,
    scope,
    actor,
    action: overrides.action ?? "direct_save",
    safetyFixture: overrides.safetyFixture ?? "safe_project_rule",
    now: overrides.now ?? new Date("2026-05-12T12:00:00.000Z"),
  };
}

function createDependencies(
  options: {
    readonly policy?: MemoryPolicyConfigPort;
    readonly permissions?: MemoryPermissionPort;
    readonly quota?: MemoryQuotaPolicyPort;
    readonly activeCount?: number;
    readonly pendingCount?: number;
  } = {},
): MemoryPolicySimulationDependencies {
  return {
    memoryPolicyConfig: options.policy ?? new StaticMemoryPolicyConfig(),
    memoryPermissions:
      options.permissions ?? new CapturingPermissions({ allowed: true }),
    memoryItems: {
      async countActiveForWorkspace(): Promise<number> {
        return options.activeCount ?? 0;
      },
    },
    memorySuggestions: {
      async countPendingForWorkspace(): Promise<number> {
        return options.pendingCount ?? 0;
      },
    },
    ...(options.quota ? { memoryQuotaPolicy: options.quota } : {}),
  };
}

class CapturingPermissions implements MemoryPermissionPort {
  calls = 0;

  constructor(private readonly decision: MemoryPermissionDecision) {}

  async canConfirmMemory(input: {
    readonly workspaceId: string;
    readonly repositoryId: string | null;
    readonly userId: string | null;
    readonly scope: MemoryScope;
    readonly actor: MemoryActor;
  }): Promise<MemoryPermissionDecision> {
    void input;
    this.calls += 1;
    return this.decision;
  }
}

class StaticQuotaPolicy implements MemoryQuotaPolicyPort {
  constructor(private readonly quota: MemoryWorkspaceQuota) {}

  async getWorkspaceQuota(): Promise<MemoryWorkspaceQuota> {
    return this.quota;
  }
}
