import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createPrismaClient } from "../packages/platform/db/src/index.js";
import { composeProductionHostedCodexRestoreReconciler } from "../apps/api/src/hosted-codex-relay-composition.js";

export async function executeHostedPoolRestoreOperation(input: {
  readonly command: "ready" | "begin" | "reconcile" | "promote";
  readonly operationId?: string;
  readonly permitToken?: string;
  readonly prisma: ReturnType<typeof createPrismaClient>;
  readonly env: Readonly<Record<string, string | undefined>>;
}) {
  const restore = composeProductionHostedCodexRestoreReconciler({
    prisma: input.prisma,
    env: input.env,
  });
  if (input.command === "ready") {
    await restore.assertRelayReady();
    return { status: "ready" as const };
  }
  if (input.command === "begin") {
    if (!input.permitToken)
      throw new Error("hosted_codex_restore_permit_missing");
    return {
      status: "witnessed" as const,
      operationId: await restore.begin(input.permitToken),
    };
  }
  const operationId = requireOperationId(input.operationId);
  if (input.command === "reconcile") {
    return {
      status: "reconciled" as const,
      operationId,
      ...(await restore.reconcile(operationId)),
    };
  }
  return {
    status: "promoted" as const,
    operationId,
    promoted: await restore.promote(operationId),
  };
}

async function main() {
  const command = process.argv[2] as
    | "ready"
    | "begin"
    | "reconcile"
    | "promote";
  if (!["ready", "begin", "reconcile", "promote"].includes(command)) {
    throw new Error(
      "usage: hosted-pool:restore <ready|begin|reconcile|promote> [operation-id|permit-file]",
    );
  }
  const prisma = createPrismaClient();
  try {
    const result = await executeHostedPoolRestoreOperation({
      command,
      prisma,
      env: process.env,
      ...(command === "begin"
        ? {
            permitToken: (
              await readFile(requiredPath(process.argv[3]), "utf8")
            ).trim(),
          }
        : command === "ready"
          ? {}
          : { operationId: process.argv[3] }),
    });
    // Only bounded state and opaque identifiers are emitted. Permit bytes,
    // credential envelopes, provider responses, and auth bodies are excluded.
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

function requiredPath(value: string | undefined): string {
  if (!value) throw new Error("hosted_codex_restore_permit_file_required");
  return resolve(value);
}

function requireOperationId(value: string | undefined): string {
  const normalized = value?.trim();
  if (
    !normalized ||
    normalized.length > 128 ||
    !/^[A-Za-z0-9_-]+$/u.test(normalized)
  ) {
    throw new Error("hosted_codex_restore_operation_id_invalid");
  }
  return normalized;
}

if (process.argv[1]?.endsWith("hosted-pool-restore-operation.ts")) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "hosted_codex_restore_failed"}\n`,
    );
    process.exitCode = 1;
  });
}
