import { createHash, timingSafeEqual } from "node:crypto";
import type { PrismaClient } from "@reviewrouter/platform-db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

const bodySchema = z.strictObject({
  rolloutId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{2,255}$/u),
  nonce: z.string().regex(/^[a-f0-9]{48}$/u),
  requestedAt: z.iso.datetime(),
});
type ProofRow = {
  runtimeRole: string;
  databaseRole: string;
  systemIdentifier: string;
  recoveryWitnessSha256: string;
  releaseCommitSha: string;
  provedAt: Date;
};

export async function registerRuntimeGenerationCanaryRoute(
  app: FastifyInstance,
  input: {
    prisma: PrismaClient;
    tokenSha256: string;
    releaseCommitSha: string;
    expectedRecoveryWitnessSha256: string;
    rolloutStartedAt: Date;
  },
): Promise<void> {
  if (
    !/^[a-f0-9]{64}$/u.test(input.tokenSha256) ||
    !/^[a-f0-9]{40}$/u.test(input.releaseCommitSha) ||
    !/^[a-f0-9]{64}$/u.test(input.expectedRecoveryWitnessSha256) ||
    !Number.isFinite(input.rolloutStartedAt.getTime())
  )
    throw new Error("runtime_generation_canary_configuration_invalid");
  app.post(
    "/internal/release-canary",
    { bodyLimit: 4_096 },
    async (request, reply) => {
      const token =
        request.headers.authorization?.match(/^Bearer ([^\s]+)$/u)?.[1] ?? "";
      const actualTokenSha256 = createHash("sha256").update(token).digest();
      const expectedTokenSha256 = Buffer.from(input.tokenSha256, "hex");
      if (
        actualTokenSha256.length !== expectedTokenSha256.length ||
        !timingSafeEqual(actualTokenSha256, expectedTokenSha256)
      )
        return reply
          .header("Cache-Control", "private, no-store")
          .code(401)
          .send({ error: "unauthorized" });
      const body = bodySchema.safeParse(request.body);
      if (!body.success)
        return reply
          .header("Cache-Control", "private, no-store")
          .code(400)
          .send({ error: "invalid_request" });
      const [identity] = await input.prisma.$queryRawUnsafe<
        Array<{ systemIdentifier: string }>
      >(
        'SELECT system_identifier::text AS "systemIdentifier" FROM pg_control_system()',
      );
      const proofs = await input.prisma.$queryRawUnsafe<ProofRow[]>(
        "SELECT * FROM public.reviewrouter_read_runtime_generation_witness_proofs($1,$2)",
        body.data.rolloutId,
        input.releaseCommitSha,
      );
      const [roundTrip] = await input.prisma.$queryRawUnsafe<
        Array<{ nonce: string }>
      >(
        "SELECT public.reviewrouter_runtime_generation_write_read_canary($1,$2) AS nonce",
        body.data.rolloutId,
        body.data.nonce,
      );
      const roles = ["api", "web", "worker"];
      if (
        !identity ||
        roundTrip?.nonce !== body.data.nonce ||
        proofs.length !== roles.length ||
        proofs.some(
          (proof, index) =>
            proof.runtimeRole !== roles[index] ||
            proof.databaseRole !== `reviewrouter_${proof.runtimeRole}` ||
            proof.systemIdentifier !== identity.systemIdentifier ||
            proof.recoveryWitnessSha256 !==
              input.expectedRecoveryWitnessSha256 ||
            proof.releaseCommitSha !== input.releaseCommitSha ||
            !(proof.provedAt instanceof Date) ||
            proof.provedAt.getTime() < input.rolloutStartedAt.getTime(),
        )
      )
        throw Object.assign(
          new Error("runtime_generation_canary_proof_invalid"),
          { statusCode: 503 },
        );
      return reply
        .header("Cache-Control", "private, no-store")
        .code(200)
        .send({
          rolloutId: body.data.rolloutId,
          nonce: body.data.nonce,
          requestedAt: body.data.requestedAt,
          observedAt: new Date().toISOString(),
          commitSha: input.releaseCommitSha,
          databaseSystemIdentifier: identity.systemIdentifier,
          recoveryWitnessSha256: input.expectedRecoveryWitnessSha256,
          runtimeWitnessProofs: proofs.map((proof) => ({
            runtimeRole: proof.runtimeRole,
            databaseRole: proof.databaseRole,
            recoveryWitnessSha256: proof.recoveryWitnessSha256,
            provedAt: proof.provedAt.toISOString(),
          })),
          writeReadRoundTrip: true,
        });
    },
  );
}
