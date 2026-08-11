import type { CodexRotatingSetupReadinessTarget } from "../../domain/codex-rotating-setup-readiness";
import type { CodexRotatingSetupReadinessPort } from "../ports/codex-rotating-setup-readiness-port";

export function inspectCodexRotatingSetupReadiness(
  target: CodexRotatingSetupReadinessTarget,
  dependencies: { readonly readiness: CodexRotatingSetupReadinessPort },
) {
  return dependencies.readiness.inspectReady(target);
}

export function confirmCodexRotatingSetupReadiness(
  target: CodexRotatingSetupReadinessTarget,
  dependencies: { readonly readiness: CodexRotatingSetupReadinessPort },
) {
  return dependencies.readiness.confirmConfigured(target);
}
