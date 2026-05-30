import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  FinalizedLease,
  LeaseAcquireResult,
  LeaseStoreCapabilities,
  LeaseStorePort,
  WritebackCommitResult,
} from "@reviewrouter/subscription-runtime-core";

const storageVersion = "local-file-lease-store-v1";

export const localFileLeaseStoreCapabilities: LeaseStoreCapabilities = {
  leaseStoreId: "local-file-lease-store",
  supportsTtl: true,
  supportsFinalize: true,
  supportsWritebackCommit: true,
};

export type LocalFileLeaseStoreOptions = {
  readonly rootDir: string;
  readonly now?: () => Date;
};

type LeaseState =
  | "active"
  | "finalized"
  | "writeback_started"
  | "committed"
  | "released";

type PersistedLeaseRecord = {
  readonly storageVersion: typeof storageVersion;
  readonly leaseId: string;
  readonly providerInstanceId: string;
  readonly runId: string;
  readonly attempt: number;
  readonly restoredGenerationHash: string;
  readonly state: LeaseState;
  readonly acquiredAt: string;
  readonly expiresAt: string;
  readonly finalizedAt?: string;
  readonly writebackStartedAt?: string;
  readonly committedAt?: string;
  readonly releasedAt?: string;
  readonly releaseReason?: string;
  readonly keyId?: string;
  readonly nextGenerationHash?: string;
  readonly idempotencyKey?: string;
};

export class LocalFileLeaseStore implements LeaseStorePort {
  readonly leaseStoreId = localFileLeaseStoreCapabilities.leaseStoreId;
  readonly capabilities = localFileLeaseStoreCapabilities;

  constructor(private readonly options: LocalFileLeaseStoreOptions) {}

  async acquire(input: {
    readonly providerInstanceId: string;
    readonly runId: string;
    readonly attempt: number;
    readonly ttlMs: number;
    readonly restoredGenerationHash: string;
  }): Promise<LeaseAcquireResult> {
    if (input.ttlMs <= 0) {
      throw new Error("local_file_lease_invalid_ttl");
    }

    await this.ensureDirs();
    const now = this.now();
    const active = await this.readActive(input.providerInstanceId);
    if (active && !isExpired(active, now)) {
      if (active.restoredGenerationHash !== input.restoredGenerationHash) {
        return {
          status: "stale",
          safeMessage: "A newer provider session generation is already leased.",
        };
      }
      return {
        status: "denied",
        safeMessage: "Provider session refresh is already leased.",
      };
    }

    if (active) {
      await this.removeActiveIfMatches(active);
    }

    const record = makeLeaseRecord({
      providerInstanceId: input.providerInstanceId,
      runId: input.runId,
      attempt: input.attempt,
      restoredGenerationHash: input.restoredGenerationHash,
      now,
      expiresAt: new Date(now.getTime() + input.ttlMs),
    });

    await this.writeLeaseRecord(record, { exclusive: true });
    try {
      await this.writeActiveRecord(record, { exclusive: true });
    } catch (error) {
      await rm(this.leaseRecordPath(record.leaseId), { force: true });
      if (isAlreadyExistsError(error)) {
        return {
          status: "denied",
          safeMessage: "Provider session refresh is already leased.",
        };
      }
      throw error;
    }

    return {
      status: "granted",
      leaseId: record.leaseId,
      expiresAt: new Date(record.expiresAt),
    };
  }

  async finalize(input: {
    readonly leaseId: string;
    readonly restoredGenerationHash: string;
  }): Promise<FinalizedLease> {
    const record = await this.requireLeaseRecord(input.leaseId);
    if (record.restoredGenerationHash !== input.restoredGenerationHash) {
      throw new Error("local_file_lease_generation_hash_mismatch");
    }
    if (record.state === "committed") {
      return {
        leaseId: record.leaseId,
        restoredGenerationHash: record.restoredGenerationHash,
      };
    }

    await this.persistLeaseTransition({
      ...record,
      state: "finalized",
      finalizedAt: this.now().toISOString(),
    });

    return {
      leaseId: record.leaseId,
      restoredGenerationHash: record.restoredGenerationHash,
    };
  }

  async markWritebackStarted(input: {
    readonly leaseId: string;
    readonly keyId?: string;
  }): Promise<void> {
    const record = await this.requireLeaseRecord(input.leaseId);
    if (record.state === "committed") {
      return;
    }

    await this.persistLeaseTransition({
      ...record,
      state: "writeback_started",
      writebackStartedAt: this.now().toISOString(),
      ...(input.keyId ? { keyId: input.keyId } : {}),
    });
  }

  async markWritebackCommitted(input: {
    readonly leaseId: string;
    readonly nextGenerationHash: string;
    readonly idempotencyKey: string;
  }): Promise<WritebackCommitResult> {
    const record = await this.requireLeaseRecord(input.leaseId);
    if (record.state === "committed") {
      if (
        record.nextGenerationHash === input.nextGenerationHash &&
        record.idempotencyKey === input.idempotencyKey
      ) {
        return { status: "idempotent_replay" };
      }
      return {
        status: "stale_generation",
        safeMessage: "Lease was already committed with different writeback metadata.",
      };
    }

    const committed = {
      ...record,
      state: "committed" as const,
      committedAt: this.now().toISOString(),
      nextGenerationHash: input.nextGenerationHash,
      idempotencyKey: input.idempotencyKey,
    };
    await this.persistLeaseTransition(committed);
    await this.removeActiveIfMatches(committed);
    return { status: "committed" };
  }

  async release(input: {
    readonly leaseId: string;
    readonly reason: string;
  }): Promise<void> {
    const record = await this.readLeaseRecord(input.leaseId);
    if (!record || record.state === "committed") {
      return;
    }

    const released = {
      ...record,
      state: "released" as const,
      releasedAt: this.now().toISOString(),
      releaseReason: input.reason,
    };
    await this.persistLeaseTransition(released);
    await this.removeActiveIfMatches(released);
  }

  private async persistLeaseTransition(
    record: PersistedLeaseRecord,
  ): Promise<void> {
    await this.writeLeaseRecord(record, { exclusive: false });
    const active = await this.readActive(record.providerInstanceId);
    if (active?.leaseId === record.leaseId) {
      await this.writeActiveRecord(record, { exclusive: false });
    }
  }

  private async requireLeaseRecord(
    leaseId: string,
  ): Promise<PersistedLeaseRecord> {
    const record = await this.readLeaseRecord(leaseId);
    if (!record) {
      throw new Error("local_file_lease_not_found");
    }
    return record;
  }

  private async readActive(
    providerInstanceId: string,
  ): Promise<PersistedLeaseRecord | null> {
    return this.readRecord(this.activePath(providerInstanceId));
  }

  private async readLeaseRecord(
    leaseId: string,
  ): Promise<PersistedLeaseRecord | null> {
    return this.readRecord(this.leaseRecordPath(leaseId));
  }

  private async readRecord(path: string): Promise<PersistedLeaseRecord | null> {
    try {
      return parseLeaseRecord(await readFile(path, "utf8"));
    } catch (error) {
      if (isMissingFileError(error)) return null;
      throw error;
    }
  }

  private async writeActiveRecord(
    record: PersistedLeaseRecord,
    options: { readonly exclusive: boolean },
  ): Promise<void> {
    await this.writeRecord(this.activePath(record.providerInstanceId), record, options);
  }

  private async writeLeaseRecord(
    record: PersistedLeaseRecord,
    options: { readonly exclusive: boolean },
  ): Promise<void> {
    await this.writeRecord(this.leaseRecordPath(record.leaseId), record, options);
  }

  private async writeRecord(
    path: string,
    record: PersistedLeaseRecord,
    options: { readonly exclusive: boolean },
  ): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const serialized = `${JSON.stringify(record, null, 2)}\n`;
    if (options.exclusive) {
      await writeFile(path, serialized, { flag: "wx", mode: 0o600 });
      return;
    }

    const tempPath = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(tempPath, serialized, { mode: 0o600 });
    await rename(tempPath, path);
  }

  private async removeActiveIfMatches(
    record: Pick<PersistedLeaseRecord, "providerInstanceId" | "leaseId">,
  ): Promise<void> {
    const active = await this.readActive(record.providerInstanceId);
    if (active?.leaseId === record.leaseId) {
      await rm(this.activePath(record.providerInstanceId), { force: true });
    }
  }

  private async ensureDirs(): Promise<void> {
    await mkdir(this.activeDir(), { recursive: true, mode: 0o700 });
    await mkdir(this.leaseRecordDir(), { recursive: true, mode: 0o700 });
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private activeDir(): string {
    return join(this.options.rootDir, "leases", "active");
  }

  private leaseRecordDir(): string {
    return join(this.options.rootDir, "leases", "records");
  }

  private activePath(providerInstanceId: string): string {
    return join(this.activeDir(), `${hashText(providerInstanceId)}.json`);
  }

  private leaseRecordPath(leaseId: string): string {
    return join(this.leaseRecordDir(), `${hashText(leaseId)}.json`);
  }
}

function makeLeaseRecord(input: {
  readonly providerInstanceId: string;
  readonly runId: string;
  readonly attempt: number;
  readonly restoredGenerationHash: string;
  readonly now: Date;
  readonly expiresAt: Date;
}): PersistedLeaseRecord {
  const leaseId = [
    "local-file-lease",
    hashText(
      [
        input.providerInstanceId,
        input.runId,
        String(input.attempt),
        input.restoredGenerationHash,
        randomBytes(16).toString("hex"),
      ].join("\0"),
    ),
  ].join(":");

  return {
    storageVersion,
    leaseId,
    providerInstanceId: input.providerInstanceId,
    runId: input.runId,
    attempt: input.attempt,
    restoredGenerationHash: input.restoredGenerationHash,
    state: "active",
    acquiredAt: input.now.toISOString(),
    expiresAt: input.expiresAt.toISOString(),
  };
}

function parseLeaseRecord(value: string): PersistedLeaseRecord {
  const parsed = JSON.parse(value) as Partial<PersistedLeaseRecord>;
  if (
    parsed.storageVersion !== storageVersion ||
    typeof parsed.leaseId !== "string" ||
    typeof parsed.providerInstanceId !== "string" ||
    typeof parsed.runId !== "string" ||
    typeof parsed.attempt !== "number" ||
    typeof parsed.restoredGenerationHash !== "string" ||
    !isLeaseState(parsed.state) ||
    typeof parsed.acquiredAt !== "string" ||
    typeof parsed.expiresAt !== "string"
  ) {
    throw new Error("local_file_lease_invalid_record");
  }

  return {
    storageVersion,
    leaseId: parsed.leaseId,
    providerInstanceId: parsed.providerInstanceId,
    runId: parsed.runId,
    attempt: parsed.attempt,
    restoredGenerationHash: parsed.restoredGenerationHash,
    state: parsed.state,
    acquiredAt: parsed.acquiredAt,
    expiresAt: parsed.expiresAt,
    ...(typeof parsed.finalizedAt === "string"
      ? { finalizedAt: parsed.finalizedAt }
      : {}),
    ...(typeof parsed.writebackStartedAt === "string"
      ? { writebackStartedAt: parsed.writebackStartedAt }
      : {}),
    ...(typeof parsed.committedAt === "string"
      ? { committedAt: parsed.committedAt }
      : {}),
    ...(typeof parsed.releasedAt === "string"
      ? { releasedAt: parsed.releasedAt }
      : {}),
    ...(typeof parsed.releaseReason === "string"
      ? { releaseReason: parsed.releaseReason }
      : {}),
    ...(typeof parsed.keyId === "string" ? { keyId: parsed.keyId } : {}),
    ...(typeof parsed.nextGenerationHash === "string"
      ? { nextGenerationHash: parsed.nextGenerationHash }
      : {}),
    ...(typeof parsed.idempotencyKey === "string"
      ? { idempotencyKey: parsed.idempotencyKey }
      : {}),
  };
}

function isLeaseState(value: unknown): value is LeaseState {
  return (
    value === "active" ||
    value === "finalized" ||
    value === "writeback_started" ||
    value === "committed" ||
    value === "released"
  );
}

function isExpired(record: PersistedLeaseRecord, now: Date): boolean {
  return new Date(record.expiresAt).getTime() <= now.getTime();
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isMissingFileError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function isAlreadyExistsError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "EEXIST"
  );
}
