#!/usr/bin/env node
import { createPrismaClient } from "@reviewrouter/platform-db";
import { verifyRuntimeGenerationWitness } from "./verify-runtime-generation-witness.mjs";

const required = (env, name) => {
  const value = env[name]?.trim();
  if (!value) throw new Error(`runtime_canary_responder_required:${name}`);
  return value;
};

export async function respondRuntimeCanaryChallenges(
  env = process.env,
  signal = { aborted: false },
) {
  const recoveryWitnessSha256 = verifyRuntimeGenerationWitness(env);
  const rolloutId = required(env, "REVIEW_ROUTER_RUNTIME_ROLLOUT_ID");
  const runtimeRole = required(env, "REVIEW_ROUTER_RUNTIME_ROLE");
  const serviceId = required(env, "REVIEW_ROUTER_RUNTIME_SERVICE_ID");
  const deploymentProvenance = required(
    env,
    "REVIEW_ROUTER_RUNTIME_DEPLOYMENT_PROVENANCE",
  );
  const releaseCommitSha = required(
    env,
    "REVIEW_ROUTER_RUNTIME_RELEASE_COMMIT_SHA",
  );
  if (
    !["api", "web", "worker"].includes(runtimeRole) ||
    !/^[a-f0-9]{40}$/u.test(releaseCommitSha) ||
    !/^[a-f0-9]{40,64}$/u.test(deploymentProvenance)
  )
    throw new Error("runtime_canary_responder_identity_invalid");
  const prisma = createPrismaClient({
    databaseUrl: required(env, "DATABASE_URL"),
  });
  try {
    while (!signal.aborted) {
      try {
        await prisma.$queryRawUnsafe(
          "SELECT public.reviewrouter_answer_runtime_canary_challenge($1,$2,$3,$4,$5,$6)",
          rolloutId,
          runtimeRole,
          serviceId,
          deploymentProvenance,
          releaseCommitSha,
          recoveryWitnessSha256,
        );
      } catch {
        // A bounded retry keeps a transient database restart from permanently
        // disabling this runtime role's future challenge responses.
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  } finally {
    await prisma.$disconnect();
  }
}

if (import.meta.url === `file://${process.argv[1]}`)
  await respondRuntimeCanaryChallenges();
