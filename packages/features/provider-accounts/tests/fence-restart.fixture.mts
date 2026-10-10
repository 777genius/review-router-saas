// Fresh-process readback fixture; only invoked by the guarded disposable PG suite.
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { checkedDatabaseTarget } from "./database-target.mjs";
import { PrismaProviderAccountRepository } from "../src/infrastructure/prisma/prisma-provider-account-repository";
import { snapshotBindingFence } from "../src/domain/provider-account";

const target = checkedDatabaseTarget(process.argv[2] ?? "");
const workspaceId = process.argv[3];
const bindingId = process.argv[4];
assert.ok(workspaceId && bindingId);
const db = new PrismaClient({ adapter: new PrismaPg(target) });
try {
  const row = await new PrismaProviderAccountRepository(db).findBinding({
    workspaceId,
    bindingId,
  });
  assert.ok(row?.binding.pendingFence);
  // Output only the allowlisted intent, never connection/provider descriptors.
  process.stdout.write(
    JSON.stringify(
      snapshotBindingFence({
        workspaceId,
        bindingId,
        operationId: row.binding.pendingFence.operationId,
        policySubject: row.binding.pendingFence.policySubject,
        policyRevision: row.binding.pendingFence.policyRevision,
      }),
    ),
  );
} finally {
  await db.$disconnect();
}
