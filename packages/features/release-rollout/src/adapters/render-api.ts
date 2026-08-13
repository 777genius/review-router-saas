import { createHash } from "node:crypto";
import type { EnvironmentMutationOutcome } from "../application/service-transition-ports";

export interface RenderFetch {
  (input: string, init?: RequestInit): Promise<Response>;
}
export interface CursorPage<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}
export interface RenderService {
  readonly id: string;
  readonly ownerId: string;
  readonly name?: string;
  readonly type: string;
  readonly repo?: string;
  readonly branch?: string;
  readonly rootDir?: string;
  readonly suspended: "suspended" | "not_suspended";
  readonly autoDeploy: "yes" | "no";
  readonly autoDeployTrigger?: "commit" | "checksPass" | "off";
  readonly imagePath?: string;
  readonly image?: { readonly imagePath: string };
  readonly serviceDetails: Record<string, unknown>;
}
export interface RenderDeploy {
  readonly id: string;
  readonly status: string;
  readonly commit?: { readonly id: string };
  readonly image?: { readonly sha: string; readonly ref?: string };
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly finishedAt?: string;
}
export interface RenderJob {
  readonly id: string;
  readonly serviceId: string;
  readonly startCommand: string;
  readonly planId?: string;
  readonly status: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly finishedAt?: string;
}
export interface RenderLog {
  readonly id: string;
  readonly message: string;
  readonly timestamp: string;
}
const origin = "https://api.render.com/v1";
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const string = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;
function requireSubset(
  value: unknown,
  fields: readonly string[],
  error: string,
): Record<string, unknown> {
  if (!record(value) || fields.some((field) => !Object.hasOwn(value, field)))
    throw new Error(error);
  return value;
}
function headers(token: string, json = false): Record<string, string> {
  if (!token) throw new Error("render_api_token_missing");
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    ...(json ? { "Content-Type": "application/json" } : {}),
  };
}
async function body(
  response: Response,
  operation: string,
  status = 200,
): Promise<unknown> {
  if (response.status !== status)
    throw new Error(`render_api_${operation}_failed:${response.status}`);
  try {
    return await response.json();
  } catch {
    throw new Error(`render_api_${operation}_response_invalid`);
  }
}

export class RenderApiAdapter {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: RenderFetch = fetch,
  ) {}

  async getService(id: string): Promise<RenderService> {
    const value = requireSubset(
      await body(
        await this.fetchImpl(`${origin}/services/${encodeURIComponent(id)}`, {
          headers: headers(this.token),
        }),
        "service",
      ),
      ["id", "ownerId", "type", "suspended", "autoDeploy", "serviceDetails"],
      "render_service_response_invalid",
    );
    if (
      ![value.id, value.ownerId, value.type].every(string) ||
      !["suspended", "not_suspended"].includes(String(value.suspended)) ||
      !["yes", "no"].includes(String(value.autoDeploy)) ||
      !record(value.serviceDetails)
    )
      throw new Error("render_service_response_invalid");
    return value as unknown as RenderService;
  }

  async listServices(cursor?: string): Promise<CursorPage<RenderService>> {
    const url = new URL(`${origin}/services`);
    if (cursor) url.searchParams.set("cursor", cursor);
    const value = await body(
      await this.fetchImpl(url.toString(), { headers: headers(this.token) }),
      "service_list",
    );
    if (!Array.isArray(value))
      throw new Error("render_service_list_response_invalid");
    const items = value.map((wrapper) => {
      const item = requireSubset(
        wrapper,
        ["service"],
        "render_service_wrapper_invalid",
      );
      const service = requireSubset(
        item.service,
        ["id", "ownerId", "type", "suspended", "autoDeploy", "serviceDetails"],
        "render_service_response_invalid",
      );
      return service as unknown as RenderService;
    });
    const next = value.length
      ? (value.at(-1) as Record<string, unknown>).cursor
      : undefined;
    return {
      items,
      nextCursor: typeof next === "string" && next ? next : null,
    };
  }

  async listAllServices(): Promise<readonly RenderService[]> {
    const all: RenderService[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.listServices(cursor);
      all.push(...page.items);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return Object.freeze(all);
  }

  async listDeploys(
    serviceId: string,
    cursor?: string,
  ): Promise<CursorPage<RenderDeploy>> {
    const url = new URL(
      `${origin}/services/${encodeURIComponent(serviceId)}/deploys`,
    );
    if (cursor) url.searchParams.set("cursor", cursor);
    const value = await body(
      await this.fetchImpl(url.toString(), { headers: headers(this.token) }),
      "deploy_list",
    );
    if (!Array.isArray(value))
      throw new Error("render_deploy_list_response_invalid");
    const items = value.map((wrapper) => {
      const wrapped = requireSubset(
        wrapper,
        ["deploy"],
        "render_deploy_wrapper_invalid",
      );
      const deploy = requireSubset(
        wrapped.deploy,
        ["id", "status"],
        "render_deploy_response_invalid",
      );
      if (
        !string(deploy.id) ||
        !string(deploy.status) ||
        (deploy.commit !== undefined &&
          (!record(deploy.commit) || !string(deploy.commit.id))) ||
        (deploy.image !== undefined &&
          (!record(deploy.image) || !string(deploy.image.sha))) ||
        (deploy.commit !== undefined && deploy.image !== undefined)
      )
        throw new Error("render_deploy_response_invalid");
      return deploy as unknown as RenderDeploy;
    });
    const cursorHeader = value.length
      ? (value.at(-1) as Record<string, unknown>).cursor
      : undefined;
    return {
      items,
      nextCursor:
        typeof cursorHeader === "string" && cursorHeader ? cursorHeader : null,
    };
  }

  async listAllDeploys(serviceId: string): Promise<readonly RenderDeploy[]> {
    const all: RenderDeploy[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.listDeploys(serviceId, cursor);
      all.push(...page.items);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return Object.freeze(all);
  }

  async getDeploy(serviceId: string, deployId: string): Promise<RenderDeploy> {
    const value = requireSubset(
      await body(
        await this.fetchImpl(
          `${origin}/services/${encodeURIComponent(serviceId)}/deploys/${encodeURIComponent(deployId)}`,
          { headers: headers(this.token) },
        ),
        "deploy",
      ),
      ["id", "status"],
      "render_deploy_response_invalid",
    );
    if (
      !string(value.id) ||
      !string(value.status) ||
      (value.commit !== undefined &&
        (!record(value.commit) || !string(value.commit.id))) ||
      (value.image !== undefined &&
        (!record(value.image) ||
          !string(value.image.sha) ||
          (value.image.ref !== undefined && !string(value.image.ref)))) ||
      (value.commit !== undefined && value.image !== undefined)
    )
      throw new Error("render_deploy_response_invalid");
    return value as unknown as RenderDeploy;
  }

  async createDeploy(serviceId: string): Promise<RenderDeploy> {
    return this.createPinnedDeploy(serviceId);
  }

  async createPinnedDeploy(
    serviceId: string,
    commitId?: string,
  ): Promise<RenderDeploy> {
    const value = requireSubset(
      await body(
        await this.fetchImpl(
          `${origin}/services/${encodeURIComponent(serviceId)}/deploys`,
          {
            method: "POST",
            headers: headers(this.token, true),
            body: JSON.stringify({
              clearCache: "do_not_clear",
              ...(commitId ? { commitId } : {}),
            }),
          },
        ),
        "deploy_create",
        201,
      ),
      ["id", "status"],
      "render_deploy_response_invalid",
    );
    if (!string(value.id) || !string(value.status))
      throw new Error("render_deploy_response_invalid");
    return value as unknown as RenderDeploy;
  }

  async createJob(
    serviceId: string,
    input: { startCommand: string; planId?: string },
  ): Promise<RenderJob> {
    const request = {
      startCommand: input.startCommand,
      ...(input.planId ? { planId: input.planId } : {}),
    };
    const value = requireSubset(
      await body(
        await this.fetchImpl(
          `${origin}/services/${encodeURIComponent(serviceId)}/jobs`,
          {
            method: "POST",
            headers: headers(this.token, true),
            body: JSON.stringify(request),
          },
        ),
        "job_create",
        201,
      ),
      ["id", "serviceId", "startCommand", "status"],
      "render_job_response_invalid",
    );
    if (
      ![value.id, value.serviceId, value.startCommand, value.status].every(
        string,
      ) ||
      (["createdAt", "updatedAt", "finishedAt"] as const).some(
        (field) =>
          value[field] !== undefined &&
          (!string(value[field]) ||
            !Number.isFinite(Date.parse(value[field] as string))),
      ) ||
      (value.planId !== undefined &&
        value.planId !== null &&
        !string(value.planId))
    )
      throw new Error("render_job_response_invalid");
    if (value.planId === null) delete value.planId;
    return value as unknown as RenderJob;
  }

  async getJob(serviceId: string, jobId: string): Promise<RenderJob> {
    const value = requireSubset(
      await body(
        await this.fetchImpl(
          `${origin}/services/${encodeURIComponent(serviceId)}/jobs/${encodeURIComponent(jobId)}`,
          { headers: headers(this.token) },
        ),
        "job",
      ),
      ["id", "serviceId", "startCommand", "status"],
      "render_job_response_invalid",
    );
    if (
      ![value.id, value.serviceId, value.startCommand, value.status].every(
        string,
      ) ||
      (["createdAt", "updatedAt", "finishedAt"] as const).some(
        (field) =>
          value[field] !== undefined &&
          (!string(value[field]) ||
            !Number.isFinite(Date.parse(value[field] as string))),
      )
    )
      throw new Error("render_job_response_invalid");
    return value as unknown as RenderJob;
  }

  async listJobs(
    serviceId: string,
    cursor?: string,
  ): Promise<CursorPage<RenderJob>> {
    const url = new URL(
      `${origin}/services/${encodeURIComponent(serviceId)}/jobs`,
    );
    if (cursor) url.searchParams.set("cursor", cursor);
    const value = await body(
      await this.fetchImpl(url.toString(), { headers: headers(this.token) }),
      "job_list",
    );
    if (!Array.isArray(value))
      throw new Error("render_job_list_response_invalid");
    const items = value.map((wrapper) => {
      const item = requireSubset(
        wrapper,
        ["job"],
        "render_job_wrapper_invalid",
      );
      const job = requireSubset(
        item.job,
        ["id", "serviceId", "startCommand", "status"],
        "render_job_response_invalid",
      );
      return job as unknown as RenderJob;
    });
    const next = value.length
      ? (value.at(-1) as Record<string, unknown>).cursor
      : undefined;
    return {
      items,
      nextCursor: typeof next === "string" && next ? next : null,
    };
  }

  async listAllJobs(serviceId: string): Promise<readonly RenderJob[]> {
    const all: RenderJob[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.listJobs(serviceId, cursor);
      all.push(...page.items);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return Object.freeze(all);
  }

  async listLogs(input: {
    ownerId: string;
    resourceId: string;
    startTime: string;
    endTime: string;
  }): Promise<readonly RenderLog[]> {
    const url = new URL(`${origin}/logs`);
    url.searchParams.set("ownerId", input.ownerId);
    url.searchParams.set("resource", input.resourceId);
    url.searchParams.set("startTime", input.startTime);
    url.searchParams.set("endTime", input.endTime);
    url.searchParams.set("direction", "backward");
    url.searchParams.set("limit", "100");
    const value = requireSubset(
      await body(
        await this.fetchImpl(url.toString(), { headers: headers(this.token) }),
        "logs",
      ),
      ["logs"],
      "render_logs_response_invalid",
    );
    if (!Array.isArray(value.logs))
      throw new Error("render_logs_response_invalid");
    return Object.freeze(
      value.logs.map((entry) => {
        const log = requireSubset(
          entry,
          ["id", "message", "timestamp"],
          "render_log_response_invalid",
        );
        if (![log.id, log.message, log.timestamp].every(string))
          throw new Error("render_log_response_invalid");
        return log as unknown as RenderLog;
      }),
    );
  }

  async suspend(serviceId: string): Promise<void> {
    const response = await this.fetchImpl(
      `${origin}/services/${encodeURIComponent(serviceId)}/suspend`,
      { method: "POST", headers: headers(this.token) },
    );
    if (response.status !== 202)
      throw new Error(`render_api_suspend_failed:${response.status}`);
  }

  async resume(serviceId: string): Promise<void> {
    const response = await this.fetchImpl(
      `${origin}/services/${encodeURIComponent(serviceId)}/resume`,
      { method: "POST", headers: headers(this.token) },
    );
    if (response.status !== 202)
      throw new Error(`render_api_resume_failed:${response.status}`);
  }

  async getEnv(
    serviceId: string,
    cursor?: string,
  ): Promise<CursorPage<{ key: string; value: string }>> {
    const url = new URL(
      `${origin}/services/${encodeURIComponent(serviceId)}/env-vars`,
    );
    if (cursor) url.searchParams.set("cursor", cursor);
    const value = await body(
      await this.fetchImpl(url.toString(), { headers: headers(this.token) }),
      "env_list",
    );
    if (!Array.isArray(value)) throw new Error("render_env_wrapper_invalid");
    const items = value.map((wrapper) => {
      const item = requireSubset(
        wrapper,
        ["envVar"],
        "render_env_wrapper_invalid",
      );
      const envVar = requireSubset(
        item.envVar,
        ["key", "value"],
        "render_env_var_invalid",
      );
      if (!string(envVar.key) || typeof envVar.value !== "string")
        throw new Error("render_env_var_invalid");
      return envVar as { key: string; value: string };
    });
    const next = value.length
      ? (value.at(-1) as Record<string, unknown>).cursor
      : undefined;
    return {
      items,
      nextCursor: typeof next === "string" && next ? next : null,
    };
  }

  async listAllEnv(
    serviceId: string,
  ): Promise<readonly { key: string; value: string }[]> {
    const all: Array<{ key: string; value: string }> = [];
    let cursor: string | undefined;
    do {
      const page = await this.getEnv(serviceId, cursor);
      all.push(...page.items);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return Object.freeze(all);
  }

  async patchEnvPreservingAll(input: {
    serviceId: string;
    set: Readonly<Record<string, string>>;
    remove: readonly string[];
    expectedBeforeSha256?: string;
    expectedAfterSha256?: string;
  }): Promise<EnvironmentMutationOutcome> {
    const before = canonicalEnv(await this.listAllEnv(input.serviceId));
    const beforeSha256 = digest(before);
    const removed = new Set(input.remove);
    if (
      removed.size !== input.remove.length ||
      input.remove.some(
        (key) =>
          !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) ||
          Object.hasOwn(input.set, key),
      )
    )
      throw new Error("render_api_env_contract_invalid");
    const merged = new Map(before.map(({ key, value }) => [key, value]));
    for (const key of removed) merged.delete(key);
    for (const [key, value] of Object.entries(input.set))
      merged.set(key, value);
    const after = canonicalEnv(
      [...merged].map(([key, value]) => ({ key, value })),
    );
    const afterSha256 = digest(after);
    if (
      beforeSha256 === input.expectedAfterSha256 &&
      afterSha256 === beforeSha256
    )
      return appliedEnvironment(before, beforeSha256, true);
    if (
      input.expectedBeforeSha256 !== undefined &&
      beforeSha256 !== input.expectedBeforeSha256
    )
      return { status: "conflict", observedEnvironmentSha256: beforeSha256 };
    if (
      input.expectedAfterSha256 !== undefined &&
      afterSha256 !== input.expectedAfterSha256
    )
      throw new Error("render_api_env_contract_invalid");

    let expected = before;
    const operations = [
      ...[...removed].sort().map((key) => ({ key, value: undefined })),
      ...Object.entries(input.set)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => ({ key, value })),
    ];
    for (const operation of operations) {
      const observed = canonicalEnv(await this.listAllEnv(input.serviceId));
      if (digest(observed) !== digest(expected))
        return {
          status: "conflict",
          observedEnvironmentSha256: digest(observed),
        };
      const next = new Map(expected.map(({ key, value }) => [key, value]));
      const existed = next.has(operation.key);
      if (operation.value === undefined) next.delete(operation.key);
      else next.set(operation.key, operation.value);
      expected = canonicalEnv(
        [...next].map(([key, value]) => ({ key, value })),
      );
      let response: Response;
      try {
        response = await this.fetchImpl(
          operation.value !== undefined && !existed
            ? `${origin}/services/${encodeURIComponent(input.serviceId)}/env-vars`
            : `${origin}/services/${encodeURIComponent(input.serviceId)}/env-vars/${encodeURIComponent(operation.key)}`,
          operation.value === undefined
            ? { method: "DELETE", headers: headers(this.token) }
            : {
                method: existed ? "PUT" : "POST",
                headers: headers(this.token, true),
                body: JSON.stringify({
                  ...(!existed ? { key: operation.key } : {}),
                  value: operation.value,
                }),
              },
        );
      } catch {
        return this.observeAmbiguousEnvironment(input.serviceId);
      }
      if (response.status === 409 || response.status === 412) {
        const conflict = canonicalEnv(await this.listAllEnv(input.serviceId));
        return {
          status: "conflict",
          observedEnvironmentSha256: digest(conflict),
        };
      }
      const expectedStatus =
        operation.value === undefined ? 204 : existed ? 200 : 201;
      if (response.status !== expectedStatus) {
        if (response.status >= 500)
          return this.observeAmbiguousEnvironment(input.serviceId);
        throw new Error(
          `render_api_env_key_mutation_failed:${response.status}`,
        );
      }
      let verified: readonly { key: string; value: string }[];
      try {
        verified = canonicalEnv(await this.listAllEnv(input.serviceId));
      } catch {
        return { status: "ambiguous" };
      }
      if (digest(verified) !== digest(expected))
        return {
          status: "conflict",
          observedEnvironmentSha256: digest(verified),
        };
    }
    return appliedEnvironment(expected, beforeSha256, false);
  }

  private async observeAmbiguousEnvironment(
    serviceId: string,
  ): Promise<EnvironmentMutationOutcome> {
    try {
      const observed = canonicalEnv(await this.listAllEnv(serviceId));
      return {
        status: "ambiguous",
        observedEnvironmentSha256: digest(observed),
      };
    } catch {
      return { status: "ambiguous" };
    }
  }

  async planEnvPatch(input: {
    serviceId: string;
    set: Readonly<Record<string, string>>;
    remove: readonly string[];
    expectedBeforeSha256: string;
  }): Promise<{ environmentSha256: string; keysSha256: string }> {
    const before = canonicalEnv(await this.listAllEnv(input.serviceId));
    if (digest(before) !== input.expectedBeforeSha256)
      throw new Error("render_api_env_concurrent_mutation_detected");
    const merged = new Map(before.map(({ key, value }) => [key, value]));
    for (const key of input.remove) merged.delete(key);
    for (const [key, value] of Object.entries(input.set))
      merged.set(key, value);
    const after = canonicalEnv(
      [...merged].map(([key, value]) => ({ key, value })),
    );
    return {
      environmentSha256: digest(after),
      keysSha256: digest(after.map(({ key }) => key)),
    };
  }

  async patchService(
    serviceId: string,
    value: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    const response = await this.fetchImpl(
      `${origin}/services/${encodeURIComponent(serviceId)}`,
      {
        method: "PATCH",
        headers: headers(this.token, true),
        body: JSON.stringify(value),
      },
    );
    if (response.status !== 200)
      throw new Error(`render_api_service_patch_failed:${response.status}`);
  }
}

const canonicalEnv = (
  values: readonly { readonly key: string; readonly value: string }[],
): readonly { readonly key: string; readonly value: string }[] => {
  const keys = new Set<string>();
  for (const value of values) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value.key) || keys.has(value.key))
      throw new Error("render_api_env_contract_invalid");
    keys.add(value.key);
  }
  return Object.freeze(
    [...values]
      .map(({ key, value }) => ({ key, value }))
      .sort((a, b) => a.key.localeCompare(b.key)),
  );
};

const digest = (value: unknown): string =>
  `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;

const appliedEnvironment = (
  environment: readonly { readonly key: string; readonly value: string }[],
  previousEnvironmentSha256: string,
  replayed: boolean,
): EnvironmentMutationOutcome => ({
  status: "applied",
  previousEnvironmentSha256,
  environmentSha256: digest(environment),
  environmentKeysSha256: digest(environment.map(({ key }) => key)),
  replayed,
});
