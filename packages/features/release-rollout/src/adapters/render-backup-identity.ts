import type { BackupIdentity } from "../domain/trusted-rollout-evidence";
import type { RenderFetch } from "./render-api";
import {
  BoundedProviderHttpClient,
  ProviderHttpError,
} from "./bounded-provider-io";

const digest = /^sha256:[a-f0-9]{64}$/u;
const timestamp = (value: string): boolean => {
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
};
export interface ExternalBackupWitness {
  readonly witnessSha256: string;
  readonly sourceResourceId: string;
  readonly internalHostname: string;
  readonly databaseName: string;
  readonly systemIdentifier: string;
  readonly lsn: string;
  readonly capturedAt: string;
  readonly recoveryWindowEndsAt: string;
  readonly dumpSha256: string;
}

export class RenderBackupIdentityAdapter {
  private readonly fetchImpl: RenderFetch;
  constructor(fetchImpl: RenderFetch = fetch) {
    const http = new BoundedProviderHttpClient(fetchImpl);
    this.fetchImpl = (url, init) =>
      http.request("render_recovery_lookup", url, init);
  }
  async capture(input: {
    apiKey: string;
    sourceDatabaseId: string;
    externalWitness: ExternalBackupWitness;
  }): Promise<BackupIdentity> {
    const witness = input.externalWitness;
    if (
      !input.apiKey ||
      !/^dpg-[A-Za-z0-9-]+$/u.test(input.sourceDatabaseId) ||
      witness.sourceResourceId !== input.sourceDatabaseId ||
      !/^[a-z0-9.-]+\.internal$/u.test(witness.internalHostname) ||
      !/^[A-Za-z_][A-Za-z0-9_-]*$/u.test(witness.databaseName) ||
      !/^[0-9]+$/u.test(witness.systemIdentifier) ||
      !/^[0-9A-F]+\/[0-9A-F]+$/u.test(witness.lsn) ||
      !timestamp(witness.capturedAt) ||
      !timestamp(witness.recoveryWindowEndsAt) ||
      !digest.test(witness.witnessSha256) ||
      !digest.test(witness.dumpSha256)
    )
      throw new Error("render_backup_witness_invalid");
    const response = await this.fetchImpl(
      `https://api.render.com/v1/postgres/${encodeURIComponent(input.sourceDatabaseId)}/recovery`,
      {
        headers: {
          Authorization: `Bearer ${input.apiKey}`,
          Accept: "application/json",
        },
      },
    );
    if (!response.ok)
      throw new ProviderHttpError(
        "render_recovery_lookup",
        "response_status",
        response.status,
      );
    let value: Record<string, unknown>;
    try {
      value = (await response.json()) as Record<string, unknown>;
    } catch {
      throw new ProviderHttpError(
        "render_recovery_lookup",
        "response_invalid",
        response.status,
      );
    }
    if (
      typeof value !== "object" ||
      typeof value.recoveryStatus !== "string" ||
      !["AVAILABLE", "BACKUP_NOT_READY", "NOT_AVAILABLE"].includes(
        value.recoveryStatus,
      ) ||
      (value.startsAt !== undefined &&
        (typeof value.startsAt !== "string" || !timestamp(value.startsAt)))
    )
      throw new ProviderHttpError(
        "render_recovery_lookup",
        "response_invalid",
        response.status,
      );
    if (value.recoveryStatus !== "AVAILABLE")
      throw new Error("render_recovery_not_available");
    if (
      value.startsAt &&
      new Date(witness.capturedAt) < new Date(value.startsAt)
    )
      throw new Error("render_backup_witness_outside_recovery_window");
    return Object.freeze({
      renderResourceId: witness.sourceResourceId,
      internalHostname: witness.internalHostname,
      databaseName: witness.databaseName,
      systemIdentifier: witness.systemIdentifier,
      lsn: witness.lsn,
      capturedAt: witness.capturedAt,
      recoveryWindowStartsAt:
        typeof value.startsAt === "string" ? value.startsAt : null,
      recoveryWindowEndsAt: witness.recoveryWindowEndsAt,
      dumpSha256: witness.dumpSha256,
      externalWitnessSha256: witness.witnessSha256,
      recoveryStatus: "AVAILABLE",
    });
  }
}
