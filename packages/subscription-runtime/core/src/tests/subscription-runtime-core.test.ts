import { describe, expect, it } from "vitest";
import {
  DefaultRedactor,
  RuntimeConfigurationError,
  assertCompatibleRuntimeManifests,
  createAdapterRegistry,
  assertLeaseTransition,
  assertNoSessionBytesInConfig,
  assertSessionTransition,
  createSubscriptionRuntime,
  defineSubscriptionRuntimeConfig,
  negotiateCapabilities,
} from "../index";
import {
  FakeAgentDriver,
  FakeProviderSessionDriver,
  InMemorySessionStore,
  MemoryObservability,
  agentDriverContract,
  fakeAgentCapabilities,
  fakeProviderCapabilities,
  fakeRunnerCapabilities,
  fakeStoreCapabilities,
  makeFakeArtifact,
  makeFakeRuntimeDeps,
  providerSessionDriverContract,
  sessionStoreContract,
} from "../testing";

const fakeProviderManifest = {
  adapterId: "provider.fake",
  adapterKind: "combined-provider",
  packageName: "@reviewrouter/subscription-runtime-provider-fake",
  packageVersion: "0.0.0",
  protocolVersion: 1,
  capabilities: {
    session: fakeProviderCapabilities,
    agent: fakeAgentCapabilities,
  },
  experimental: false,
  minimumCoreVersion: "0.0.0",
} as const;

const fakeStoreManifest = {
  adapterId: "store.memory",
  adapterKind: "store",
  packageName: "@reviewrouter/subscription-runtime-store-memory",
  packageVersion: "0.0.0",
  protocolVersion: 1,
  capabilities: fakeStoreCapabilities,
  custody: "no-plaintext-backend",
  experimental: false,
  minimumCoreVersion: "0.0.0",
} as const;

const fakeRunnerManifest = {
  adapterId: "runner.memory",
  adapterKind: "runner",
  packageName: "@reviewrouter/subscription-runtime-runner-memory",
  packageVersion: "0.0.0",
  protocolVersion: 1,
  capabilities: fakeRunnerCapabilities,
  experimental: false,
  minimumCoreVersion: "0.0.0",
} as const;

describe("subscription runtime core policy", () => {
  it("accepts a no-custody provider/store/runner combination", () => {
    const decision = negotiateCapabilities({
      requested: makeFakeRuntimeDeps().policy,
      provider: fakeProviderCapabilities,
      agent: new FakeAgentDriver().capabilities,
      store: fakeStoreCapabilities,
      runner: fakeRunnerCapabilities,
    });

    expect(decision.status).toBe("accepted");
    if (decision.status === "accepted") {
      expect(decision.compiledPolicy.trustMode).toBe("no-plaintext-backend");
    }
  });

  it("rejects backend plaintext when policy requires no-custody", () => {
    const decision = negotiateCapabilities({
      requested: makeFakeRuntimeDeps().policy,
      provider: fakeProviderCapabilities,
      agent: new FakeAgentDriver().capabilities,
      store: {
        ...fakeStoreCapabilities,
        custody: "backend-custody",
        plaintextAvailableToBackend: true,
      },
      runner: fakeRunnerCapabilities,
    });

    expect(decision).toMatchObject({
      status: "rejected",
      code: "custody_mode_forbidden",
    });
  });

  it("rejects agent/provider mismatches before runtime construction", () => {
    const decision = negotiateCapabilities({
      requested: makeFakeRuntimeDeps().policy,
      provider: fakeProviderCapabilities,
      agent: {
        ...new FakeAgentDriver().capabilities,
        providerId: "other-provider",
      },
      store: fakeStoreCapabilities,
      runner: fakeRunnerCapabilities,
    });

    expect(decision).toMatchObject({
      status: "rejected",
      code: "provider_store_incompatible",
    });
  });
});

describe("subscription runtime adapter manifests", () => {
  it("accepts compatible no-custody manifests before runtime construction", () => {
    expect(() =>
      assertCompatibleRuntimeManifests({
        provider: fakeProviderManifest,
        store: fakeStoreManifest,
        runner: fakeRunnerManifest,
        policy: makeFakeRuntimeDeps().policy,
      }),
    ).not.toThrow();
  });

  it("rejects duplicate registry ids and incompatible manifests", () => {
    const registry = createAdapterRegistry([
      {
        manifest: fakeProviderManifest,
        create: () => new FakeProviderSessionDriver(),
      },
    ]);

    expect(registry.getManifest("provider.fake")).toMatchObject({
      adapterId: "provider.fake",
    });
    expect(() =>
      registry.register({
        manifest: fakeProviderManifest,
        create: () => new FakeProviderSessionDriver(),
      }),
    ).toThrow(RuntimeConfigurationError);

    expect(() =>
      assertCompatibleRuntimeManifests({
        provider: fakeProviderManifest,
        store: {
          ...fakeStoreManifest,
          capabilities: {
            ...fakeStoreCapabilities,
            custody: "backend-custody",
            plaintextAvailableToBackend: true,
          },
        },
        runner: fakeRunnerManifest,
        policy: makeFakeRuntimeDeps().policy,
      }),
    ).toThrow(RuntimeConfigurationError);
  });

  it("keeps runtime config declarative and rejects embedded session secrets", () => {
    expect(
      defineSubscriptionRuntimeConfig({
        custodyMode: "no-plaintext-backend",
        providers: ["provider.fake"],
      }),
    ).toMatchObject({ custodyMode: "no-plaintext-backend" });

    expect(() =>
      assertNoSessionBytesInConfig({
        provider: {
          refresh_token: "raw-refresh-token",
        },
      }),
    ).toThrow(RuntimeConfigurationError);
  });
});

describe("subscription runtime state machines", () => {
  it("allows valid session and lease transitions", () => {
    expect(() => assertSessionTransition("missing", "seeded")).not.toThrow();
    expect(() => assertLeaseTransition("requested", "granted")).not.toThrow();
  });

  it("rejects invalid session transitions", () => {
    expect(() => assertSessionTransition("active", "refreshing")).toThrow(
      "Invalid session transition",
    );
  });
});

describe("subscription runtime redaction", () => {
  it("redacts registered secrets and token-looking fields", () => {
    const redactor = new DefaultRedactor();
    redactor.registerSecret("secret-value", "unit");

    expect(redactor.redact("token=abc secret-value")).toBe(
      "token=[redacted:token-field] [redacted:unit]",
    );
    expect(() =>
      redactor.assertNoKnownSecret("leaked secret-value", "unit-test"),
    ).toThrow("Known secret leaked");
  });
});

describe("subscription runtime use cases", () => {
  it("refreshes a rotating session, writes back once, then runs the task", async () => {
    const store = new InMemorySessionStore();
    store.seed({
      providerInstanceId: "provider-instance-1",
      artifact: makeFakeArtifact("session-v1"),
    });
    const agent = new FakeAgentDriver();
    const runtime = createSubscriptionRuntime(
      makeFakeRuntimeDeps({ store, agent }),
    );

    const result = await runtime.refreshThenRunTask({
      providerInstanceId: "provider-instance-1",
      task: { kind: "review", prompt: "inspect diff" },
      runContext: {
        runId: "run-1",
        attempt: 1,
        abortSignal: new AbortController().signal,
      },
    });

    expect(result.status).toBe("completed");
    expect(agent.lastPrompt).toBe("inspect diff");
    const next = await store.read({
      providerInstanceId: "provider-instance-1",
      expectedProviderId: "fake",
      purpose: "health-check",
    });
    expect(next?.generation).toBe(2);
  });

  it("emits structured observability events without session bytes", async () => {
    const store = new InMemorySessionStore();
    store.seed({
      providerInstanceId: "provider-instance-1",
      artifact: makeFakeArtifact("session-v1-secret"),
    });
    const observability = new MemoryObservability();
    const runtime = createSubscriptionRuntime(
      makeFakeRuntimeDeps({ store, observability }),
    );

    const result = await runtime.refreshThenRunTask({
      providerInstanceId: "provider-instance-1",
      task: { kind: "review", prompt: "inspect diff" },
      runContext: {
        runId: "run-observe",
        attempt: 1,
        abortSignal: new AbortController().signal,
      },
    });

    expect(result.status).toBe("completed");
    expect(observability.events.map((event) => event.name)).toEqual(
      expect.arrayContaining([
        "session.read.started",
        "session.read.completed",
        "lease.acquire.started",
        "lease.acquire.completed",
        "provider.refresh.started",
        "provider.refresh.completed",
        "session.writeback.started",
        "session.writeback.completed",
        "provider.task.started",
        "provider.task.completed",
      ]),
    );
    const serializedEvents = JSON.stringify(observability.events);
    expect(serializedEvents).not.toContain("session-v1-secret");
    expect(serializedEvents).not.toContain("session-v2");
    expect(observability.timings.map((entry) => entry.metric)).toContain(
      "subscription_runtime.provider_refresh_ms",
    );
    expect(observability.counts.map((entry) => entry.metric)).toContain(
      "subscription_runtime.refresh_success",
    );
  });

  it("blocks without reading task output when provider session is missing", async () => {
    const agent = new FakeAgentDriver();
    const runtime = createSubscriptionRuntime(makeFakeRuntimeDeps({ agent }));

    const result = await runtime.refreshThenRunTask({
      providerInstanceId: "missing-instance",
      task: { kind: "review", prompt: "inspect diff" },
      runContext: {
        runId: "run-1",
        attempt: 1,
        abortSignal: new AbortController().signal,
      },
    });

    expect(result).toMatchObject({
      status: "blocked",
      reason: "provider_reconnect_required",
    });
    expect(agent.lastPrompt).toBeNull();
  });

  it("surfaces provider reconnect instead of retrying in a loop", async () => {
    const provider = new FakeProviderSessionDriver();
    provider.refreshedState = "needs-reconnect";
    const store = new InMemorySessionStore();
    store.seed({
      providerInstanceId: "provider-instance-1",
      artifact: makeFakeArtifact("session-v1"),
    });
    const runtime = createSubscriptionRuntime(
      makeFakeRuntimeDeps({ provider, store }),
    );

    const result = await runtime.refreshThenRunTask({
      providerInstanceId: "provider-instance-1",
      task: { kind: "review", prompt: "inspect diff" },
      runContext: {
        runId: "run-1",
        attempt: 1,
        abortSignal: new AbortController().signal,
      },
    });

    expect(result).toMatchObject({
      status: "blocked",
      reason: "provider_reconnect_required",
    });
  });

  it("blocks quota-limited refreshes before writeback or task execution", async () => {
    const provider = new FakeProviderSessionDriver();
    provider.refreshedState = "quota-limited";
    const agent = new FakeAgentDriver();
    const store = new InMemorySessionStore();
    store.seed({
      providerInstanceId: "provider-instance-1",
      artifact: makeFakeArtifact("session-v1"),
    });
    const runtime = createSubscriptionRuntime(
      makeFakeRuntimeDeps({ provider, agent, store }),
    );

    const result = await runtime.refreshThenRunTask({
      providerInstanceId: "provider-instance-1",
      task: { kind: "review", prompt: "inspect diff" },
      runContext: {
        runId: "run-quota",
        attempt: 1,
        abortSignal: new AbortController().signal,
      },
    });

    expect(result).toMatchObject({
      status: "blocked",
      reason: "quota_limited",
    });
    expect(agent.lastPrompt).toBeNull();
    const current = await store.read({
      providerInstanceId: "provider-instance-1",
      expectedProviderId: "fake",
      purpose: "health-check",
    });
    expect(current?.generation).toBe(1);
  });
});

providerSessionDriverContract("fake", () => ({
  driver: new FakeProviderSessionDriver(),
  goodSession: makeFakeArtifact("session-v1"),
  redactor: new DefaultRedactor(),
  reconnectError: new Error("refresh_token=raw-token"),
}));

agentDriverContract("fake", () => ({
  driver: new FakeAgentDriver(),
  goodSession: makeFakeArtifact("session-v1"),
  redactor: new DefaultRedactor(),
}));

sessionStoreContract("memory", () => {
  const providerInstanceId = "provider-instance-contract";
  const store = new InMemorySessionStore();
  return {
    store,
    providerInstanceId,
    currentArtifact: makeFakeArtifact("session-v1"),
    nextArtifact: makeFakeArtifact("session-v2"),
    seed: ({ generation }) => {
      store.seed({
        providerInstanceId,
        artifact: makeFakeArtifact(`session-v${generation}`),
        generation,
      });
    },
  };
});
