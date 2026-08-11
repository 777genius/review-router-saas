import type { BackupIdentity } from "../domain/trusted-rollout-evidence";
import type { RenderFetch } from "./render-private-runner";

function exact(
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

export class RenderBackupIdentityAdapter {
  constructor(private readonly fetchImpl: RenderFetch = fetch) {}

  async capture(input: {
    apiKey: string;
    sourceDatabaseId: string;
    expectedBackupId: string;
    expectedPitrIdentity: string;
  }): Promise<BackupIdentity> {
    if (
      !input.apiKey ||
      !/^dpg-[A-Za-z0-9-]+$/u.test(input.sourceDatabaseId) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:/-]{2,255}$/u.test(input.expectedBackupId) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:/-]{2,255}$/u.test(input.expectedPitrIdentity)
    )
      throw new Error("render_backup_identity_context_invalid");
    const response = await this.fetchImpl(
      `https://api.render.com/v1/postgres/${input.sourceDatabaseId}/backups/${input.expectedBackupId}`,
      {
        headers: {
          Authorization: `Bearer ${input.apiKey}`,
          Accept: "application/json",
        },
      },
    );
    if (!response.ok)
      throw new Error(
        `render_backup_identity_lookup_failed:${response.status}`,
      );
    const value = (await response.json()) as unknown;
    if (
      !exact(value, ["id", "databaseId", "status", "createdAt", "pitr"]) ||
      value.id !== input.expectedBackupId ||
      value.databaseId !== input.sourceDatabaseId ||
      value.status !== "available" ||
      typeof value.createdAt !== "string" ||
      new Date(value.createdAt).toISOString() !== value.createdAt ||
      !exact(value.pitr, ["identity"]) ||
      value.pitr.identity !== input.expectedPitrIdentity
    )
      throw new Error("render_backup_identity_response_invalid");
    return Object.freeze({
      backupId: input.expectedBackupId,
      pitrIdentity: input.expectedPitrIdentity,
      capturedAt: value.createdAt,
    });
  }
}
