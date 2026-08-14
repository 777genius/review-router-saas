import { createHash, timingSafeEqual } from "node:crypto";
import type { PrismaClient } from "@reviewrouter/platform-db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

const bodySchema = z.strictObject({
  rolloutId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{2,255}$/u),
  nonce: z.string().regex(/^[a-f0-9]{48}$/u),
  requestedAt: z.iso.datetime(),
  expectedGeneration: z.strictObject({
    systemIdentifier: z.string().regex(/^[0-9]+$/u),
    recoveryWitnessSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  }),
  serviceFacts: z
    .array(
      z.strictObject({
        runtimeRole: z.enum(["api", "web", "worker"]),
        serviceId: z.string().min(1),
        deployId: z.string().min(1),
        deploymentProvenance: z.string().regex(/^[a-f0-9]{40,64}$/u),
        servicePostconditionSha256: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
      }),
    )
    .length(3),
});
type ProofRow = {
  runtimeRole: string;
  databaseRole: string;
  systemIdentifier: string;
  recoveryWitnessSha256: string;
  releaseCommitSha: string;
  provedAt: Date;
  serviceId: string;
  deploymentProvenance: string;
};

export async function registerRuntimeGenerationCanaryRoute(
  app: FastifyInstance,
  input: {
    prisma: PrismaClient;
    tokenSha256: string;
    releaseCommitSha: string;
    expectedRecoveryWitnessSha256: string;
    rolloutStartedAt: Date;
    sleep?: (milliseconds: number) => Promise<void>;
    now?: () => Date;
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
      const requestedAt = Date.parse(body.data.requestedAt);
      const now = (input.now ?? (() => new Date()))().getTime();
      if (
        body.data.expectedGeneration.recoveryWitnessSha256 !==
          input.expectedRecoveryWitnessSha256 ||
        requestedAt < now - 10_000 ||
        requestedAt > now + 5_000 ||
        body.data.serviceFacts.map((item) => item.runtimeRole).join("\0") !==
          "api\0web\0worker"
      )
        return reply
          .header("Cache-Control", "private, no-store")
          .code(400)
          .send({ error: "invalid_request" });
      const [identity] = await input.prisma.$queryRawUnsafe<
        Array<{ systemIdentifier: string }>
      >(
        'SELECT system_identifier::text AS "systemIdentifier" FROM pg_control_system()',
      );
      if (
        !identity ||
        body.data.expectedGeneration.systemIdentifier !==
          identity.systemIdentifier
      )
        throw Object.assign(
          new Error("runtime_generation_canary_identity_invalid"),
          { statusCode: 503 },
        );
      await input.prisma.$queryRawUnsafe(
        "SELECT public.reviewrouter_request_runtime_canary_challenge($1,$2,$3,$4,$5,$6,$7::jsonb)",
        body.data.rolloutId,
        body.data.nonce,
        new Date(requestedAt),
        input.releaseCommitSha,
        identity.systemIdentifier,
        input.expectedRecoveryWitnessSha256,
        JSON.stringify(body.data.serviceFacts),
      );
      let proofs: ProofRow[] = [];
      for (let poll = 0; poll < 8; poll += 1) {
        proofs = await input.prisma.$queryRawUnsafe<ProofRow[]>(
          "SELECT * FROM public.reviewrouter_read_runtime_canary_challenge_proofs($1)",
          body.data.nonce,
        );
        if (proofs.length === 3) break;
        await (
          input.sleep ??
          ((milliseconds) =>
            new Promise((resolve) => setTimeout(resolve, milliseconds)))
        )(1_000);
      }
      const [roundTrip] = await input.prisma.$queryRawUnsafe<
        Array<{ nonce: string }>
      >(
        "SELECT public.reviewrouter_runtime_generation_write_read_canary($1,$2) AS nonce",
        body.data.rolloutId,
        body.data.nonce,
      );
      const roles = ["api", "web", "worker"];
      if (
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
            proof.serviceId !== body.data.serviceFacts[index]?.serviceId ||
            proof.deploymentProvenance !==
              body.data.serviceFacts[index]?.deploymentProvenance ||
            !(proof.provedAt instanceof Date) ||
            proof.provedAt.getTime() < requestedAt ||
            proof.provedAt.getTime() > requestedAt + 10_000,
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
            systemIdentifier: proof.systemIdentifier,
            releaseCommitSha: proof.releaseCommitSha,
            provedAt: proof.provedAt.toISOString(),
            serviceId: proof.serviceId,
            deploymentProvenance: proof.deploymentProvenance,
            nonce: body.data.nonce,
            requestedAt: body.data.requestedAt,
          })),
          expectedGeneration: body.data.expectedGeneration,
          serviceFacts: body.data.serviceFacts,
          writeReadRoundTrip: true,
        });
    },
  );
}
