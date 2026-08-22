import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPrismaClient } from "../packages/platform/db/src/index.js";

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
}>;
export type HostedPoolControlPort = Readonly<{
  readFlags(): Promise<Record<string, Record<HostedPoolFlagName, string>>>;
  setFlags(patch: HostedPoolFlagPatch): Promise<void>;
  counts(): Promise<HostedPoolCounts>;
}>;

export async function executeHostedPoolControl(input: {
  readonly command: "status" | "kill-switch" | "drain" | "rollback";
  readonly execute: boolean;
  readonly confirmation?: string;
  readonly port: HostedPoolControlPort;
  readonly now?: () => Date;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly maxDrainPolls?: number;
}) {
  const now = input.now ?? (() => new Date());
  const events: Array<Record<string, unknown>> = [];
  const observe = async (phase: string) => {
    const [flags, counts] = await Promise.all([
      input.port.readFlags(),
      input.port.counts(),
    ]);
    validateObservedFlags(flags, input.execute && input.command !== "status");
    const event = { phase, at: now().toISOString(), flags, counts };
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

  if (input.command === "kill-switch") {
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
    await input.port.setFlags({
      REVIEW_ROUTER_ENABLE_HOSTED_CODEX_ADMISSION: "0",
    });
    assertObservedPatch(await observe("admission_closed"), {
      REVIEW_ROUTER_ENABLE_HOSTED_CODEX_ADMISSION: "0",
    });
    await waitForDrain(input.port, events, {
      now,
      ...(input.sleep ? { sleep: input.sleep } : {}),
      ...(input.maxDrainPolls ? { maxPolls: input.maxDrainPolls } : {}),
    });
    if (input.command === "rollback") {
      for (const [phase, patch] of [
        [
          "failover_closed",
          { REVIEW_ROUTER_ENABLE_HOSTED_CODEX_FAILOVER: "0" },
        ],
        ["relay_closed", { REVIEW_ROUTER_ENABLE_HOSTED_CODEX_RELAY: "0" }],
        ["custody_closed", { REVIEW_ROUTER_ENABLE_HOSTED_CODEX_CUSTODY: "0" }],
        ["pool_closed", { REVIEW_ROUTER_ENABLE_HOSTED_CODEX_POOL: "0" }],
      ] as const) {
        await input.port.setFlags(patch);
        assertObservedPatch(await observe(phase), patch);
      }
    }
  }
  return evidence(input.command, "executed", events);
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
      if (flags[name] === "1" && dependency && flags[dependency] !== "1")
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
) {
  const sleep =
    options.sleep ??
    ((milliseconds) => new Promise((done) => setTimeout(done, milliseconds)));
  const maxPolls = options.maxPolls ?? 60;
  for (let poll = 1; poll <= maxPolls; poll += 1) {
    const counts = await port.counts();
    events.push({
      phase: "drain_poll",
      poll,
      at: options.now().toISOString(),
      counts,
    });
    if (
      counts.inFlight === 0 &&
      counts.issuedGrants === 0 &&
      counts.unresolvedRequests === 0
    )
      return;
    if (poll < maxPolls) await sleep(5_000);
  }
  throw new Error("hosted_pool_admission_drain_timeout");
}

function evidence(
  command: string,
  result: string,
  events: Array<Record<string, unknown>>,
) {
  const payload = { schemaVersion: 1, command, result, events };
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
}): HostedPoolControlPort & { disconnect(): Promise<void> } {
  const prisma = createPrismaClient({
    databaseUrl: input.databaseUrl,
    poolMax: 1,
  });
  const request = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`https://api.render.com/v1${path}`, {
      method,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${input.apiKey}`,
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error",
    });
    if (!response.ok) throw new Error(`hosted_pool_render_${response.status}`);
    return response.json();
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
  return {
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
      for (const id of input.serviceIds) {
        const current = await readService(id);
        const changed = Object.entries(patch).some(
          ([key, value]) => current[key] !== value,
        );
        if (!changed) continue;
        const priorDeployId = await latestDeployId(request, id);
        for (const [key, value] of Object.entries(patch)) current[key] = value;
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
      }
    },
    async counts() {
      const [grants, unresolvedRequests, terminalUnknownRequests] =
        await Promise.all([
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
          prisma.hostedCodexRelayRequest.count({
            where: { status: "terminal_unknown" },
          }),
        ]);
      return {
        inFlight: grants._sum.inFlight ?? 0,
        issuedGrants: grants._count,
        unresolvedRequests,
        terminalUnknownRequests,
      };
    },
    disconnect: () => prisma.$disconnect(),
  };
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
    | "kill-switch"
    | "drain"
    | "rollback";
  if (
    !(["status", "kill-switch", "drain", "rollback"] as const).includes(command)
  )
    throw new Error(
      "usage: hosted-pool:control <status|kill-switch|drain|rollback> [--execute]",
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
