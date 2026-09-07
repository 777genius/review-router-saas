import { activateConfirmedHostedPoolBindingAfterWorkflowMerge as activateHostedBinding } from "@reviewrouter/features-workflow-provisioning";
import { resolveReviewRouterCodexRotatingTrustedActionRefs } from "@reviewrouter/platform-config";
import { switchRepositoryConfigurationAuthMode } from "./prisma-hosted-pool-mutations";

export type {
  VerifiedHostedPoolWorkflow,
  HostedPoolWorkflowActivationResult,
} from "@reviewrouter/features-workflow-provisioning";

export function activateConfirmedHostedPoolBindingAfterWorkflowMerge(
  input: Omit<
    Parameters<typeof activateHostedBinding>[0],
    "trustedActionRefs" | "switchConfiguration"
  >,
) {
  return activateHostedBinding({
    ...input,
    trustedActionRefs: resolveReviewRouterCodexRotatingTrustedActionRefs(),
    switchConfiguration: switchRepositoryConfigurationAuthMode,
  });
}
