import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPrismaClient } from "../packages/platform/db/src/index.js";
import {
  hostedCodexCanaryFaultPlanMaxLifetimeMs,
  hostedCodexCanaryFaultPlanTokenMaxBytes,
} from "../packages/features/hosted-account-pool/src/application/ports/hosted-codex-canary-fault-plan-port.js";
import { reconcileExpiredInvocationGrants } from "../packages/features/hosted-account-pool/src/application/use-cases/reconcile-expired-invocation-grants.js";
import { PrismaInvocationGrantRepository } from "../packages/features/hosted-account-pool/src/infrastructure/prisma/prisma-invocation-grant-repository.js";

export const hostedPoolFlagNames = Object.freeze([
  "REVIEW_ROUTER_ENABLE_HOSTED_CODEX_POOL",
  "REVIEW_ROUTER_ENABLE_HOSTED_CODEX_CUSTODY",
  "REVIEW_ROUTER_ENABLE_HOSTED_CODEX_ADMISSION",
  "REVIEW_ROUTER_ENABLE_HOSTED_CODEX_RELAY",
  "REVIEW_ROUTER_ENABLE_HOSTED_CODEX_FAILOVER",
] as const);

export type HostedPoolFlagName = (typeof hostedPoolFlagNames)[number];
export type HostedPoolFlagPatch = Partial<
  Record<HostedPoolFlagName, "0" | "1">
>;
export type HostedPoolCounts = Readonly<{
  inFlight: number;
  issuedGrants: number;
  unresolvedRequests: number;
  terminalUnknownRequests: number;
  unresolvedMintAttempts?: number;
}>;
export type HostedPoolRuntimeGate = Readonly<{
  status: "closed" | "active";
  authzEpoch: string;
  revision: string;
  reasonCode: string;
  changedAt: string;
  changedByHash: string;
}>;
export type HostedPoolControlPort = Readonly<{
  readFlags(): Promise<Record<string, Record<HostedPoolFlagName, string>>>;
  setFlags(patch: HostedPoolFlagPatch): Promise<void>;
  readRuntimeGate(): Promise<HostedPoolRuntimeGate>;
  transitionRuntimeGate(input: {
    readonly expectedRevision: string;
    readonly status: "closed" | "active";
    readonly reasonCode: string;
    readonly changedAt: Date;
    readonly changedByHash: string;
  }): Promise<HostedPoolRuntimeGate>;
  ensureRuntimeClosure?(
    gate: HostedPoolRuntimeGate,
    reasonCode: string,
    changedByHash: string,
  ): Promise<void>;
  acknowledgeLegacyIssuerDrain?(gate: HostedPoolRuntimeGate): Promise<void>;
  assertRuntimeClosureComplete?(gate: HostedPoolRuntimeGate): Promise<void>;
  completeRuntimeClosure?(gate: HostedPoolRuntimeGate): Promise<void>;
  readRuntimeClosure?(gate: HostedPoolRuntimeGate): Promise<Readonly<{
    state: "draining" | "complete";
    legacyBarrier: boolean;
    legacyUnsafeUntil: Date;
  }> | null>;
  reconcileExpiredGrants(): Promise<
    Readonly<{ expiredCount: number; batches: number }>
  >;
  counts(): Promise<HostedPoolCounts>;
  setFaultPlan?(token: string | null): Promise<void>;
}>;

export class HostedPoolRollbackError extends AggregateError {
  constructor(
    failures: readonly unknown[],
    readonly rollbackEvidence: ReturnType<typeof evidence>,
  ) {
    super(failures, "hosted_pool_rollback_aggregate_failure");
  }
}

export async function executeHostedPoolControl(input: {
  readonly command:
    | "status"
    | "activate"
    | "kill-switch"
    | "drain"
    | "rollback";
  readonly execute: boolean;
  readonly confirmation?: string;
  readonly port: HostedPoolControlPort;
  readonly now?: () => Date;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly maxDrainPolls?: number;
  readonly operationId?: string;
}) {
  const now = input.now ?? (() => new Date());
  const operationId = input.operationId ?? randomUUID();
  const operatorHash = createHash("sha256").update(operationId).digest("hex");
  const events: Array<Record<string, unknown>> = [];
  const observe = async (phase: string) => {
    const [flags, runtimeGate, counts] = await Promise.all([
      input.port.readFlags(),
      input.port.readRuntimeGate(),
      input.port.counts(),
    ]);
    validateObservedFlags(
      flags,
      input.execute && input.command !== "status",
      input.execute && input.command === "rollback",
    );
    assertRuntimeGate(runtimeGate);
    const event = {
      phase,
      at: now().toISOString(),
      operationId,
      flags,
      runtimeGate,
      counts,
    };
    events.push(event);
    return event;
  };
  await observe("initial");
  if (input.command === "status" || !input.execute) {
    return evidence(
      input.command,
      input.execute ? "observed" : "dry_run",
      events,
    );
  }
  if (
    input.confirmation !== `EXECUTE HOSTED POOL ${input.command.toUpperCase()}`
  )
    throw new Error("hosted_pool_control_confirmation_required");

  if (input.command === "activate") {
    const closed = await input.port.readRuntimeGate();
    assertRuntimeGate(closed);
    if (closed.status !== "closed")
      throw new Error(
        "hosted_pool_runtime_gate_must_be_closed_before_activation",
      );
    await input.port.assertRuntimeClosureComplete?.(closed);
    await input.port.setFlags({
      REVIEW_ROUTER_ENABLE_HOSTED_CODEX_POOL: "1",
      REVIEW_ROUTER_ENABLE_HOSTED_CODEX_CUSTODY: "1",
      REVIEW_ROUTER_ENABLE_HOSTED_CODEX_RELAY: "1",
      REVIEW_ROUTER_ENABLE_HOSTED_CODEX_FAILOVER: "1",
    });
    const runtimeActivated = await observe("runtime_activated");
    assertObservedPatch(runtimeActivated, {
      REVIEW_ROUTER_ENABLE_HOSTED_CODEX_POOL: "1",
      REVIEW_ROUTER_ENABLE_HOSTED_CODEX_CUSTODY: "1",
      REVIEW_ROUTER_ENABLE_HOSTED_CODEX_RELAY: "1",
      REVIEW_ROUTER_ENABLE_HOSTED_CODEX_FAILOVER: "1",
    });
    assertObservedRuntimeGate(runtimeActivated, "closed");
    await input.port.setFlags({
      REVIEW_ROUTER_ENABLE_HOSTED_CODEX_ADMISSION: "1",
    });
    const admissionActivated = await observe("admission_activated_while_gated");
    assertObservedPatch(admissionActivated, {
      REVIEW_ROUTER_ENABLE_HOSTED_CODEX_ADMISSION: "1",
    });
    assertObservedRuntimeGate(admissionActivated, "closed");
    await input.port.transitionRuntimeGate({
      expectedRevision: closed.revision,
      status: "active",
      reasonCode: "operator_activation",
      changedAt: now(),
      changedByHash: operatorHash,
    });
    assertGateTransition(
      closed,
      (await observe("runtime_gate_activated_last")).runtimeGate,
      "active",
      operatorHash,
    );
  } else if (input.command === "kill-switch") {
    const before = await input.port.readRuntimeGate();
    const closed = await closeRuntimeGate(
      input.port,
      before,
      "operator_kill_switch",
      operatorHash,
      now(),
    );
    assertGateTransitionOrClosed(
      before,
      (await observe("runtime_gate_closed_first")).runtimeGate,
      closed,
      operatorHash,
    );
    await input.port.setFlags({
      REVIEW_ROUTER_ENABLE_HOSTED_CODEX_ADMISSION: "0",
      REVIEW_ROUTER_ENABLE_HOSTED_CODEX_FAILOVER: "0",
      REVIEW_ROUTER_ENABLE_HOSTED_CODEX_RELAY: "0",
    });
    assertObservedPatch(await observe("kill_switch_closed"), {
      REVIEW_ROUTER_ENABLE_HOSTED_CODEX_ADMISSION: "0",
      REVIEW_ROUTER_ENABLE_HOSTED_CODEX_FAILOVER: "0",
      REVIEW_ROUTER_ENABLE_HOSTED_CODEX_RELAY: "0",
    });
  } else {
    const rollbackFailures: unknown[] = [];
    try {
      const before = await input.port.readRuntimeGate();
      const closed = await closeRuntimeGate(
        input.port,
        before,
        input.command === "rollback" ? "operator_rollback" : "operator_drain",
        operatorHash,
        now(),
      );
      assertGateTransitionOrClosed(
        before,
        (await observe("runtime_gate_closed_first")).runtimeGate,
        closed,
        operatorHash,
      );
    } catch (error) {
      if (input.command !== "rollback") throw error;
      rollbackFailures.push(error);
    }
    if (input.command === "rollback" && input.port.setFaultPlan) {
      try {
        await input.port.setFaultPlan(null);
        events.push({ phase: "fault_plan_closed", at: now().toISOString() });
      } catch (error) {
        rollbackFailures.push(error);
      }
    }
    try {
      await input.port.setFlags({
        REVIEW_ROUTER_ENABLE_HOSTED_CODEX_ADMISSION: "0",
      });
    } catch (error) {
      if (input.command !== "rollback") throw error;
      rollbackFailures.push(error);
    }
    try {
      assertObservedPatch(await observe("admission_closed"), {
        REVIEW_ROUTER_ENABLE_HOSTED_CODEX_ADMISSION: "0",
      });
    } catch (error) {
      if (input.command !== "rollback") throw error;
      rollbackFailures.push(error);
    }
    let drainComplete = false;
    try {
      let drain = await waitForDrain(input.port, events, {
        now,
        ...(input.sleep ? { sleep: input.sleep } : {}),
        ...(input.maxDrainPolls ? { maxPolls: input.maxDrainPolls } : {}),
      });
      if (drain === "legacy_ready") {
        const closed = await input.port.readRuntimeGate();
        await input.port.acknowledgeLegacyIssuerDrain?.(closed);
        events.push({
          phase: "legacy_issuer_drain_acknowledged",
          at: now().toISOString(),
          runtimeGate: closed,
        });
        // Re-read the durable closure after acknowledgment. This returns a
        // resumable quarantine deadline instead of spending the five-minute
        // grant-drain poll budget waiting for the 61-minute provider TTL.
        drain = await waitForDrain(input.port, events, {
          now,
          maxPolls: 1,
        });
      }
      if (drain === "waiting")
        return evidence(input.command, "waiting", events);
      drainComplete = true;
    } catch (error) {
      if (input.command !== "rollback") throw error;
      rollbackFailures.push(error);
    }
    if (input.command === "rollback") {
      for (const [phase, patch] of [
        [
          "failover_closed",
          { REVIEW_ROUTER_ENABLE_HOSTED_CODEX_FAILOVER: "0" },
        ],
        ["relay_closed", { REVIEW_ROUTER_ENABLE_HOSTED_CODEX_RELAY: "0" }],
      ] as const) {
        try {
          await input.port.setFlags(patch);
        } catch (error) {
          rollbackFailures.push(error);
        }
        try {
          assertObservedPatch(await observe(phase), patch);
        } catch (error) {
          rollbackFailures.push(error);
        }
      }
      // Custody is the only recovery path for durable token work. Disable it
      // and the pool only after the gate/admission/drain and the reversible
      // relay/failover closures all completed without error. A later operator
      // invocation resumes from the already-safe partial closure.
      const custodyDisableAuthorized =
        drainComplete && rollbackFailures.length === 0;
      if (custodyDisableAuthorized) {
        for (const [phase, patch] of [
          [
            "custody_closed",
            { REVIEW_ROUTER_ENABLE_HOSTED_CODEX_CUSTODY: "0" },
          ],
          ["pool_closed", { REVIEW_ROUTER_ENABLE_HOSTED_CODEX_POOL: "0" }],
        ] as const) {
          const failuresBeforePhase = rollbackFailures.length;
          try {
            await input.port.setFlags(patch);
          } catch (error) {
            rollbackFailures.push(error);
          }
          try {
            assertObservedPatch(await observe(phase), patch);
          } catch (error) {
            rollbackFailures.push(error);
          }
          if (rollbackFailures.length > failuresBeforePhase) break;
        }
      }
      if (custodyDisableAuthorized)
        try {
          const final = await observe("rollback_final_reread");
          assertObservedPatch(final, {
            REVIEW_ROUTER_ENABLE_HOSTED_CODEX_ADMISSION: "0",
            REVIEW_ROUTER_ENABLE_HOSTED_CODEX_FAILOVER: "0",
            REVIEW_ROUTER_ENABLE_HOSTED_CODEX_RELAY: "0",
            REVIEW_ROUTER_ENABLE_HOSTED_CODEX_CUSTODY: "0",
            REVIEW_ROUTER_ENABLE_HOSTED_CODEX_POOL: "0",
          });
          if (
            final.counts.inFlight !== 0 ||
            final.counts.issuedGrants !== 0 ||
            final.counts.unresolvedRequests !== 0 ||
            (final.counts.unresolvedMintAttempts ?? 0) !== 0
          )
            throw new Error("hosted_pool_rollback_final_drain_incomplete");
        } catch (error) {
          rollbackFailures.push(error);
        }
      if (rollbackFailures.length > 0)
        throw new HostedPoolRollbackError(
          rollbackFailures,
          evidence(input.command, "failed", events),
        );
    }
  }
  return evidence(input.command, "executed", events);
}

function assertRuntimeGate(gate: HostedPoolRuntimeGate): void {
  if (
    (gate.status !== "closed" && gate.status !== "active") ||
    !/^[1-9][0-9]*$/u.test(gate.authzEpoch) ||
    !/^[1-9][0-9]*$/u.test(gate.revision) ||
    !/^[a-f0-9]{64}$/u.test(gate.changedByHash) ||
    !Number.isFinite(Date.parse(gate.changedAt)) ||
    gate.reasonCode.length < 1 ||
    gate.reasonCode.length > 160
  ) {
    throw new Error("hosted_pool_runtime_gate_invalid");
  }
}

function assertObservedRuntimeGate(
  event: { runtimeGate: HostedPoolRuntimeGate },
  status: "closed" | "active",
): void {
  if (event.runtimeGate.status !== status)
    throw new Error(`hosted_pool_runtime_gate_not_${status}`);
}

function assertGateTransition(
  before: HostedPoolRuntimeGate,
  after: HostedPoolRuntimeGate,
  status: "closed" | "active",
  changedByHash: string,
): void {
  assertRuntimeGate(before);
  assertRuntimeGate(after);
  if (
    after.status !== status ||
    BigInt(after.authzEpoch) !== BigInt(before.authzEpoch) + 1n ||
    BigInt(after.revision) !== BigInt(before.revision) + 1n ||
    after.changedByHash !== changedByHash
  ) {
    throw new Error("hosted_pool_runtime_gate_transition_invalid");
  }
}

function assertGateTransitionOrClosed(
  before: HostedPoolRuntimeGate,
  observed: HostedPoolRuntimeGate,
  closed: HostedPoolRuntimeGate,
  changedByHash: string,
): void {
  if (observed.status !== "closed" || observed.revision !== closed.revision)
    throw new Error("hosted_pool_runtime_gate_close_not_observed");
  if (before.status === "active")
    assertGateTransition(before, observed, "closed", changedByHash);
}

async function closeRuntimeGate(
  port: HostedPoolControlPort,
  before: HostedPoolRuntimeGate,
  reasonCode: string,
  changedByHash: string,
  changedAt: Date,
): Promise<HostedPoolRuntimeGate> {
  assertRuntimeGate(before);
  if (before.status === "closed") {
    await port.ensureRuntimeClosure?.(before, reasonCode, changedByHash);
    return before;
  }
  return port.transitionRuntimeGate({
    expectedRevision: before.revision,
    status: "closed",
    reasonCode,
    changedAt,
    changedByHash,
  });
}

function assertObservedPatch(
  event: { flags: Record<string, Record<HostedPoolFlagName, string>> },
  patch: HostedPoolFlagPatch,
) {
  for (const flags of Object.values(event.flags)) {
    for (const [name, value] of Object.entries(patch)) {
      if (flags[name as HostedPoolFlagName] !== value)
        throw new Error(`hosted_pool_control_flag_not_active:${name}`);
    }
  }
}

function validateObservedFlags(
  services: Record<string, Record<HostedPoolFlagName, string>>,
  allowServiceDrift = false,
  allowDependencyDrift = false,
) {
  const dependencies: Partial<Record<HostedPoolFlagName, HostedPoolFlagName>> =
    {
      REVIEW_ROUTER_ENABLE_HOSTED_CODEX_CUSTODY:
        "REVIEW_ROUTER_ENABLE_HOSTED_CODEX_POOL",
      REVIEW_ROUTER_ENABLE_HOSTED_CODEX_ADMISSION:
        "REVIEW_ROUTER_ENABLE_HOSTED_CODEX_CUSTODY",
      REVIEW_ROUTER_ENABLE_HOSTED_CODEX_RELAY:
        "REVIEW_ROUTER_ENABLE_HOSTED_CODEX_CUSTODY",
      REVIEW_ROUTER_ENABLE_HOSTED_CODEX_FAILOVER:
        "REVIEW_ROUTER_ENABLE_HOSTED_CODEX_RELAY",
    };
  const values = Object.values(services);
  if (values.length !== 2)
    throw new Error("hosted_pool_control_service_count_invalid");
  for (const flags of values) {
    for (const name of hostedPoolFlagNames) {
      if (flags[name] !== "0" && flags[name] !== "1")
        throw new Error(`hosted_pool_control_flag_invalid:${name}`);
      const dependency = dependencies[name];
      if (
        !allowDependencyDrift &&
        flags[name] === "1" &&
        dependency &&
        flags[dependency] !== "1"
      )
        throw new Error(`hosted_pool_control_flag_dependency:${name}`);
    }
  }
  if (!allowServiceDrift)
    for (const name of hostedPoolFlagNames) {
      if (values[0]![name] !== values[1]![name])
        throw new Error(`hosted_pool_control_service_drift:${name}`);
    }
}

async function waitForDrain(
  port: HostedPoolControlPort,
  events: Array<Record<string, unknown>>,
  options: {
    now: () => Date;
    sleep?: (milliseconds: number) => Promise<void>;
    maxPolls?: number;
  },
): Promise<"complete" | "waiting" | "legacy_ready"> {
  const sleep =
    options.sleep ??
    ((milliseconds) => new Promise((done) => setTimeout(done, milliseconds)));
  const maxPolls = options.maxPolls ?? 60;
  for (let poll = 1; poll <= maxPolls; poll += 1) {
    const reconciliation = await port.reconcileExpiredGrants();
    const counts = await port.counts();
    events.push({
      phase: "drain_poll",
      poll,
      at: options.now().toISOString(),
      expiredGrantsReconciled: reconciliation.expiredCount,
      expiryReconciliationBatches: reconciliation.batches,
      counts,
    });
    if (
      counts.inFlight === 0 &&
      counts.issuedGrants === 0 &&
      counts.unresolvedRequests === 0 &&
      (counts.unresolvedMintAttempts ?? 0) === 0
    ) {
      const gate = await port.readRuntimeGate();
      const closure = await port.readRuntimeClosure?.(gate);
      if (closure?.state === "draining" && closure.legacyBarrier) {
        return "legacy_ready";
      }
      if (
        closure?.state === "draining" &&
        !closure.legacyBarrier &&
        closure.legacyUnsafeUntil > options.now()
      ) {
        events.push({
          phase: "runtime_closure_quarantine_waiting",
          at: options.now().toISOString(),
          resumable: true,
          retryAt: closure.legacyUnsafeUntil.toISOString(),
          remainingMs:
            closure.legacyUnsafeUntil.getTime() - options.now().getTime(),
        });
        return "waiting";
      }
      await port.completeRuntimeClosure?.(gate);
      return "complete";
    }
    if (poll < maxPolls) await sleep(5_000);
  }
  throw new Error("hosted_pool_admission_drain_timeout");
}

function evidence(
  command: string,
  result: string,
  events: Array<Record<string, unknown>>,
) {
  const payload = { schemaVersion: 2, command, result, events };
  return Object.freeze({
    ...payload,
    evidenceSha256: createHash("sha256")
      .update(JSON.stringify(payload))
      .digest("hex"),
  });
}

export function createRenderHostedPoolControlPort(input: {
  readonly apiKey: string;
  readonly serviceIds: readonly [string, string];
  readonly databaseUrl: string;
  readonly fetchImpl?: typeof fetch;
  readonly renderTimeoutMs?: number;
}): HostedPoolControlPort & { disconnect(): Promise<void> } {
  const prisma = createPrismaClient({
    databaseUrl: input.databaseUrl,
    poolMax: 1,
  });
  const invocationGrants = new PrismaInvocationGrantRepository(prisma);
  const fetchImpl = input.fetchImpl ?? fetch;
  const renderTimeoutMs = input.renderTimeoutMs ?? 10_000;
  if (!Number.isSafeInteger(renderTimeoutMs) || renderTimeoutMs < 1)
    throw new Error("hosted_pool_render_timeout_invalid");
  const request = async (method: string, path: string, body?: unknown) => {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, renderTimeoutMs);
    try {
      const response = await fetchImpl(`https://api.render.com/v1${path}`, {
        method,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${input.apiKey}`,
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok)
        throw new Error(
          `hosted_pool_render_response_rejected:${response.status}`,
        );
      try {
        return await response.json();
      } catch {
        throw new Error("hosted_pool_render_response_invalid");
      }
    } catch (error) {
      if (timedOut)
        // Provider errors may contain URLs, headers, or response bodies.
        // eslint-disable-next-line preserve-caught-error
        throw new Error("hosted_pool_render_timeout");
      if (
        error instanceof Error &&
        error.message.startsWith("hosted_pool_render_response_")
      )
        throw error;
      // Provider errors may contain URLs, headers, or response bodies.
      // eslint-disable-next-line preserve-caught-error
      throw new Error("hosted_pool_render_request_failed");
    } finally {
      clearTimeout(timer);
    }
  };
  const readService = async (id: string) => {
    const index = input.serviceIds.indexOf(id);
    const expectedName = index === 0 ? "reviewrouter-api" : "reviewrouter-web";
    const serviceValue: any = await request("GET", `/services/${id}`);
    const service = serviceValue?.service ?? serviceValue;
    if (service?.id !== id || service?.name !== expectedName)
      throw new Error(`hosted_pool_render_service_identity_mismatch:${id}`);
    const value = await request("GET", `/services/${id}/env-vars?limit=100`);
    if (!Array.isArray(value))
      throw new Error("hosted_pool_render_env_invalid");
    if (value.length >= 100)
      throw new Error("hosted_pool_render_env_pagination_unsupported");
    return Object.fromEntries(
      value.map((item: any) => {
        const envVar = item?.envVar ?? item;
        return [
          envVar?.key,
          String(envVar?.value ?? envVar?.envVarValue?.value ?? ""),
        ];
      }),
    );
  };
  const readRuntimeGate = async (): Promise<HostedPoolRuntimeGate> => {
    const rows = await prisma.$queryRaw<
      Array<{
        status: string;
        authzEpoch: bigint;
        revision: bigint;
        reasonCode: string;
        changedAt: Date;
        changedByHash: string;
      }>
    >`
      SELECT "status"::text AS "status", "authzEpoch", "revision",
             "reasonCode", "changedAt", "changedByHash"
      FROM "HostedCodexRuntimeGate"
      WHERE "id" = 'global'
    `;
    if (rows.length !== 1) throw new Error("hosted_pool_runtime_gate_missing");
    const row = rows[0]!;
    const gate: HostedPoolRuntimeGate = {
      status:
        row.status === "active"
          ? "active"
          : row.status === "closed"
            ? "closed"
            : (() => {
                throw new Error("hosted_pool_runtime_gate_status_invalid");
              })(),
      authzEpoch: row.authzEpoch.toString(),
      revision: row.revision.toString(),
      reasonCode: row.reasonCode,
      changedAt: row.changedAt.toISOString(),
      changedByHash: row.changedByHash,
    };
    assertRuntimeGate(gate);
    return gate;
  };
  return {
    readRuntimeGate,
    async ensureRuntimeClosure(gate, reasonCode, changedByHash) {
      const reasonHash = createHash("sha256")
        .update(reasonCode, "utf8")
        .digest("hex");
      await prisma.$transaction(async (transaction) => {
        const lockedGate = await transaction.$queryRaw<
          Array<{ status: string; revision: bigint; authzEpoch: bigint }>
        >`
          SELECT "status"::text AS "status", "revision", "authzEpoch"
          FROM "HostedCodexRuntimeGate"
          WHERE "id" = 'global'
          FOR UPDATE
        `;
        if (
          lockedGate.length !== 1 ||
          lockedGate[0]!.status !== "closed" ||
          lockedGate[0]!.revision !== BigInt(gate.revision) ||
          lockedGate[0]!.authzEpoch !== BigInt(gate.authzEpoch)
        )
          throw new Error("hosted_pool_runtime_closure_gate_mismatch");
        await transaction.hostedCodexRuntimeClosure.upsert({
          where: { gateRevision: BigInt(gate.revision) },
          create: {
            id: `runtime-closure-${gate.revision}`,
            gateRevision: BigInt(gate.revision),
            closedAuthzEpoch: BigInt(gate.authzEpoch),
            actorHash: changedByHash,
            reasonHash,
            legacyBarrier: true,
            legacyUnsafeUntil: new Date(0),
          },
          update: {},
        });
      });
    },
    async acknowledgeLegacyIssuerDrain(gate) {
      await prisma.$transaction(async (transaction) => {
        const lockedGate = await transaction.$queryRaw<
          Array<{ status: string; revision: bigint; authzEpoch: bigint }>
        >`
          SELECT "status"::text AS "status", "revision", "authzEpoch"
          FROM "HostedCodexRuntimeGate"
          WHERE "id" = 'global'
          FOR UPDATE
        `;
        if (
          lockedGate.length !== 1 ||
          lockedGate[0]!.status !== "closed" ||
          lockedGate[0]!.revision !== BigInt(gate.revision) ||
          lockedGate[0]!.authzEpoch !== BigInt(gate.authzEpoch)
        )
          throw new Error("hosted_pool_runtime_closure_gate_mismatch");
        // This one-way acknowledgment starts the quarantine only after both
        // admission-off service deployments have been observed by the drain.
        const changed = await transaction.$executeRaw`
          UPDATE "HostedCodexRuntimeClosure"
          SET "legacyBarrier" = FALSE,
              "legacyUnsafeUntil" = clock_timestamp() + INTERVAL '61 minutes 1 second',
              "revision" = "revision" + 1
          WHERE "gateRevision" = ${BigInt(gate.revision)}
            AND "state" = 'draining'
            AND "legacyBarrier"
        `;
        if (changed !== 1) {
          const closure =
            await transaction.hostedCodexRuntimeClosure.findUnique({
              where: { gateRevision: BigInt(gate.revision) },
              select: { state: true, legacyBarrier: true },
            });
          if (closure?.state !== "draining" || closure.legacyBarrier)
            throw new Error("hosted_pool_runtime_closure_legacy_ack_conflict");
        }
      });
    },
    async assertRuntimeClosureComplete(gate) {
      const closure = await prisma.hostedCodexRuntimeClosure.findUnique({
        where: { gateRevision: BigInt(gate.revision) },
        select: { state: true },
      });
      if (closure?.state !== "complete")
        throw new Error("hosted_pool_runtime_closure_incomplete");
    },
    async readRuntimeClosure(gate) {
      const closure = await prisma.hostedCodexRuntimeClosure.findUnique({
        where: { gateRevision: BigInt(gate.revision) },
        select: {
          state: true,
          legacyBarrier: true,
          legacyUnsafeUntil: true,
        },
      });
      return closure
        ? {
            state: closure.state,
            legacyBarrier: closure.legacyBarrier,
            legacyUnsafeUntil: closure.legacyUnsafeUntil,
          }
        : null;
    },
    async completeRuntimeClosure(gate) {
      await prisma.$transaction(async (transaction) => {
        const lockedGate = await transaction.$queryRaw<
          Array<{
            status: string;
            revision: bigint;
            authzEpoch: bigint;
            now: Date;
          }>
        >`
          SELECT "status"::text AS "status", "revision", "authzEpoch",
                 clock_timestamp() AS "now"
          FROM "HostedCodexRuntimeGate"
          WHERE "id" = 'global'
          FOR UPDATE
        `;
        if (
          lockedGate.length !== 1 ||
          lockedGate[0]!.status !== "closed" ||
          lockedGate[0]!.revision !== BigInt(gate.revision) ||
          lockedGate[0]!.authzEpoch !== BigInt(gate.authzEpoch)
        )
          throw new Error("hosted_pool_runtime_closure_gate_mismatch");
        const changed = await transaction.hostedCodexRuntimeClosure.updateMany({
          where: {
            gateRevision: BigInt(gate.revision),
            state: "draining",
          },
          data: {
            state: "complete",
            completedAt: lockedGate[0]!.now,
            revision: { increment: 1 },
          },
        });
        if (changed.count !== 1) {
          const closure =
            await transaction.hostedCodexRuntimeClosure.findUnique({
              where: { gateRevision: BigInt(gate.revision) },
              select: { state: true },
            });
          if (closure?.state !== "complete")
            throw new Error("hosted_pool_runtime_closure_completion_conflict");
        }
      });
    },
    async transitionRuntimeGate(transition) {
      if (!/^[1-9][0-9]*$/u.test(transition.expectedRevision))
        throw new Error("hosted_pool_runtime_gate_revision_invalid");
      if (!/^[a-f0-9]{64}$/u.test(transition.changedByHash))
        throw new Error("hosted_pool_runtime_gate_actor_invalid");
      const reasonHash = createHash("sha256")
        .update(transition.reasonCode, "utf8")
        .digest("hex");
      const rows = await prisma.$queryRaw<
        Array<{
          status: string;
          authzEpoch: bigint;
          revision: bigint;
          reasonCode: string;
          changedAt: Date;
          changedByHash: string;
        }>
      >`
        WITH changed AS (
        UPDATE "HostedCodexRuntimeGate"
        SET "status" = CAST(${transition.status} AS "HostedCodexRuntimeGateStatus"),
            "authzEpoch" = "authzEpoch" + 1,
            "revision" = "revision" + 1,
            "reasonCode" = ${transition.reasonCode},
            "changedAt" = GREATEST(
              clock_timestamp(),
              "changedAt" + INTERVAL '1 millisecond'
            ),
            "changedByHash" = ${transition.changedByHash}
        WHERE "id" = 'global'
          AND "revision" = ${BigInt(transition.expectedRevision)}
        RETURNING "status", "authzEpoch", "revision", "reasonCode", "changedAt", "changedByHash"
        ), closure AS (
          INSERT INTO "HostedCodexRuntimeClosure" (
            "id", "gateRevision", "closedAuthzEpoch", "actorHash", "reasonHash", "legacyBarrier", "legacyUnsafeUntil"
          )
          SELECT 'runtime-closure-' || "revision", "revision", "authzEpoch", ${transition.changedByHash}, ${reasonHash}, TRUE, TIMESTAMP 'epoch'
          FROM changed WHERE "status" = 'closed'
          ON CONFLICT ("gateRevision") DO NOTHING
          RETURNING "id"
        )
        SELECT "status"::text AS "status", "authzEpoch", "revision", "reasonCode", "changedAt", "changedByHash" FROM changed
      `;
      if (rows.length === 0) {
        const observed = await readRuntimeGate();
        if (
          observed.status === transition.status &&
          BigInt(observed.revision) ===
            BigInt(transition.expectedRevision) + 1n &&
          observed.changedByHash === transition.changedByHash
        ) {
          return observed;
        }
        throw new Error("hosted_pool_runtime_gate_revision_conflict");
      }
      if (rows.length !== 1)
        throw new Error("hosted_pool_runtime_gate_cardinality_invalid");
      const row = rows[0]!;
      const changed: HostedPoolRuntimeGate = {
        status: row.status === "active" ? "active" : "closed",
        authzEpoch: row.authzEpoch.toString(),
        revision: row.revision.toString(),
        reasonCode: row.reasonCode,
        changedAt: row.changedAt.toISOString(),
        changedByHash: row.changedByHash,
      };
      assertRuntimeGate(changed);
      return changed;
    },
    async readFlags() {
      const pairs = await Promise.all(
        input.serviceIds.map(
          async (id) => [id, await readService(id)] as const,
        ),
      );
      return Object.fromEntries(
        pairs.map(([id, env]) => [
          id,
          Object.fromEntries(
            hostedPoolFlagNames.map((name) => [name, env[name] ?? "missing"]),
          ),
        ]),
      ) as Record<string, Record<HostedPoolFlagName, string>>;
    },
    async setFlags(patch) {
      const failures: unknown[] = [];
      for (const id of input.serviceIds) {
        try {
          const current = await readService(id);
          const changed = Object.entries(patch).some(
            ([key, value]) => current[key] !== value,
          );
          if (!changed) continue;
          const priorDeployId = await latestDeployId(request, id);
          for (const [key, value] of Object.entries(patch))
            current[key] = value;
          await request(
            "PUT",
            `/services/${id}/env-vars`,
            Object.entries(current).map(([key, value]) => ({ key, value })),
          );
          await waitForNewLiveDeploy(request, id, priorDeployId);
          const observed = await readService(id);
          for (const [key, value] of Object.entries(patch)) {
            if (observed[key] !== value)
              throw new Error(`hosted_pool_render_env_drift:${id}:${key}`);
          }
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0)
        throw new AggregateError(
          failures,
          "hosted_pool_render_mutation_failed",
        );
    },
    async setFaultPlan(token) {
      if (token === null) {
        await cancelOpenStagedFaultPlans(prisma);
        return;
      }
      const repositoryId = readUnsignedFaultPlanRepositoryId(token);
      const bindings = await prisma.hostedCodexRepositoryBinding.findMany({
        where: {
          status: "active",
          attestedGithubRepositoryId: repositoryId,
        },
        select: { workspaceId: true },
      });
      if (bindings.length !== 1)
        throw new Error("hosted_pool_canary_fault_plan_binding_scope_invalid");
      await cancelOpenStagedFaultPlans(prisma);
      const planIdHash = createHash("sha256")
        .update(token, "utf8")
        .digest("hex");
      await prisma.auditEvent.create({
        data: {
          workspaceId: bindings[0]!.workspaceId,
          actor: "operator:production-canary",
          action: "hosted_codex_canary_fault_plan_staged",
          targetType: "hosted_codex_canary_fault_plan",
          targetId: planIdHash,
          metadata: { token },
        },
      });
    },
    async counts() {
      const [
        grants,
        unresolvedRequests,
        unresolvedMintAttempts,
        terminalUnknownRequests,
      ] = await Promise.all([
        prisma.hostedCodexInvocationGrant.aggregate({
          where: { status: "issued" },
          _sum: { inFlight: true },
          _count: true,
        }),
        prisma.hostedCodexRelayRequest.count({
          where: {
            status: { in: ["received", "processing", "response_started"] },
          },
        }),
        prisma.hostedCodexCommentTokenMint.count({
          where: {
            OR: [
              { state: "prepared" },
              { state: "dispatching" },
              { state: "outcome_unknown" },
              { state: "issued" },
              { state: "revoke_pending" },
            ],
          },
        }),
        prisma.hostedCodexRelayRequest.count({
          where: { status: "terminal_unknown" },
        }),
      ]);
      return {
        inFlight: grants._sum.inFlight ?? 0,
        issuedGrants: grants._count,
        unresolvedRequests,
        terminalUnknownRequests,
        unresolvedMintAttempts,
      };
    },
    async reconcileExpiredGrants() {
      const now = new Date();
      const ambiguityExpiryEvidence = createHash("sha256")
        .update("provider_token_max_lifetime_elapsed", "utf8")
        .digest("hex");
      await prisma.$transaction([
        prisma.$executeRaw`
          UPDATE "HostedCodexCommentTokenMint" mint
          SET "state" = 'failed_no_token',
              "completedAt" = clock_timestamp(),
              "terminalEvidenceHash" = ${ambiguityExpiryEvidence},
              "errorCode" = 'prepare_lease_expired',
              "revision" = mint."revision" + 1
          WHERE mint."state" = 'prepared'
            AND (mint."leaseExpiresAt" <= clock_timestamp() OR EXISTS (
              SELECT 1 FROM "HostedCodexRuntimeGate" gate
              WHERE gate."id" = 'global' AND gate."status" = 'closed'
            ))
        `,
        prisma.$executeRaw`
          UPDATE "HostedCodexCommentTokenMint" mint
          SET "state" = 'outcome_unknown',
              "errorCode" = 'dispatch_recovery_ambiguous',
              "revision" = mint."revision" + 1
          WHERE mint."state" = 'dispatching'
            AND mint."unsafeUntil" <= clock_timestamp()
        `,
        prisma.$executeRaw`
          UPDATE "HostedCodexCommentTokenMint" mint
          SET "state" = 'expired',
              "completedAt" = clock_timestamp(),
              "terminalEvidenceHash" = ${ambiguityExpiryEvidence},
              "errorCode" = 'provider_token_max_lifetime_elapsed',
              "revision" = mint."revision" + 1
          WHERE mint."state" = 'outcome_unknown'
            AND mint."unsafeUntil" <= clock_timestamp()
        `,
        prisma.$executeRaw`
          UPDATE "HostedCodexCommentTokenMint" mint
          SET "state" = 'expired',
              "completedAt" = clock_timestamp(),
              "terminalEvidenceHash" = ${ambiguityExpiryEvidence},
              "secretCiphertext" = NULL,
              "secretEncryptedDataKey" = NULL,
              "secretIv" = NULL,
              "secretAuthTag" = NULL,
              "secretKeyId" = NULL,
              "secretAadHash" = NULL,
              "revision" = mint."revision" + 1
          WHERE mint."state" IN ('issued', 'revoke_pending')
            AND GREATEST(mint."tokenExpiresAt" + INTERVAL '1 minute', mint."unsafeUntil") <= clock_timestamp()
        `,
      ]);
      return reconcileExpiredInvocationGrants({ now }, invocationGrants);
    },
    disconnect: () => prisma.$disconnect(),
  };
}

export async function cancelOpenStagedFaultPlans(
  prisma: ReturnType<typeof createPrismaClient>,
  now = new Date(),
) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await prisma.$transaction(
        async (transaction) => {
          const staged = await transaction.auditEvent.findMany({
            where: {
              action: "hosted_codex_canary_fault_plan_staged",
              targetType: "hosted_codex_canary_fault_plan",
              createdAt: {
                gte: new Date(
                  now.getTime() - hostedCodexCanaryFaultPlanMaxLifetimeMs,
                ),
              },
            },
            orderBy: { createdAt: "desc" },
            take: 101,
            select: { workspaceId: true, targetId: true },
          });
          if (staged.length > 100)
            throw new Error(
              "hosted_pool_canary_fault_plan_cleanup_scan_limit_exceeded",
            );
          const targetIds = [...new Set(staged.map((plan) => plan.targetId))];
          const closed =
            targetIds.length === 0
              ? []
              : await transaction.auditEvent.findMany({
                  where: {
                    action: {
                      in: [
                        "hosted_codex_canary_fault_plan_consumed",
                        "hosted_codex_canary_fault_plan_canceled",
                      ],
                    },
                    targetType: "hosted_codex_canary_fault_plan",
                    targetId: { in: targetIds },
                  },
                  select: { targetId: true },
                });
          const closedTargetIds = new Set(closed.map((plan) => plan.targetId));
          for (const plan of staged) {
            if (closedTargetIds.has(plan.targetId)) continue;
            await transaction.auditEvent.create({
              data: {
                workspaceId: plan.workspaceId,
                actor: "operator:production-canary",
                action: "hosted_codex_canary_fault_plan_canceled",
                targetType: "hosted_codex_canary_fault_plan",
                targetId: plan.targetId,
                metadata: { reason: "operator_scope_closed" },
              },
            });
            closedTargetIds.add(plan.targetId);
          }
        },
        { isolationLevel: "Serializable" },
      );
      return;
    } catch (error) {
      if (attempt < 3 && isPrismaWriteConflict(error)) continue;
      throw error;
    }
  }
}

function isPrismaWriteConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2034"
  );
}

function readUnsignedFaultPlanRepositoryId(token: string): bigint {
  if (
    Buffer.byteLength(token, "utf8") > hostedCodexCanaryFaultPlanTokenMaxBytes
  )
    throw new Error("hosted_pool_canary_fault_plan_envelope_invalid");
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "rr-canary-fault-v2")
    throw new Error("hosted_pool_canary_fault_plan_envelope_invalid");
  let value: unknown;
  try {
    const payload = Buffer.from(parts[1]!, "base64url");
    if (payload.toString("base64url") !== parts[1])
      throw new Error("non_canonical");
    value = JSON.parse(payload.toString("utf8"));
  } catch {
    throw new Error("hosted_pool_canary_fault_plan_envelope_invalid");
  }
  const repositoryId = (value as { repository_id?: unknown })?.repository_id;
  if (typeof repositoryId !== "string" || !/^[1-9]\d*$/u.test(repositoryId))
    throw new Error("hosted_pool_canary_fault_plan_envelope_invalid");
  return BigInt(repositoryId);
}

async function latestDeployId(
  request: (method: string, path: string, body?: unknown) => Promise<any>,
  serviceId: string,
) {
  const value = await request("GET", `/services/${serviceId}/deploys?limit=1`);
  const item = Array.isArray(value) ? value[0] : value?.deploys?.[0];
  return (item?.deploy ?? item)?.id ?? null;
}

async function waitForNewLiveDeploy(
  request: (method: string, path: string, body?: unknown) => Promise<any>,
  serviceId: string,
  priorDeployId: string | null,
) {
  for (let poll = 0; poll < 120; poll += 1) {
    const value = await request(
      "GET",
      `/services/${serviceId}/deploys?limit=1`,
    );
    const item = Array.isArray(value) ? value[0] : value?.deploys?.[0];
    const deploy = item?.deploy ?? item;
    if (deploy?.id && deploy.id !== priorDeployId) {
      if (deploy.status === "live") return;
      if (
        ["build_failed", "update_failed", "canceled", "deactivated"].includes(
          deploy.status,
        )
      )
        throw new Error(
          `hosted_pool_render_deploy_failed:${serviceId}:${deploy.status}`,
        );
    }
    await new Promise((done) => setTimeout(done, 5_000));
  }
  throw new Error(`hosted_pool_render_deploy_timeout:${serviceId}`);
}

async function main() {
  const command = process.argv[2] as
    | "status"
    | "activate"
    | "kill-switch"
    | "drain"
    | "rollback";
  if (
    !(
      ["status", "activate", "kill-switch", "drain", "rollback"] as const
    ).includes(command)
  )
    throw new Error(
      "usage: hosted-pool:control <status|activate|kill-switch|drain|rollback> [--execute]",
    );
  const serviceIds = required(
    process.env.REVIEW_ROUTER_HOSTED_POOL_RENDER_SERVICE_IDS,
  )
    .split(",")
    .map((value) => value.trim());
  if (
    serviceIds.length !== 2 ||
    serviceIds.some((value) => !/^srv-[a-z0-9]+$/u.test(value))
  )
    throw new Error("hosted_pool_exact_api_web_service_ids_required");
  const port = createRenderHostedPoolControlPort({
    apiKey: required(process.env.RENDER_API_KEY),
    serviceIds: serviceIds as [string, string],
    databaseUrl: required(
      process.env.REVIEW_ROUTER_HOSTED_POOL_OPERATOR_DATABASE_URL,
    ),
  });
  try {
    const result = await executeHostedPoolControl({
      command,
      execute: process.argv.includes("--execute"),
      ...(process.env.REVIEW_ROUTER_HOSTED_POOL_CONTROL_CONFIRM
        ? {
            confirmation: process.env.REVIEW_ROUTER_HOSTED_POOL_CONTROL_CONFIRM,
          }
        : {}),
      port,
    });
    const output = resolve(
      process.env.REVIEW_ROUTER_HOSTED_POOL_CONTROL_EVIDENCE_FILE ??
        `/tmp/reviewrouter-hosted-pool-control/${command}-${Date.now()}.json`,
    );
    await mkdir(dirname(output), { recursive: true, mode: 0o700 });
    await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, {
      mode: 0o600,
    });
    console.log(
      JSON.stringify({
        command,
        result: result.result,
        evidenceFile: output,
        evidenceSha256: result.evidenceSha256,
      }),
    );
  } finally {
    await port.disconnect();
  }
}

function required(value: string | undefined) {
  const result = value?.trim();
  if (!result) throw new Error("hosted_pool_control_required_value_missing");
  return result;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
