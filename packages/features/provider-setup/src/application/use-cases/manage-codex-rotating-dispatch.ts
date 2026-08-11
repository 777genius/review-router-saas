import {
  codexRotatingActivationSchema,
  codexRotatingDispatchOutcomeSchema,
  codexRotatingDispatchRequestSchema,
  codexRotatingSetupStatusRequestSchema,
  type CodexRotatingSetupStatus,
} from "../../domain/codex-rotating-setup-payload-claim";
import type { CodexRotatingSetupPayloadClaimPort } from "../ports/codex-rotating-setup-payload-claim-port";

export function authorizeCodexRotatingSetupDispatch(
  input: unknown,
  dependencies: { readonly claims: CodexRotatingSetupPayloadClaimPort },
) {
  return dependencies.claims.authorizeDispatch(
    codexRotatingDispatchRequestSchema.parse(input),
  );
}

export function recordCodexRotatingSetupDispatchOutcome(
  input: unknown,
  dependencies: { readonly claims: CodexRotatingSetupPayloadClaimPort },
) {
  const parsed = codexRotatingDispatchOutcomeSchema.parse(input);
  return dependencies.claims.recordDispatchOutcome({
    claimId: parsed.claimId,
    attemptId: parsed.attemptId,
    outcome: parsed.outcome,
    ...(parsed.responseCode ? { responseCode: parsed.responseCode } : {}),
  });
}

export function getCodexRotatingSetupStatus(
  input: unknown,
  dependencies: { readonly claims: CodexRotatingSetupPayloadClaimPort },
): Promise<CodexRotatingSetupStatus> {
  return dependencies.claims.status(
    codexRotatingSetupStatusRequestSchema.parse(input).claimId,
  );
}

export function activateCodexRotatingSetup(
  input: unknown,
  dependencies: { readonly claims: CodexRotatingSetupPayloadClaimPort },
) {
  return dependencies.claims.activate(
    codexRotatingActivationSchema.parse(input),
  );
}
