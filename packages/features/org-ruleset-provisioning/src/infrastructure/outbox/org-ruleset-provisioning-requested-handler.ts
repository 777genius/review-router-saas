import { z } from "zod";
import {
  OutboxHandlerError,
  type OutboxHandler,
} from "@reviewrouter/features-outbox";
import {
  provisionOrgRulesetRequiredWorkflow,
  type ProvisionOrgRulesetRequiredWorkflowInput,
} from "../../application/use-cases/provision-org-ruleset-required-workflow";
import type { OrgRulesetProvisioningRepositoryPort } from "../../application/ports/org-ruleset-provisioning-repository-port";
import type { OrgRulesetSetupGatewayPort } from "../../application/ports/org-ruleset-setup-gateway-port";
import type { AuditLogRepositoryPort } from "@reviewrouter/features-audit-log";

type Clock = { now(): Date };

const payloadSchema = z.object({ provisioningId: z.string().min(1) });

export function createOrgRulesetProvisioningRequestedHandler(dependencies: {
  readonly provisioning: OrgRulesetProvisioningRepositoryPort;
  readonly createSetupGateway: (
    githubInstallationId: string,
  ) => Promise<OrgRulesetSetupGatewayPort>;
  readonly auditLog?: AuditLogRepositoryPort;
  readonly clock: Clock;
  readonly actionRef: string;
  readonly apiUrl: string;
  readonly runtimeConfigMode: ProvisionOrgRulesetRequiredWorkflowInput["runtimeConfigMode"];
  readonly staticRuntimeEnv?: Readonly<Record<string, string>>;
}): OutboxHandler {
  return {
    type: "org_ruleset.provision_requested",
    version: 1,
    async handle(event) {
      const parsed = payloadSchema.safeParse(event.payload);
      if (!parsed.success) {
        throw new OutboxHandlerError(
          "Invalid org ruleset provisioning event payload",
          "invalid_event_payload",
          false,
        );
      }

      await provisionOrgRulesetRequiredWorkflow(
        {
          provisioningId: parsed.data.provisioningId,
          actionRef: dependencies.actionRef,
          apiUrl: dependencies.apiUrl,
          runtimeConfigMode: dependencies.runtimeConfigMode,
          ...(dependencies.staticRuntimeEnv
            ? { staticRuntimeEnv: dependencies.staticRuntimeEnv }
            : {}),
          attemptedAt: dependencies.clock.now(),
        },
        {
          provisioning: dependencies.provisioning,
          createSetupGateway: dependencies.createSetupGateway,
          ...(dependencies.auditLog ? { auditLog: dependencies.auditLog } : {}),
        },
      );
    },
  };
}
