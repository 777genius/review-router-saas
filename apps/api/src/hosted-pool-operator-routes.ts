import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { HostedPoolOperatorScope } from "./hosted-pool-operator-authorization.js";

const workspace = z.string().trim().min(1).max(160);
const version = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const schemas = {
  import: z
    .object({
      workspace,
      label: z.string().trim().min(1).max(120),
      authBase64: z.string().min(1).max(1398104),
    })
    .strict(),
  replace: z
    .object({
      workspace,
      accountId: z.string().min(1).max(160),
      expectedGeneration: version,
      expectedHealthVersion: version,
      authBase64: z.string().min(1).max(1398104),
    })
    .strict(),
  pause: z
    .object({
      workspace,
      accountId: z.string().min(1).max(160),
      expectedHealthVersion: version,
    })
    .strict(),
  resume: z
    .object({
      workspace,
      accountId: z.string().min(1).max(160),
      expectedHealthVersion: version,
    })
    .strict(),
  connect: z
    .object({
      workspace,
      repository: z
        .string()
        .regex(/^[^/\s]+\/[^/\s]+$/)
        .max(256),
      expectedRevision: version.nullable(),
    })
    .strict(),
};
export type HostedPoolOperatorCommand = {
  [K in keyof typeof schemas]: {
    readonly action: K;
    readonly input: z.infer<(typeof schemas)[K]>;
  };
}[keyof typeof schemas];
export type HostedPoolOperatorDependencies = {
  authorize(
    credential: string,
    workspace: string,
  ): Promise<HostedPoolOperatorScope>;
  assertEntitled(scope: HostedPoolOperatorScope): Promise<void>;
  status(scope: HostedPoolOperatorScope): Promise<unknown>;
  execute(
    scope: HostedPoolOperatorScope,
    command: HostedPoolOperatorCommand,
    auth?: Uint8Array,
  ): Promise<unknown>;
};

export async function registerHostedPoolOperatorRoutes(
  app: FastifyInstance,
  dependencies: HostedPoolOperatorDependencies,
) {
  const base = "/api/operator/v1/hosted-pool";
  const sendError = (error: unknown, connect = false) => {
    const message = error instanceof Error ? error.message : "";
    if (
      [
        "hosted_pool_binding_conflict",
        "hosted_pool_binding_revision_conflict",
        "hosted_pool_setup_conflict",
        "hosted_pool_binding_activation_conflict",
        "hosted_codex_reconnect_conflict",
        "hosted_pool_account_label_conflict",
        "hosted_account_health_version_conflict",
        "workflow_provisioning_concurrent_transition",
      ].includes(message)
    ) {
      return { status: 409, code: "hosted_pool_conflict" };
    }
    if (
      connect &&
      typeof error === "object" &&
      error !== null &&
      "status" in error &&
      error.status === 403
    ) {
      return {
        status: 409,
        code: "hosted_pool_github_app_permissions_required",
      };
    }
    return message === "hosted_pool_operator_unauthorized"
      ? { status: 401, code: message }
      : message === "hosted_pool_operator_forbidden"
        ? { status: 403, code: message }
        : { status: 409, code: "hosted_pool_operation_failed" };
  };
  const authorize = async (
    header: string | undefined,
    requestedWorkspace: string,
  ) => {
    const match = /^Bearer ([^\s]+)$/.exec(header ?? "");
    const scope = await dependencies.authorize(
      match?.[1] ?? "",
      requestedWorkspace,
    );
    await dependencies.assertEntitled(scope);
    return scope;
  };
  app.get(base, { logLevel: "silent" }, async (request, reply) => {
    const query = z.object({ workspace }).strict().safeParse(request.query);
    if (!query.success)
      return reply
        .code(400)
        .send({ error: { code: "hosted_pool_request_invalid" } });
    try {
      const scope = await authorize(
        request.headers.authorization,
        query.data.workspace,
      );
      return { result: await dependencies.status(scope) };
    } catch (error) {
      const safe = sendError(error);
      return reply.code(safe.status).send({ error: { code: safe.code } });
    }
  });
  for (const action of Object.keys(schemas) as (keyof typeof schemas)[]) {
    app.post(
      `${base}/${action === "connect" ? "connect" : `accounts/${action}`}`,
      { bodyLimit: 1400000, logLevel: "silent" },
      async (request, reply) => {
        const parsed = schemas[action].safeParse(request.body);
        if (!parsed.success)
          return reply
            .code(400)
            .send({ error: { code: "hosted_pool_request_invalid" } });
        let bytes: Buffer | undefined;
        try {
          const scope = await authorize(
            request.headers.authorization,
            parsed.data.workspace,
          );
          if ("authBase64" in parsed.data) {
            bytes = Buffer.from(parsed.data.authBase64, "base64");
            if (
              !bytes.length ||
              bytes.length > 1024 * 1024 ||
              bytes.toString("base64") !== parsed.data.authBase64
            ) {
              return reply
                .code(400)
                .send({ error: { code: "hosted_pool_auth_invalid" } });
            }
          }
          return {
            result: await dependencies.execute(
              scope,
              { action, input: parsed.data } as HostedPoolOperatorCommand,
              bytes,
            ),
          };
        } catch (error) {
          const safe = sendError(error, action === "connect");
          return reply.code(safe.status).send({ error: { code: safe.code } });
        } finally {
          bytes?.fill(0);
          if ("authBase64" in parsed.data) parsed.data.authBase64 = "";
        }
      },
    );
  }
}
