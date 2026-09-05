import { describe, expect, it } from "vitest";
import { assertCanaryPhasePostgresResult } from "./hosted-pool-canary-phase-gate.mjs";
import { canaryPhaseFixture } from "./hosted-pool-canary-phase-recovery.fixture";

type Fixture = ReturnType<typeof canaryPhaseFixture>;
async function failedPhase(
  phase: "unauthorized" | "rate_limited" = "unauthorized",
  refreshBackup = false,
) {
  const f = canaryPhaseFixture({ refreshBackup });
  const scope = f.scopeFor(phase);
  await f.prepare(scope);
  await f.stage(scope);
  const observed = f.run(scope.runId, phase);
  return { f, scope, observed };
}

describe("bounded synthetic phase health reconciliation", () => {
  it("counts recorded effects by pool, state and exact dropped grant exclusion", async () => {
    const f = canaryPhaseFixture();
    const scope = f.scopeFor("dropped_response");
    await f.prepare(scope);
    await f.stage(scope);
    const observed = f.run(scope.runId, scope.phase);
    const count = f.prisma.hostedCodexUpstreamEffectAttempt.count;
    const where = { poolId: scope.poolId, state: "terminal_unknown" };
    expect(await count({ where })).toBe(1);
    expect(
      await count({ where: { ...where, grantId: { not: observed.grantId } } }),
    ).toBe(0);
    expect(
      await count({ where: { ...where, grantId: { not: "unrelated" } } }),
    ).toBe(1);
    expect(await count({ where: { ...where, poolId: "other-pool" } })).toBe(0);
    expect(
      await count({
        where: {
          ...where,
          state: { in: ["prepared", "dispatching", "response_started"] },
        },
      }),
    ).toBe(0);
    expect(
      await f.recovery.reconcileCanaryPhase(scope, observed),
    ).toMatchObject({ status: "unchanged" });
    expect(f.restoreCount).toBe(0);
    f.setUncertainEffects(1);
    expect(await count({ where })).toBe(2);
    expect(
      await count({ where: { ...where, grantId: { not: observed.grantId } } }),
    ).toBe(1);
  });

  it.each(["terminal_unknown", "prepared", "dispatching", "response_started"])(
    "holds dropped reconciliation when an unrelated recorded effect is %s",
    async (state) => {
      const f = canaryPhaseFixture();
      f.run(99);
      const scope = f.scopeFor("dropped_response");
      await f.prepare(scope);
      await f.stage(scope);
      const observed = f.run(scope.runId, scope.phase);
      f.grants[0].relayRequests[0].upstreamAttempts[0].state = state;
      const before = structuredClone(f.accounts);
      await expect(
        f.recovery.reconcileCanaryPhase(scope, observed),
      ).rejects.toMatchObject({
        cause: { message: "hosted_pool_canary_phase_pending_effects" },
      });
      expect(f.accounts).toEqual(before);
      expect(f.restoreCount).toBe(0);
      expect(
        f.events.filter((e) => e.action.endsWith("phase_reconciled")),
      ).toHaveLength(0);
    },
  );

  it("bounds preparation, reconciliation and lost-commit observation without repeating writes", async () => {
    const { f, scope, observed } = await failedPhase();
    const options = {
      isolationLevel: "Serializable",
      maxWait: 2_000,
      timeout: 30_000,
    };
    expect(
      f.prisma.$transaction.mock.calls.map((call: unknown[]) => call[1]),
    ).toEqual([options]);
    f.loseCommitResponse();
    await f.recovery.reconcileCanaryPhase(scope, observed);
    expect(
      f.prisma.$transaction.mock.calls.map((call: unknown[]) => call[1]),
    ).toEqual([options, options, options]);
    expect(f.prisma.hostedCodexAccount.updateMany).toHaveBeenCalledTimes(1);
    expect(f.restoreCount).toBe(1);
  });

  it("bounds receipt-only observation after a failed write and does not retry mutation", async () => {
    const { f, scope, observed } = await failedPhase();
    f.failReceipt();
    await expect(
      f.recovery.reconcileCanaryPhase(scope, observed),
    ).rejects.toMatchObject({
      cause: {
        message: "hosted_pool_canary_phase_reconciliation_outcome_unknown",
      },
    });
    expect(
      f.prisma.$transaction.mock.calls.map((call: unknown[]) => call[1]),
    ).toEqual(
      Array.from({ length: 3 }, () => ({
        isolationLevel: "Serializable",
        maxWait: 2_000,
        timeout: 30_000,
      })),
    );
    expect(f.prisma.hostedCodexAccount.updateMany).toHaveBeenCalledTimes(1);
    expect(f.restoreCount).toBe(0);
    expect(
      f.events.filter((e) => e.action.endsWith("phase_reconciled")),
    ).toHaveLength(0);
  });

  it("reproduces the actual 401 -> fresh 429 backup_unavailable without restoration", async () => {
    const { f } = await failedPhase();
    expect(f.accounts[0]!.availability.status).toBe("quarantined");
    f.scopes.set(14, f.scopeFor("rate_limited"));
    expect(() => f.run(14, "rate_limited")).toThrow("backup_unavailable");
    expect(f.restoreCount).toBe(0);
  });

  it("executes both real failover transitions and restores only their exact health increments", async () => {
    const f = canaryPhaseFixture();
    for (const phase of [
      "unauthorized",
      "rate_limited",
      "dropped_response",
    ] as const) {
      const scope = f.scopeFor(phase);
      await f.prepare(scope);
      await f.stage(scope);
      const observed = f.run(scope.runId, phase);
      expect(observed.primaryAccountId).toBe("account-a");
      expect(observed.backupAccountId).toBe("account-b");
      expect(f.accounts[0]!.availability.status).toBe(
        {
          unauthorized: "quarantined",
          rate_limited: "cooldown",
          dropped_response: "healthy",
        }[phase],
      );
      const result = await f.recovery.reconcileCanaryPhase(scope, observed);
      expect(result.status).toBe(
        phase === "dropped_response" ? "unchanged" : "restored",
      );
      expect(f.accounts.map((a) => a.availability.status)).toEqual([
        "healthy",
        "healthy",
      ]);
    }
    expect(f.accounts.map((a) => a.healthVersion)).toEqual([5, 1]);
    expect(f.restoreCount).toBe(2);
    expect(f.grants.map((g) => g.failoverCount)).toEqual([1, 1, 0]);
    expect(
      f.grants.map((g) => g.relayRequests[0].upstreamAttempts.length),
    ).toEqual([2, 2, 1]);
  });

  it.each(["unauthorized", "rate_limited"] as const)(
    "recognizes a lost %s commit response and replay without repeating health effects",
    async (phase) => {
      const { f, scope, observed } = await failedPhase(phase);
      f.loseCommitResponse();
      const receipt = await f.recovery.reconcileCanaryPhase(scope, observed);
      expect(await f.recovery.reconcileCanaryPhase(scope, observed)).toEqual(
        receipt,
      );
      expect(f.restoreCount).toBe(1);
      expect(f.accounts[0]!.healthVersion).toBe(3);
      expect(
        f.events.filter((e) => e.action.endsWith("phase_reconciled")),
      ).toHaveLength(1);
      f.changeAccount(0, {
        availability: { status: "quarantined", reason: "real_401" },
        healthVersion: 4,
      });
      await expect(
        f.recovery.reconcileCanaryPhase(scope, observed),
      ).rejects.toThrow("recovery_hold");
      expect(f.accounts[0]!.availability.status).toBe("quarantined");
      expect(f.restoreCount).toBe(1);
    },
  );

  it.each(["unauthorized", "rate_limited"] as const)(
    "proves backup writeback during %s and replays a lost restoration response without writing B",
    async (phase) => {
      const { f, scope, observed } = await failedPhase(phase, true);
      const backup = structuredClone(f.accounts[1]);
      expect(observed.attempts.map((a) => a.credentialGeneration)).toEqual([
        "1",
        "2",
      ]);
      f.loseCommitResponse();
      const receipt = await f.recovery.reconcileCanaryPhase(scope, observed);
      expect(await f.recovery.reconcileCanaryPhase(scope, observed)).toEqual(
        receipt,
      );
      expect(f.accounts[1]).toEqual(backup);
      expect(f.restoreCount).toBe(1);
      expect(
        f.prisma.hostedCodexAccount.updateMany.mock.calls.map(
          ([input]: any) => input.where.id,
        ),
      ).toEqual(["account-a"]);
    },
  );

  it("walks every persisted backup writeback from preparation through the successful effect", async () => {
    const f = canaryPhaseFixture({ refreshBackup: true });
    const scope = f.scopeFor("unauthorized");
    await f.prepare(scope);
    await f.stage(scope);
    f.refreshBackup("account-b", f.now());
    const observed = f.run(scope.runId, scope.phase);
    expect(observed.attempts[1]!.credentialGeneration).toBe("3");
    expect(
      (await f.recovery.reconcileCanaryPhase(scope, observed)).status,
    ).toBe("restored");
    expect(f.accounts[1]!.healthVersion).toBe(3);
  });

  const refreshRefusals: Array<[string, (f: Fixture) => void]> = [
    [
      "missing activation",
      (f) => {
        f.credentialRows.at(-1).generationReceipts = [];
      },
    ],
    [
      "unrelated predecessor",
      (f) => {
        f.credentialRows.at(-1).generationReceipts[0].previousReceiptHash =
          "0".repeat(64);
      },
    ],
    [
      "missing generation in chain",
      (f) => {
        f.credentialRows.at(-1).accountId = "unrelated";
      },
    ],
    [
      "missing refresh envelope",
      (f) => {
        f.credentialRows.at(-1).envelopeRevisions = [];
      },
    ],
    [
      "restored envelope",
      (f) => {
        f.credentialRows.at(-1).envelopeRevisions[0].reason = "restore";
      },
    ],
    [
      "newer envelope revision",
      (f) => {
        f.credentialRows.at(-1).envelopeRevisions[0].revision = 2n;
      },
    ],
    [
      "unrelated fence",
      (f) => {
        f.credentialRows.at(-1).envelopeRevisions[0].fenceEpoch = 9n;
      },
    ],
    [
      "unrelated writeback owner",
      (f) => {
        f.credentialRows.at(-1).envelopeRevisions[0].fenceOwnerIdHash =
          "0".repeat(64);
      },
    ],
    [
      "broken writeback hash",
      (f) => {
        f.credentialRows.at(-1).envelopeRevisions[0].idempotencyKeyHash =
          "0".repeat(64);
      },
    ],
    [
      "unrelated incarnation",
      (f) => {
        f.credentialRows.at(-1).databaseIncarnation = "other";
      },
    ],
    [
      "receipt after successful effect",
      (f) => {
        f.credentialRows.at(-1).generationReceipts[0].occurredAt = f.now();
      },
    ],
    [
      "receipt before preparation",
      (f) => {
        f.credentialRows.at(-1).generationReceipts[0].occurredAt = new Date(0);
      },
    ],
    [
      "independent backup health change",
      (f) => f.changeAccount(1, { healthVersion: 4 }),
    ],
    [
      "independent backup failure",
      (f) =>
        f.changeAccount(1, {
          availability: { status: "quarantined", reason: "real_401" },
          healthVersion: 3,
        }),
    ],
    [
      "later valid backup writeback",
      (f) => f.refreshBackup("account-b", f.now()),
    ],
    ["refreshed primary", (f) => f.refreshBackup("account-a", f.now())],
    [
      "independent primary failure",
      (f) => f.changeAccount(0, { healthVersion: 3 }),
    ],
    [
      "unknown backup effect",
      (f) => {
        f.grants[0].relayRequests[0].upstreamAttempts[1].state =
          "terminal_unknown";
      },
    ],
    ["unrelated unknown effect", (f) => f.setUncertainEffects(1)],
  ];
  it.each(refreshRefusals)(
    "holds a refreshed backup for %s",
    async (_name, mutate) => {
      const { f, scope, observed } = await failedPhase("unauthorized", true);
      mutate(f);
      const before = structuredClone(f.accounts);
      await expect(
        f.recovery.reconcileCanaryPhase(scope, observed),
      ).rejects.toThrow("recovery_hold");
      expect(f.accounts).toEqual(before);
      expect(f.restoreCount).toBe(0);
    },
  );

  it("requires the preparation's activation anchor for backup refresh", async () => {
    const f = canaryPhaseFixture({ refreshBackup: true });
    const scope = f.scopeFor("unauthorized");
    // Absence at preparation cannot be repaired retroactively by a later row.
    const activation = f.credentialRows[1].generationReceipts.pop();
    await f.prepare(scope);
    f.credentialRows[1].generationReceipts.push(activation);
    await f.stage(scope);
    const observed = f.run(scope.runId, scope.phase);
    await expect(
      f.recovery.reconcileCanaryPhase(scope, observed),
    ).rejects.toThrow("recovery_hold");
    expect(f.restoreCount).toBe(0);
  });

  const refusals: Array<[string, (f: Fixture) => void]> = [
    ["health drift", (f) => f.changeAccount(0, { healthVersion: 3 })],
    [
      "generation drift",
      (f) =>
        f.changeAccount(0, {
          credential: { ...f.accounts[0]!.credential, authGeneration: 2 },
        }),
    ],
    [
      "wrong attempt generation",
      (f) => {
        f.grants[0].relayRequests[0].upstreamAttempts[0].credentialGeneration =
          2n;
      },
    ],
    [
      "expired credential",
      (f) =>
        f.changeAccount(0, {
          credential: { ...f.accounts[0]!.credential, expiresAt: f.now() },
        }),
    ],
    [
      "expired grant",
      (f) => {
        f.grants[0].expiresAt = f.now();
      },
    ],
    [
      "expiry quarantine",
      (f) =>
        f.changeAccount(0, {
          availability: { status: "quarantined", reason: "expiry" },
          healthVersion: 3,
        }),
    ],
    ["restore quarantine", (f) => f.setRestoreItems(1)],
    [
      "paused account",
      (f) =>
        f.changeAccount(0, {
          availability: { status: "paused", reason: "operator" },
        }),
    ],
    [
      "backup genuine failure",
      (f) =>
        f.changeAccount(1, {
          availability: { status: "quarantined", reason: "real_401" },
          healthVersion: 2,
        }),
    ],
    [
      "real non-synthetic failure",
      (f) => {
        f.events.splice(
          f.events.findIndex((e) => e.action.endsWith("plan_consumed")),
          1,
        );
      },
    ],
    [
      "real provider response",
      (f) => {
        f.grants[0].relayRequests[0].upstreamAttempts[0].dispatchStartedAt =
          f.now();
      },
    ],
    [
      "unproved effect hash",
      (f) => {
        f.grants[0].relayRequests[0].upstreamAttempts[0].terminalEvidenceHash =
          "0".repeat(64);
      },
    ],
    [
      "wrong phase",
      (f) => {
        f.events.at(-1).metadata.phase = "synthetic_rate_limited";
      },
    ],
    [
      "wrong run",
      (f) => {
        f.events.at(-1).metadata.runId = "99";
      },
    ],
    [
      "wrong run attempt",
      (f) => {
        f.events.at(-1).metadata.runAttempt = 3;
      },
    ],
    [
      "wrong binding",
      (f) => {
        f.events.at(-1).metadata.bindingId = "other-binding";
      },
    ],
    [
      "wrong binding revision",
      (f) => {
        f.events.at(-1).metadata.bindingRevision = "2";
      },
    ],
    [
      "wrong Action",
      (f) => {
        f.events.at(-1).metadata.actionRef =
          `777genius/review-router@${"b".repeat(40)}`;
      },
    ],
    [
      "binding lifecycle drift",
      (f) => {
        f.binding.stateVersion = 2n;
      },
    ],
    [
      "duplicate consumption",
      (f) => {
        f.events.push({ ...f.events.at(-1), id: "duplicate" });
      },
    ],
    [
      "duplicate grant",
      (f) => {
        f.grants.push({ ...f.grants[0], id: "duplicate" });
      },
    ],
    [
      "duplicate effect",
      (f) => {
        f.grants[0].relayRequests[0].upstreamAttempts.push(
          f.grants[0].relayRequests[0].upstreamAttempts[1],
        );
      },
    ],
    [
      "unknown backup outcome",
      (f) => {
        f.grants[0].relayRequests[0].upstreamAttempts[1].state =
          "terminal_unknown";
      },
    ],
    ["other unknown provider effect", (f) => f.setUncertainEffects(1)],
    [
      "canceled plan",
      (f) => {
        f.events.push({
          ...f.events.at(-1),
          action: "hosted_codex_canary_fault_plan_canceled",
          id: "canceled",
        });
      },
    ],
    ["CAS conflict", (f) => f.failCas()],
    ["receipt insert rollback", (f) => f.failReceipt()],
  ];
  it.each(refusals)(
    "holds without restoration for %s",
    async (_name, mutate) => {
      const { f, scope, observed } = await failedPhase();
      mutate(f);
      const before = structuredClone(f.accounts);
      await expect(
        f.recovery.reconcileCanaryPhase(scope, observed),
      ).rejects.toThrow("recovery_hold");
      expect(f.accounts).toEqual(before);
      expect(f.restoreCount).toBe(0);
      expect(
        f.events.filter((e) => e.action.endsWith("phase_reconciled")),
      ).toHaveLength(0);
    },
  );

  it("does not infer a completed recovery from healthy state without its receipt", async () => {
    const { f, scope, observed } = await failedPhase();
    f.changeAccount(0, {
      availability: { status: "healthy" },
      healthVersion: 3,
    });
    await expect(
      f.recovery.reconcileCanaryPhase(scope, observed),
    ).rejects.toThrow("recovery_hold");
    expect(f.restoreCount).toBe(0);
  });

  it("cannot prepare twice or prepare an unhealthy dedicated pool", async () => {
    const { f, scope } = await failedPhase();
    await expect(f.prepare(scope)).rejects.toThrow("already_prepared");
    await expect(f.prepare(f.scopeFor("rate_limited"))).rejects.toThrow(
      "pool_not_healthy",
    );
  });

  it("refuses preparation after dispatch even without a preparation receipt", async () => {
    const f = canaryPhaseFixture();
    const scope = f.scopeFor("unauthorized");
    f.run(scope.runId);
    await expect(f.prepare(scope)).rejects.toThrow("run_already_dispatched");
    expect(f.events).toHaveLength(0);
    expect(f.restoreCount).toBe(0);
  });

  it("refuses reconciliation against a different prepared scope", async () => {
    const { f, scope, observed } = await failedPhase();
    await expect(
      f.recovery.reconcileCanaryPhase(
        { ...scope, runId: scope.runId + 1 },
        observed,
      ),
    ).rejects.toMatchObject({
      cause: { message: "hosted_pool_canary_phase_preparation_scope_mismatch" },
    });
    expect(f.restoreCount).toBe(0);
    expect(
      f.events.filter((e) => e.action.endsWith("phase_reconciled")),
    ).toHaveLength(0);
  });

  it("requires the effect generation to equal the durable preparation even when observation agrees", async () => {
    const { f, scope, observed } = await failedPhase();
    f.grants[0].relayRequests[0].upstreamAttempts[0].credentialGeneration = 2n;
    const wrongGeneration = {
      ...observed,
      attempts: observed.attempts.map((a, i) =>
        i === 0 ? { ...a, credentialGeneration: "2" } : a,
      ),
    };
    await expect(
      f.recovery.reconcileCanaryPhase(scope, wrongGeneration),
    ).rejects.toThrow("recovery_hold");
    expect(f.restoreCount).toBe(0);
  });

  it("binds the durable receipt to exact health versions and refuses receipt tampering", async () => {
    const { f, scope, observed } = await failedPhase();
    const result = await f.recovery.reconcileCanaryPhase(scope, observed);
    const receipt = f.events.find((e) => e.id === result.receiptId);
    expect(receipt.metadata).toMatchObject({
      accountId: "account-a",
      credentialGeneration: "1",
      preparedHealthVersion: "1",
      dispositionHealthVersion: "2",
      reconciledHealthVersion: "3",
    });
    receipt.metadata.proofHash = "0".repeat(64);
    await expect(
      f.recovery.reconcileCanaryPhase(scope, observed),
    ).rejects.toThrow("recovery_hold");
    expect(f.restoreCount).toBe(1);
  });

  it("refuses a different cooldown despite the expected version", async () => {
    const { f, scope, observed } = await failedPhase("rate_limited");
    f.changeAccount(0, {
      availability: {
        status: "cooldown",
        reason: "real_quota",
        until: new Date(f.now().getTime() + 3_600_000),
      },
    });
    await expect(
      f.recovery.reconcileCanaryPhase(scope, observed),
    ).rejects.toThrow("recovery_hold");
    expect(f.restoreCount).toBe(0);
  });
});

describe("required canary PostgreSQL gate", () => {
  const passing = () => ({
    success: true,
    numTotalTests: 1,
    numPassedTests: 1,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    testResults: [
      {
        name: "/repo/scripts/hosted-pool-canary-phase-recovery.postgres.test.ts",
        status: "passed",
        assertionResults: [
          {
            title:
              "runs authenticated 401 -> backup credential writeback -> 429 -> dropped persistence, recovers a lost commit, and preserves a newer real failure",
            status: "passed",
          },
        ],
      },
    ],
  });
  it("accepts an executed passing regression", () => {
    expect(() => assertCanaryPhasePostgresResult(passing())).not.toThrow();
  });
  it.each(["pending", "skipped", "todo", "failed"])(
    "rejects a green process with a %s regression",
    (status) => {
      const report = passing();
      report.testResults[0]!.assertionResults[0]!.status = status;
      expect(() => assertCanaryPhasePostgresResult(report)).toThrow(
        "required_regression_not_passed",
      );
    },
  );
  it.each([
    "missing suite",
    "missing test",
    "other suite",
    "other test",
    "inconsistent totals",
    "failed report",
    "failed suite",
    "duplicate suite",
    "failed total",
    "pending total",
    "todo total",
  ])("rejects %s", (missing) => {
    const report = passing();
    if (missing === "missing suite") report.testResults = [];
    if (missing === "missing test")
      report.testResults[0]!.assertionResults = [];
    if (missing === "other suite")
      report.testResults[0]!.name = "/repo/scripts/other.postgres.test.ts";
    if (missing === "other test")
      report.testResults[0]!.assertionResults[0]!.title = "unrelated test";
    if (missing === "inconsistent totals") report.numPassedTests = 0;
    if (missing === "failed report") report.success = false;
    if (missing === "failed suite") report.testResults[0]!.status = "failed";
    if (missing === "duplicate suite")
      report.testResults.push(report.testResults[0]!);
    if (missing === "failed total") report.numFailedTests = 1;
    if (missing === "pending total") report.numPendingTests = 1;
    if (missing === "todo total") report.numTodoTests = 1;
    expect(() => assertCanaryPhasePostgresResult(report)).toThrow(
      "required_regression_not_passed",
    );
  });
});
