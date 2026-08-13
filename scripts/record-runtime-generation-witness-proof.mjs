#!/usr/bin/env node
import { createPrismaClient } from "@reviewrouter/platform-db";
import { verifyRuntimeGenerationWitness } from "./verify-runtime-generation-witness.mjs";

const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`runtime_generation_proof_required:${name}`);
  return value;
};

export async function recordRuntimeGenerationWitnessProof(env = process.env) {
  const recoveryWitnessSha256 = verifyRuntimeGenerationWitness(env);
  const rolloutId = required("REVIEW_ROUTER_RUNTIME_ROLLOUT_ID");
  const runtimeRole = required("REVIEW_ROUTER_RUNTIME_ROLE");
  const releaseCommitSha = required("REVIEW_ROUTER_RUNTIME_RELEASE_COMMIT_SHA");
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{2,255}$/u.test(rolloutId) ||
    !["web", "api", "worker"].includes(runtimeRole) ||
    !/^[a-f0-9]{40}$/u.test(releaseCommitSha)
  )
    throw new Error("runtime_generation_proof_identity_invalid");
  const prisma = createPrismaClient({ databaseUrl: required("DATABASE_URL") });
  try {
    await prisma.$queryRawUnsafe(
      "SELECT public.reviewrouter_record_runtime_generation_witness_proof($1,$2,$3,$4)",
      rolloutId,
      runtimeRole,
      releaseCommitSha,
      recoveryWitnessSha256,
    );
  } finally {
    await prisma.$disconnect();
  }
}

if (import.meta.url === `file://${process.argv[1]}`)
  await recordRuntimeGenerationWitnessProof();
