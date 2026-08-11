import {
  RolloutStep,
  sha256Canonical,
  type RunnerIdentity,
  type StepReceipt,
} from "../domain/release-rollout";

const apiOrigin = "https://api.render.com/v1";
const immutableDigest = /^sha256:[a-f0-9]{64}$/u;
const safeIdentifier = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,255}$/u;

export interface RenderRunnerRequest {
  readonly ownerId: string;
  readonly repository: string;
  readonly runId: string;
  readonly runAttempt: number;
  readonly commitSha: string;
  readonly jitLabel: string;
  readonly baseServiceId: string;
  readonly baseDeployId: string;
  readonly imageDigest: string;
  readonly apiKey: string;
}

export interface RenderFetch {
  (input: string, init?: RequestInit): Promise<Response>;
}

function requiredIdentifier(value: string, label: string): void {
  if (!safeIdentifier.test(value))
    throw new Error(`render_runner_${label}_invalid`);
}

function validate(request: RenderRunnerRequest): void {
  for (const [value, label] of [
    [request.ownerId, "owner"],
    [request.repository, "repository"],
    [request.runId, "run_id"],
    [request.jitLabel, "label"],
    [request.baseServiceId, "service"],
    [request.baseDeployId, "deploy"],
  ] as const)
    requiredIdentifier(value, label);
  if (!Number.isSafeInteger(request.runAttempt) || request.runAttempt < 1)
    throw new Error("render_runner_attempt_invalid");
  if (!/^[a-f0-9]{40}$/u.test(request.commitSha))
    throw new Error("render_runner_commit_invalid");
  if (!immutableDigest.test(request.imageDigest))
    throw new Error("render_runner_mutable_artifact_rejected");
  if (!request.apiKey) throw new Error("render_runner_api_key_missing");
}

async function responseJson(
  response: Response,
  operation: string,
): Promise<unknown> {
  if (!response.ok)
    throw new Error(`render_runner_${operation}_failed:${response.status}`);
  try {
    return await response.json();
  } catch {
    throw new Error(`render_runner_${operation}_response_invalid`);
  }
}

function exactObject(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

export class RenderPrivateRunnerAdapter {
  constructor(private readonly fetchImpl: RenderFetch = fetch) {}

  async provision(request: RenderRunnerRequest): Promise<{
    identity: RunnerIdentity;
    receipt: StepReceipt;
    jobId: string;
  }> {
    validate(request);
    const serviceResponse = await this.fetchImpl(
      `${apiOrigin}/services/${encodeURIComponent(request.baseServiceId)}`,
      {
        headers: {
          Authorization: `Bearer ${request.apiKey}`,
          Accept: "application/json",
        },
      },
    );
    const service = await responseJson(serviceResponse, "service_lookup");
    if (
      !exactObject(service, ["id", "ownerId", "serviceDetails", "image"]) ||
      service.id !== request.baseServiceId ||
      service.ownerId !== request.ownerId ||
      !exactObject(service.serviceDetails, ["runtime", "deployId"]) ||
      service.serviceDetails.runtime !== "image" ||
      service.serviceDetails.deployId !== request.baseDeployId ||
      !exactObject(service.image, ["digest"]) ||
      service.image.digest !== request.imageDigest
    )
      throw new Error("render_runner_base_artifact_mismatch");

    const startCommand = [
      "node",
      "/runner/bootstrap.mjs",
      "--repository",
      request.repository,
      "--run-id",
      request.runId,
      "--run-attempt",
      String(request.runAttempt),
      "--sha",
      request.commitSha,
      "--label",
      request.jitLabel,
    ].join(" ");
    if (!/^[A-Za-z0-9 ./_-]+$/u.test(startCommand))
      throw new Error("render_runner_start_command_unsafe");
    const createResponse = await this.fetchImpl(
      `${apiOrigin}/services/${encodeURIComponent(request.baseServiceId)}/jobs`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${request.apiKey}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ startCommand, planId: request.baseDeployId }),
      },
    );
    const created = await responseJson(createResponse, "create");
    if (
      !exactObject(created, [
        "id",
        "serviceId",
        "status",
        "startCommand",
        "deployId",
        "imageDigest",
      ]) ||
      typeof created.id !== "string" ||
      !safeIdentifier.test(created.id) ||
      created.serviceId !== request.baseServiceId ||
      created.status !== "pending" ||
      created.startCommand !== startCommand ||
      created.deployId !== request.baseDeployId ||
      created.imageDigest !== request.imageDigest
    )
      throw new Error("render_runner_create_response_invalid");
    const runnerName = `rr-${request.runId}-${request.runAttempt}`;
    const identity: RunnerIdentity = Object.freeze({
      repository: request.repository,
      runId: request.runId,
      runAttempt: request.runAttempt,
      commitSha: request.commitSha,
      jitLabel: request.jitLabel,
      runnerName,
      baseServiceId: request.baseServiceId,
      baseDeployId: request.baseDeployId,
      imageDigest: request.imageDigest,
    });
    return {
      jobId: created.id,
      identity,
      receipt: Object.freeze({
        step: RolloutStep.ProvisionPrivateRunner,
        receiptId: `render-job-${created.id}`,
        observedAt: new Date().toISOString(),
        payloadSha256: `sha256:${sha256Canonical(identity)}`,
      }),
    };
  }

  async cleanup(
    request: Pick<RenderRunnerRequest, "apiKey" | "baseServiceId"> & {
      jobId: string;
    },
  ): Promise<
    StepReceipt & {
      cleanup: {
        renderJobTerminal: true;
        workspaceRemoved: true;
        bootstrapCredentialsAbsent: true;
        observedAt: string;
      };
    }
  > {
    requiredIdentifier(request.baseServiceId, "service");
    requiredIdentifier(request.jobId, "job");
    const response = await this.fetchImpl(
      `${apiOrigin}/services/${encodeURIComponent(request.baseServiceId)}/jobs/${encodeURIComponent(request.jobId)}`,
      {
        headers: {
          Authorization: `Bearer ${request.apiKey}`,
          Accept: "application/json",
        },
      },
    );
    const job = await responseJson(response, "cleanup_observation");
    if (
      !exactObject(job, ["id", "serviceId", "status", "cleanupVerified"]) ||
      job.id !== request.jobId ||
      job.serviceId !== request.baseServiceId ||
      !["succeeded", "failed", "canceled", "timed_out"].includes(
        String(job.status),
      ) ||
      job.cleanupVerified !== true
    )
      throw new Error("render_runner_cleanup_unproven");
    const observedAt = new Date().toISOString();
    return Object.freeze({
      step: RolloutStep.CleanupEphemeralRunner,
      receiptId: `render-cleanup-${request.jobId}`,
      observedAt,
      payloadSha256: `sha256:${sha256Canonical(job)}`,
      cleanup: {
        renderJobTerminal: true as const,
        workspaceRemoved: true as const,
        bootstrapCredentialsAbsent: true as const,
        observedAt,
      },
    });
  }
}
