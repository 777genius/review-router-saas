import { canonicalJson } from "./review-run-control-types";

/** Private admission data. Never included in public authorization claims/facts. */
export type ReviewRunRuntimeSnapshot = {
  readonly snapshotVersion: 1;
  readonly configurationSource: "default" | "workspace" | "repository";
  readonly configurationVersion: number;
  /** Opaque normalized safe configuration; production uses the shared strict parser. */
  readonly configurationCanonicalJson: string;
  readonly deadline: string;
  readonly gateway: ReviewRunGatewaySelection | null;
};

/** Pure finite allowance data, independent of SDK/HTTP validation. */
export type ReviewRunGatewayLimits = {
  readonly requests: number;
  readonly concurrency: number;
  readonly requestBytes: number;
  readonly outputBytes: number;
  readonly tokens: number;
};

export function parseReviewRunGatewayLimits(
  value: unknown,
): ReviewRunGatewayLimits {
  const names = [
    "requests",
    "concurrency",
    "requestBytes",
    "outputBytes",
    "tokens",
  ] as const;
  if (!record(value) || !keys(value, names)) fail();
  for (const name of names) {
    const cap = value[name];
    if (typeof cap !== "number" || !Number.isSafeInteger(cap) || cap < 1)
      fail();
  }
  return {
    requests: Number(value.requests),
    concurrency: Number(value.concurrency),
    requestBytes: Number(value.requestBytes),
    outputBytes: Number(value.outputBytes),
    tokens: Number(value.tokens),
  };
}

/** Approved subset, not Gateway's selected-account/epoch result or a capability. */
export type ReviewRunGatewaySelection = {
  readonly providerIndex: number;
  readonly bindingId: string;
  readonly connectionId: string;
  readonly bindingRevision: number;
  readonly policySubject: string;
  readonly policyRevision: number;
  readonly permittedAccountRef: string;
  readonly profileRef: string;
  readonly invocationId: string;
  readonly attemptId: string;
  readonly operationId: string;
  /** Absent only on legacy pins; absence cannot authorize preparation. */
  readonly limits?: ReviewRunGatewayLimits;
};

export function parseReviewRunRuntimeSnapshot(
  value: string | null | undefined,
): ReviewRunRuntimeSnapshot | null {
  if (value === null || value === undefined) return null;
  if (new TextEncoder().encode(value).byteLength > 32_768) fail();
  const parsed: unknown = JSON.parse(value);
  if (
    !record(parsed) ||
    !keys(parsed, [
      "snapshotVersion",
      "configurationSource",
      "configurationVersion",
      "configurationCanonicalJson",
      "deadline",
      "gateway",
    ])
  )
    fail();
  const { configurationSource, configurationVersion, deadline } = parsed;
  if (
    parsed.snapshotVersion !== 1 ||
    (configurationSource !== "default" &&
      configurationSource !== "workspace" &&
      configurationSource !== "repository") ||
    !revision(configurationVersion) ||
    typeof deadline !== "string" ||
    !Number.isFinite(Date.parse(deadline)) ||
    new Date(deadline).toISOString() !== deadline
  )
    fail();
  const configurationCanonicalJson = parsed.configurationCanonicalJson;
  if (
    typeof configurationCanonicalJson !== "string" ||
    new TextEncoder().encode(configurationCanonicalJson).byteLength > 24_576
  )
    fail();
  const configuration: unknown = JSON.parse(configurationCanonicalJson);
  if (
    !record(configuration) ||
    canonicalJson(configuration) !== configurationCanonicalJson
  )
    fail();
  let gateway: ReviewRunGatewaySelection | null = null;
  if (parsed.gateway === null) {
    // Legacy provider configuration has no gateway selection.
  } else {
    const row = parsed.gateway;
    if (
      !record(row) ||
      !keys(row, [
        "providerIndex",
        "bindingId",
        "connectionId",
        "bindingRevision",
        "policySubject",
        "policyRevision",
        "permittedAccountRef",
        "profileRef",
        "invocationId",
        "attemptId",
        "operationId",
        ...("limits" in row ? ["limits"] : []),
      ])
    )
      fail();
    for (const key of [
      "bindingId",
      "connectionId",
      "policySubject",
      "permittedAccountRef",
      "profileRef",
      "invocationId",
      "attemptId",
      "operationId",
    ]) {
      if (!reference(row[key])) fail();
    }
    if (
      typeof row.providerIndex !== "number" ||
      !Number.isInteger(row.providerIndex) ||
      row.providerIndex < 0 ||
      row.providerIndex > 15 ||
      row.policySubject !== row.bindingId ||
      !revision(row.bindingRevision) ||
      !revision(row.policyRevision)
    )
      fail();
    // Fields were bounded/checked above; construct a detached primitive projection.
    gateway = {
      providerIndex: row.providerIndex,
      bindingId: String(row.bindingId),
      connectionId: String(row.connectionId),
      bindingRevision: row.bindingRevision,
      policySubject: String(row.policySubject),
      policyRevision: row.policyRevision,
      permittedAccountRef: String(row.permittedAccountRef),
      profileRef: String(row.profileRef),
      invocationId: String(row.invocationId),
      attemptId: String(row.attemptId),
      operationId: String(row.operationId),
      ...("limits" in row
        ? { limits: parseReviewRunGatewayLimits(row.limits) }
        : {}),
    };
  }
  if (canonicalJson(parsed) !== value) fail();
  return {
    snapshotVersion: 1,
    configurationSource,
    configurationVersion,
    configurationCanonicalJson,
    deadline,
    gateway,
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function keys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  return (
    Object.keys(value).length === expected.length &&
    expected.every((key) => key in value)
  );
}
function reference(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value)
  );
}
function revision(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 2_147_483_647
  );
}
function fail(): never {
  throw new Error("review_run_runtime_snapshot_invalid");
}
