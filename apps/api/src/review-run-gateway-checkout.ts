import { Buffer, isUtf8 } from "node:buffer";
import { performance } from "node:perf_hooks";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  mapConfigToRuntimeEnv,
  parseReviewConfigurationStrict,
} from "@reviewrouter/features-review-config";
import {
  canonicalCodexRotatingProviderId,
  CodexRotatingT0WorkflowSchemaVersion,
} from "@reviewrouter/features-codex-oauth-rotating";
import {
  canonicalJson,
  parseReviewRunRuntimeSnapshot,
  reviewRunGatewayOwnedIdentity,
  type ManageReviewRunAuthorizations,
  type ReviewRunAuthorization,
  type ReviewRunGatewayExecutionBindingPort,
} from "@reviewrouter/features-review-run-control";

/** SCM capability for CI. This seam has no model/provider credential authority. */
export type AccountGatewayCheckoutCapability = Readonly<{
  protocolVersion: 1;
  repository: string;
  headSha: string;
  token: string;
  expiresAt: string;
  permissions: Readonly<{ contents: "read"; pullRequests: "read" }>;
  runtimeConfig: Readonly<{
    protocolVersion: 1;
    configVersion: number;
    runtimeEnv: Readonly<Record<string, string>>;
  }>;
}>;
export type ReviewRunGatewayCheckoutTarget = Readonly<{
  githubInstallationId: string;
  githubRepositoryId: string;
  repositoryFullName: string;
}>;
type ReadIssuer = {
  issueContentsReadToken(input: ReviewRunGatewayCheckoutTarget): Promise<{
    readonly token: string;
    readonly expiresAt: Date;
    readonly permissions: {
      readonly contents: "read";
      readonly pullRequests: "read";
    };
  }>;
};
type CheckoutSelectors = Readonly<{
  providerInstanceId: string;
  workflowSchemaVersion: number;
}>;
class CheckoutFailure extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
  ) {
    super(code);
  }
}

export function createReviewRunGatewayCheckout(input: {
  readonly authorizations: Pick<
    ManageReviewRunAuthorizations,
    "resolveReviewRunAuthorizationToken"
  >;
  readonly bindings: ReviewRunGatewayExecutionBindingPort;
  readonly resolveRepository: (
    authorization: ReviewRunAuthorization,
  ) => Promise<ReviewRunGatewayCheckoutTarget | null>;
  readonly confirmAuthority: (
    token: string,
    authorization: ReviewRunAuthorization,
    target: ReviewRunGatewayCheckoutTarget,
  ) => Promise<boolean>;
  readonly issuer?: ReadIssuer;
  readonly lifecycleObservationAuthors?: readonly string[];
  readonly maxInFlight: number;
  readonly timeoutMs: number;
}) {
  if (
    !Number.isInteger(input.maxInFlight) ||
    input.maxInFlight < 1 ||
    input.maxInFlight > 4 ||
    !Number.isInteger(input.timeoutMs) ||
    input.timeoutMs < 1 ||
    input.timeoutMs > 30_000
  )
    throw new Error("gateway_checkout_policy_invalid");
  const observationAuthors = input.lifecycleObservationAuthors;
  if (
    observationAuthors &&
    (observationAuthors.length > 64 ||
      observationAuthors.some(
        (author) =>
          typeof author !== "string" ||
          !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,99}(?:\[bot\])?$/.test(author),
      ))
  )
    throw new Error("gateway_checkout_observation_authors_invalid");
  const observationAuthorsJson =
    observationAuthors === undefined
      ? undefined
      : JSON.stringify([...observationAuthors]);
  return Object.freeze({
    maxInFlight: input.maxInFlight,
    timeoutMs: input.timeoutMs,
    async issue(
      token: string,
      signal: AbortSignal,
      selectors: CheckoutSelectors,
    ): Promise<AccountGatewayCheckoutCapability> {
      const deadline = performance.now() + input.timeoutMs;
      const checkTime = () => {
        if (signal.aborted || performance.now() >= deadline)
          throw new CheckoutFailure("checkout_cancelled", 503);
      };
      // Await every dependency to settlement. The existing App issuer has no
      // AbortSignal contract; racing it would free capacity with minting still live.
      const checked = async <T>(work: () => Promise<T>): Promise<T> => {
        checkTime();
        const value = await work();
        checkTime();
        return value;
      };
      const issuer = input.issuer;
      if (!issuer) throw new CheckoutFailure("checkout_unavailable", 503);
      const resolve = () =>
        checked(() =>
          input.authorizations.resolveReviewRunAuthorizationToken({ token }),
        );
      const first = await resolve();
      if (first.status !== "valid")
        throw new CheckoutFailure("authorization_denied", 401);
      const auth = first.authorization;
      const canonical = auth.runtimeSnapshotCanonicalJson;
      const snapshot = parseReviewRunRuntimeSnapshot(canonical);
      if (
        !canonical ||
        !snapshot?.gateway?.limits ||
        snapshot.deadline !== auth.maxExpiresAt.toISOString()
      )
        throw new CheckoutFailure("checkout_unavailable", 403);
      const liveBinding = async () => {
        const result = await checked(() =>
          input.bindings.read({
            authorizationId: auth.authorizationId,
            identity: reviewRunGatewayOwnedIdentity(auth),
            runtimeSnapshotCanonicalJson: canonical,
          }),
        );
        // Nullable attachment is intentional: checkout precedes first inference.
        // The existing reader validates pinned config, original use and any attachment.
        if (result.status !== "live")
          throw new CheckoutFailure("authorization_denied", 401);
      };
      const target = await checked(() => input.resolveRepository(auth));
      if (
        !target ||
        target.repositoryFullName.length > 201 ||
        !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(target.repositoryFullName) ||
        !/^[a-f0-9]{40}$/.test(auth.headSha)
      )
        throw new CheckoutFailure("authorization_denied", 401);
      const savedTarget = Object.freeze({ ...target });
      if (
        selectors.providerInstanceId !==
          canonicalCodexRotatingProviderId(savedTarget.githubRepositoryId) ||
        selectors.workflowSchemaVersion !==
          CodexRotatingT0WorkflowSchemaVersion.ClientTriggeredV2
      )
        throw new CheckoutFailure("authorization_denied", 401);
      await liveBinding();
      if (
        !(await checked(() => input.confirmAuthority(token, auth, savedTarget)))
      )
        throw new CheckoutFailure("authorization_denied", 401);
      const capability = await checked(() =>
        issuer.issueContentsReadToken(savedTarget),
      );
      // Copy only the issuer's actual SCM-read primitives, never manufacture expiry.
      const readToken = capability.token;
      const expiry = capability.expiresAt.getTime();
      if (
        typeof readToken !== "string" ||
        !/^[A-Za-z0-9._~-]{1,16384}$/.test(readToken) ||
        !Number.isFinite(expiry) ||
        capability.permissions.contents !== "read" ||
        capability.permissions.pullRequests !== "read" ||
        Object.keys(capability.permissions).sort().join(",") !==
          "contents,pullRequests"
      )
        throw new CheckoutFailure("checkout_unavailable", 503);
      // All issuer/SCM awaits precede the final protected local confirmation.
      const fresh = await resolve();
      if (
        fresh.status !== "valid" ||
        fresh.authorization.authorizationId !== auth.authorizationId ||
        fresh.authorization.version !== auth.version ||
        fresh.authorization.runtimeSnapshotCanonicalJson !== canonical ||
        canonicalJson(reviewRunGatewayOwnedIdentity(fresh.authorization)) !==
          canonicalJson(reviewRunGatewayOwnedIdentity(auth))
      )
        throw new CheckoutFailure("authorization_denied", 401);
      const currentTarget = await checked(() =>
        input.resolveRepository(fresh.authorization),
      );
      if (canonicalJson(currentTarget) !== canonicalJson(savedTarget))
        throw new CheckoutFailure("authorization_denied", 401);
      await liveBinding();
      if (
        !(await checked(() => input.confirmAuthority(token, auth, savedTarget)))
      )
        throw new CheckoutFailure("authorization_denied", 401);
      if (expiry <= Date.now() + 30_000)
        throw new CheckoutFailure("checkout_unavailable", 503);
      // Export only the admitted safe settings after the final authority checks.
      // Never reread current configuration or expose the private gateway selection.
      const configuration = parseReviewConfigurationStrict(
        JSON.parse(snapshot.configurationCanonicalJson),
      );
      const provider = configuration.providers[snapshot.gateway.providerIndex];
      if (
        provider?.authMode !== "codex_account_gateway" ||
        provider.gatewayBindingId !== snapshot.gateway.bindingId ||
        provider.gatewayProfileRef !== snapshot.gateway.profileRef ||
        configuration.providers.find((entry) => entry.kind === "codex") !==
          provider ||
        canonicalJson(configuration) !== snapshot.configurationCanonicalJson
      )
        throw new CheckoutFailure("checkout_unavailable", 403);
      const runtimeEnv = mapConfigToRuntimeEnv(configuration);
      // Protected server observation policy; no lifecycle mutation permission.
      if (observationAuthorsJson !== undefined) {
        runtimeEnv.REVIEW_ROUTER_LIFECYCLE_OBSERVATION_AUTHORS =
          observationAuthorsJson;
      }
      if (
        runtimeEnv.CODEX_MODEL !== provider.model ||
        runtimeEnv.CODEX_REASONING_EFFORT !== provider.reasoningEffort ||
        runtimeEnv.CODEX_AGENTIC_CONTEXT !== String(provider.agenticContext) ||
        runtimeEnv.CODEX_FAST_MODE !== String(provider.fastMode)
      )
        throw new CheckoutFailure("checkout_unavailable", 403);
      checkTime();
      return Object.freeze({
        protocolVersion: 1,
        repository: savedTarget.repositoryFullName,
        headSha: auth.headSha,
        token: readToken,
        expiresAt: new Date(expiry).toISOString(),
        permissions: Object.freeze({ contents: "read", pullRequests: "read" }),
        runtimeConfig: Object.freeze({
          protocolVersion: 1,
          configVersion: snapshot.configurationVersion,
          runtimeEnv: Object.freeze(runtimeEnv),
        }),
      });
    },
  });
}
export type ReviewRunGatewayCheckout = ReturnType<
  typeof createReviewRunGatewayCheckout
>;

export async function registerReviewRunGatewayCheckoutRoute(
  app: FastifyInstance,
  checkout: ReviewRunGatewayCheckout,
) {
  const active = new Set<AbortController>();
  let stopping = false;
  await app.register(async (scope) => {
    type Reservation = {
      controller: AbortController;
      working: boolean;
      finish: () => void;
    };
    const reservations = new WeakMap<FastifyRequest, Reservation>();
    scope.removeContentTypeParser("application/json");
    scope.addContentTypeParser(
      "application/json",
      { parseAs: "buffer", bodyLimit: 512 },
      (_request, body, done) => done(null, body),
    );
    scope.addHook("onRequest", async (request, reply) => {
      reply.header("cache-control", "no-store");
      if (stopping || active.size >= checkout.maxInFlight)
        return reply.code(503).send({ error: { code: "checkout_saturated" } });
      // Reserve before parsing a body or doing token verification, SQL or SCM work.
      const controller = new AbortController();
      active.add(controller);
      let finished = false;
      const cancel = () => {
        controller.abort();
        if (!reservation.working) reservation.finish();
      };
      const timer = setTimeout(() => {
        cancel();
        reply.raw.destroy();
      }, checkout.timeoutMs);
      const reservation: Reservation = {
        controller,
        working: false,
        finish: () => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          request.raw.removeListener("aborted", cancel);
          reply.raw.removeListener("close", cancel);
          active.delete(controller);
        },
      };
      reservations.set(request, reservation);
      request.raw.once("aborted", cancel);
      reply.raw.once("close", cancel);
      if (request.raw.aborted) cancel();
    });
    scope.addHook("onResponse", async (request) => {
      const reservation = reservations.get(request);
      if (reservation && !reservation.working) reservation.finish();
    });
    scope.setErrorHandler((_error, request, reply) => {
      reservations.get(request)?.finish();
      reply
        .header("cache-control", "no-store")
        .code(400)
        .send({ error: { code: "invalid_request" } });
    });
    scope.post(
      "/api/action/v2/account-gateway/checkout",
      { bodyLimit: 512 },
      async (request, reply) => {
        const reservation = reservations.get(request);
        try {
          if (!reservation || reservation.controller.signal.aborted)
            throw new CheckoutFailure("checkout_cancelled", 503);
          reservation.working = true;
          const { token, selectors } = parseRequest(request);
          const result = await checkout.issue(
            token,
            reservation.controller.signal,
            selectors,
          );
          if (reservation.controller.signal.aborted)
            throw new CheckoutFailure("checkout_cancelled", 503);
          return reply.code(200).send(result);
        } catch (error) {
          const failure =
            error instanceof CheckoutFailure
              ? error
              : new CheckoutFailure("checkout_unavailable", 503);
          return reply
            .code(failure.statusCode)
            .send({ error: { code: failure.code } });
        } finally {
          reservation?.finish();
        }
      },
    );
  });
  app.addHook("preClose", async () => {
    stopping = true;
    for (const controller of active) controller.abort();
  });
}

function parseRequest(request: FastifyRequest): {
  token: string;
  selectors: CheckoutSelectors;
} {
  const raw = request.raw.rawHeaders;
  let bytes = 0;
  const counts = new Map<string, number>();
  for (let i = 0; i < raw.length; i += 2) {
    const name = raw[i]!;
    const value = raw[i + 1]!;
    bytes += Buffer.byteLength(name) + Buffer.byteLength(value) + 4;
    const key = name.toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  if (
    bytes > 16_384 ||
    request.raw.url?.includes("?") ||
    counts.get("authorization") !== 1 ||
    counts.get("content-type") !== 1 ||
    (counts.get("content-length") ?? 0) > 1 ||
    (counts.get("transfer-encoding") ?? 0) > 1 ||
    request.headers["content-encoding"] !== undefined ||
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
      request.headers["content-type"] ?? "",
    ) ||
    !Buffer.isBuffer(request.body) ||
    request.body.length > 512 ||
    !isUtf8(request.body)
  )
    throw new CheckoutFailure("invalid_request", 400);
  const header = request.headers.authorization;
  if (
    typeof header !== "string" ||
    header.length > 16_384 ||
    !/^Bearer [A-Za-z0-9._~-]+$/.test(header)
  )
    throw new CheckoutFailure("authorization_denied", 401);
  // Exactly two JSON scalar members. Decode keys before checking uniqueness so
  // escaped duplicate names cannot disappear through JSON.parse's last-wins rule.
  const jsonString =
    '"(?:[^"\\\\\\x00-\\x1f]|\\\\(?:["\\\\/bfnrt]|u[0-9a-fA-F]{4}))*"';
  const jsonNumber = "-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?(?:[eE][+-]?[0-9]+)?";
  const whitespace = "[ \\t\\r\\n]*";
  const member = `(${jsonString})${whitespace}:${whitespace}(${jsonString}|${jsonNumber})`;
  const members = new RegExp(
    `^${whitespace}\\{${whitespace}${member}${whitespace},${whitespace}${member}${whitespace}\\}${whitespace}$`,
  ).exec(request.body.toString("utf8"));
  if (!members || JSON.parse(members[1]!) === JSON.parse(members[3]!))
    throw new CheckoutFailure("invalid_request", 400);
  const selectors: unknown = JSON.parse(request.body.toString("utf8"));
  if (
    typeof selectors !== "object" ||
    !selectors ||
    Object.keys(selectors).sort().join(",") !==
      "providerInstanceId,workflowSchemaVersion" ||
    !("providerInstanceId" in selectors) ||
    typeof selectors.providerInstanceId !== "string" ||
    !("workflowSchemaVersion" in selectors) ||
    typeof selectors.workflowSchemaVersion !== "number" ||
    !Number.isFinite(selectors.workflowSchemaVersion)
  )
    throw new CheckoutFailure("invalid_request", 400);
  return {
    token: header.slice(7),
    selectors: {
      providerInstanceId: selectors.providerInstanceId,
      workflowSchemaVersion: selectors.workflowSchemaVersion,
    },
  };
}
