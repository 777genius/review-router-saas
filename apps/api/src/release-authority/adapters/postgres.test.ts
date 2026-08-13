import { describe, expect, it } from "vitest";
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  RoutineReleaseControlLedgerAdapter,
  RoutineRunnerCleanupWitnessAdapter,
} from "./postgres";

const dangerous = `quote ' "; DROP TABLE release_authority.rollout; --`;
const zeroReceipt = `sha256:${"0".repeat(64)}`;
const nextReceipt = `sha256:${"1".repeat(64)}`;
const observedAt = "2026-08-12T00:00:00.000Z";

class QueryRecorder {
  readonly queries: Prisma.Sql[] = [];

  async $queryRaw<T>(query: Prisma.Sql): Promise<T> {
    this.queries.push(query);
    const text = query.text;
    const value = text.includes("authorize_activation")
      ? {
          rolloutId: "rollout",
          expectedCommitSha: "a".repeat(40),
          postgresMajor: 17,
          migrationChecksum: `sha256:${"7".repeat(64)}`,
          epoch: 1,
          nonce: "a".repeat(32),
          sourceSystemIdentifier: "100",
          targetSystemIdentifier: "200",
          previousReceiptSha256: zeroReceipt,
          targetDeployIds: [dangerous],
          authorizedAt: observedAt,
        }
      : text.includes("release_provider_authority_decide")
        ? {
            decision: "allow",
            decisionId: "decision",
            decidedAt: observedAt,
          }
        : text.includes("release_runner_terminal_cleanup_fact")
          ? {
              jobId: "job",
              lifecycle: "role",
              canary: "canary",
              terminalAt: observedAt,
              observation: { step: "cleanup_role_runner" },
              witness: { canary: "canary", providerStatus: "succeeded" },
            }
          : text.includes("release_runner_prepare_effect")
            ? {
                state: "prepared",
                ownerId: "rrc-00000000-0000-4000-8000-000000000001",
                epoch: 0,
                providerId: null,
                safeForCompensation: false,
              }
            : text.includes("release_runner_acquire_dispatch_permit")
              ? {
                  state: "dispatching",
                  ownerId: "rrc-00000000-0000-4000-8000-000000000001",
                  epoch: 1,
                  providerId: null,
                  safeForCompensation: false,
                }
              : text.includes("release_runner_abandon_prepared")
                ? {
                    state: "abandoned",
                    ownerId: "rrc-00000000-0000-4000-8000-000000000001",
                    epoch: 0,
                    providerId: null,
                    safeForCompensation: true,
                  }
                : text.includes("release_runner_reconcile_effect")
                  ? {
                      state: "bound",
                      ownerId: "rrc-00000000-0000-4000-8000-000000000001",
                      epoch: 1,
                      providerId: "job",
                      safeForCompensation: false,
                    }
                  : true;
    return [{ value }] as T;
  }
}

const expectJsonbBinding = (query: Prisma.Sql, expected: unknown): void => {
  const serialized = JSON.stringify(expected);
  const indexes = query.values.flatMap((value, index) =>
    value === serialized ? [index] : [],
  );
  expect(indexes.length).toBeGreaterThan(0);
  for (const index of indexes)
    expect(query.strings[index + 1]?.startsWith("::jsonb")).toBe(true);
  expect(query.strings.join("")).not.toContain(dangerous);
  const firstIndex = indexes[0];
  if (firstIndex === undefined) throw new Error("jsonb_parameter_missing");
  expect(JSON.parse(String(query.values[firstIndex]))).toEqual(expected);
};

describe("release authority postgres JSONB bindings", () => {
  it("serializes prepared, dispatching, bound, and cleaned list results with owner retention", async () => {
    const ownerId = "rrc-00000000-0000-4000-8000-000000000001";
    const base = {
      rolloutId: "rollout",
      serviceId: "service",
      lifecycle: "role",
      workflowJobId: "123",
      runnerName: "runner",
      createdAt: observedAt,
      startCommandSha256: `sha256:${"b".repeat(64)}`,
      creationLeaseOwner: ownerId,
    };
    const intents = [
      {
        ...base,
        id: `rri-${"1".repeat(64)}`,
        creationLeaseExpiresAt: "2026-08-12T00:02:00.000Z",
        effect: {
          state: "prepared",
          ownerId,
          epoch: 0,
          providerId: null,
          safeForCompensation: false,
        },
      },
      ...(["dispatching", "bound", "cleaned"] as const).map((state, index) => ({
        ...base,
        id: `rri-${String(index + 2).repeat(64)}`,
        creationLeaseExpiresAt: null,
        effect: {
          state,
          ownerId,
          epoch: 1,
          providerId: state === "dispatching" ? null : `job-${index}`,
          safeForCompensation: state === "cleaned",
        },
      })),
    ];
    const prisma = {
      $queryRaw: async () => [{ value: intents }],
    } as unknown as PrismaClient;
    const adapter = new RoutineReleaseControlLedgerAdapter(prisma);

    await expect(adapter.listIntents("rollout")).resolves.toEqual(intents);
  });

  it("rejects a list result whose expiry contradicts the canonical effect state", async () => {
    const ownerId = "rrc-00000000-0000-4000-8000-000000000001";
    const prisma = {
      $queryRaw: async () => [
        {
          value: [
            {
              id: `rri-${"1".repeat(64)}`,
              rolloutId: "rollout",
              serviceId: "service",
              lifecycle: "role",
              workflowJobId: "123",
              runnerName: "runner",
              createdAt: observedAt,
              startCommandSha256: `sha256:${"b".repeat(64)}`,
              creationLeaseOwner: ownerId,
              creationLeaseExpiresAt: "2026-08-12T00:02:00.000Z",
              effect: {
                state: "dispatching",
                ownerId,
                epoch: 1,
                providerId: null,
                safeForCompensation: false,
              },
            },
          ],
        },
      ],
    } as unknown as PrismaClient;
    const adapter = new RoutineReleaseControlLedgerAdapter(prisma);

    await expect(adapter.listIntents("rollout")).rejects.toThrow(
      "release_runner_intents_invalid",
    );
  });

  it("maps only known authority SQL conflicts to HTTP 409", async () => {
    const conflict = Object.assign(new Error("raw query failed"), {
      code: "P2010",
      meta: {
        code: "P0001",
        message: "provider authority replay conflict",
      },
    });
    const prisma = {
      $queryRaw: async () => {
        throw conflict;
      },
    } as unknown as PrismaClient;
    const adapter = new RoutineReleaseControlLedgerAdapter(prisma);

    await expect(
      adapter.decideProviderOperation({
        rolloutId: "rollout",
        operation: "deploy_target",
        sourceSystemIdentifier: "100",
        targetSystemIdentifier: "200",
        expectedReceiptSha256: zeroReceipt,
        activationBoundary: "before",
      }),
    ).rejects.toMatchObject({
      message: "release_authority_conflict",
      statusCode: 409,
    });

    conflict.meta.message = "unexpected authority failure";
    await expect(
      adapter.claim({
        rolloutId: "rollout",
        expectedCommitSha: "a".repeat(40),
        runId: "1",
        runAttempt: 1,
        sourceSystemIdentifier: "100",
        targetSystemIdentifier: "200",
      }),
    ).rejects.toBe(conflict);
  });

  it("binds serialized JSON text and casts every routine JSON argument", async () => {
    const recorder = new QueryRecorder();
    const prisma = recorder as unknown as PrismaClient;
    const adapter = new RoutineReleaseControlLedgerAdapter(prisma);
    const witnessAdapter = new RoutineRunnerCleanupWitnessAdapter(prisma);
    const binding = {
      rolloutId: "rollout",
      expectedCommitSha: "a".repeat(40),
      runId: "1",
      runAttempt: 1,
      sourceSystemIdentifier: "100",
      targetSystemIdentifier: "200",
    } as const;
    const provider = { deployId: dangerous };
    const authorization = {
      rolloutId: "rollout",
      epoch: 1,
      nonce: "a".repeat(32),
      sourceSystemIdentifier: "100",
      targetSystemIdentifier: "200",
      previousReceiptSha256: zeroReceipt,
      targetDeployIds: [dangerous],
      postgresMajor: 17,
      migrationChecksum: `sha256:${"7".repeat(64)}`,
      authorizedAt: observedAt,
    };
    const activationReceipt = {
      permitEpoch: 1,
      permitNonce: "a".repeat(32),
      evidence: dangerous,
    };

    await adapter.compareAndSet({
      ...binding,
      step: "stage_target_services",
      provider,
      expectedReceiptSha256: zeroReceipt,
      nextReceiptSha256: nextReceipt,
      authoritativeSystemIdentifier: "100",
      expectedActivationBoundary: "before",
      nextActivationBoundary: "before",
    });
    expectJsonbBinding(recorder.queries.at(-1)!, provider);

    await adapter.authorizeActivation({
      ...binding,
      jobId: "9",
      previousReceiptSha256: zeroReceipt,
      targetDeployIds: [dangerous],
      postgresMajor: 17,
      migrationChecksum: `sha256:${"7".repeat(64)}`,
    });
    expectJsonbBinding(recorder.queries.at(-1)!, [dangerous]);

    await adapter.finalizeActivation({
      authorization,
      provider,
      nextReceiptSha256: nextReceipt,
      activationReceipt,
    } as never);
    expectJsonbBinding(recorder.queries.at(-1)!, authorization);
    expectJsonbBinding(recorder.queries.at(-1)!, provider);
    expectJsonbBinding(recorder.queries.at(-1)!, activationReceipt);

    await adapter.verifyFinalAuthority({
      ...binding,
      expectedReceiptSha256: nextReceipt,
      activationReceipt,
    } as never);
    expectJsonbBinding(recorder.queries.at(-1)!, activationReceipt);

    const decision = {
      rolloutId: "rollout",
      operation: "deploy_target",
      sourceSystemIdentifier: "100",
      targetSystemIdentifier: "200",
      expectedReceiptSha256: zeroReceipt,
      activationBoundary: "before",
      note: dangerous,
    };
    await adapter.decideProviderOperation(decision as never);
    expectJsonbBinding(recorder.queries.at(-1)!, decision);

    const intent = {
      id: `rri-${"b".repeat(64)}`,
      rolloutId: "rollout",
      serviceId: dangerous,
      lifecycle: "role",
      workflowJobId: "10",
      runnerName: "runner",
      createdAt: observedAt,
      startCommandSha256: `sha256:${"b".repeat(64)}`,
      creationLeaseOwner: "rrc-00000000-0000-4000-8000-000000000001",
    } as const;
    await expect(
      adapter.persistProvisioningIntent(intent),
    ).resolves.toMatchObject({
      state: "prepared",
      epoch: 0,
    });
    expectJsonbBinding(recorder.queries.at(-1)!, intent);

    const dispatchPermit = {
      intentId: intent.id,
      claimantId: "rrc-00000000-0000-4000-8000-000000000001",
      startCommandSha256: `sha256:${"b".repeat(64)}`,
      expectedEpoch: 0,
      leaseSeconds: 120,
    } as const;
    await expect(
      adapter.acquireProviderDispatchPermit(dispatchPermit),
    ).resolves.toMatchObject({ state: "dispatching", epoch: 1 });
    expectJsonbBinding(recorder.queries.at(-1)!, dispatchPermit);

    const reconciliation = {
      intentId: intent.id,
      claimantId: dispatchPermit.claimantId,
      expectedEpoch: 1,
      jobId: "job",
      reconciliation: { result: "pending", safeForCompensation: false },
    } as const;
    await expect(
      adapter.reconcileProvisioningEffect(reconciliation),
    ).resolves.toMatchObject({ state: "bound", providerId: "job" });
    expectJsonbBinding(recorder.queries.at(-1)!, reconciliation);

    const abandon = {
      intentId: intent.id,
      claimantId: dispatchPermit.claimantId,
      expectedEpoch: 0,
    } as const;
    await expect(adapter.abandonPreparedEffect(abandon)).resolves.toMatchObject(
      {
        state: "abandoned",
        safeForCompensation: true,
      },
    );
    const abandonQuery = recorder.queries.at(-1)!;
    expect(abandonQuery.text).toContain("release_runner_abandon_prepared");
    expect(abandonQuery.values).toEqual([
      abandon.intentId,
      abandon.claimantId,
      abandon.expectedEpoch,
    ]);

    const job = {
      rolloutId: "rollout",
      serviceId: dangerous,
      jobId: "job",
      observedAt,
      cleanupCanary: "canary",
      lifecycle: "role",
      provisioningIntentId: intent.id,
    } as const;
    await adapter.persistJob(job);
    expectJsonbBinding(recorder.queries.at(-1)!, job);

    const identity = { providerJobId: dangerous };
    const observation = { step: "cleanup", facts: { note: dangerous } };
    await adapter.persistIdentity(
      "job",
      identity as never,
      observation as never,
    );
    expectJsonbBinding(recorder.queries.at(-1)!, identity);
    expectJsonbBinding(recorder.queries.at(-1)!, observation);

    await adapter.markTerminal("job", observation as never);
    expectJsonbBinding(recorder.queries.at(-1)!, observation);

    await adapter.terminalCleanupFact("rollout", "role");
    expect(recorder.queries.at(-1)!.text).toContain(
      "release_runner_terminal_cleanup_fact",
    );

    const witness = {
      jobId: "job",
      canary: "canary",
      providerStatus: "succeeded",
      containerTerminated: true,
      logSha256: `sha256:${"c".repeat(64)}`,
      removedPaths: [`/runner/_work/rr-safe/${dangerous}`],
      remainingPaths: [],
      providerLogId: "log",
      providerObservedAt: observedAt,
    } as const;
    await witnessAdapter.persistProviderWitness("job", witness as never);
    expectJsonbBinding(recorder.queries.at(-1)!, witness);

    const routineNames = recorder.queries.map((query) => query.text).join("\n");
    expect(routineNames).not.toContain("release_runner_persist_intent");
    expect(routineNames).not.toContain(
      "release_runner_claim_provider_creation",
    );
    expect(routineNames).not.toContain("release_runner_record_intent_outcome");
  });

  it("rejects malformed external-effect routine results", async () => {
    const prisma = {
      $queryRaw: async () => [
        {
          value: {
            state: "dispatching",
            ownerId: "rrc-00000000-0000-4000-8000-000000000001",
            epoch: 0,
            providerId: null,
            safeForCompensation: false,
          },
        },
      ],
    } as unknown as PrismaClient;
    const adapter = new RoutineReleaseControlLedgerAdapter(prisma);
    await expect(
      adapter.persistProvisioningIntent({} as never),
    ).rejects.toThrow(/external_effect_/u);
  });
});
