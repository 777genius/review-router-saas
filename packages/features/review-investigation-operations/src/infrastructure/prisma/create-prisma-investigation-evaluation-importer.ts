import type { PrismaClient } from "@prisma/client";
import type {
  InvestigationEvaluationClockPort,
  InvestigationOperationsDigestPort,
} from "../../application/ports/operations-ports";
import { ImportSignedInvestigationEvaluation } from "../../application/use-cases/import-signed-investigation-evaluation";
import { ConfiguredEd25519InvestigationEvaluationVerifier } from "../crypto/configured-ed25519-investigation-evaluation-verifier";
import { PrismaInvestigationEvaluationRepository } from "./prisma-investigation-evaluation-repository";

export function createPrismaInvestigationEvaluationImporter(input: {
  readonly prisma: PrismaClient;
  readonly publicKeysJson: string;
  readonly digest: InvestigationOperationsDigestPort;
  readonly clock: InvestigationEvaluationClockPort;
}): ImportSignedInvestigationEvaluation {
  const signatures = ConfiguredEd25519InvestigationEvaluationVerifier.fromJson(
    input.publicKeysJson,
  );
  return new ImportSignedInvestigationEvaluation(
    signatures,
    new PrismaInvestigationEvaluationRepository(input.prisma, {
      signatures,
      clock: input.clock,
    }),
    input.digest,
    input.clock,
  );
}
