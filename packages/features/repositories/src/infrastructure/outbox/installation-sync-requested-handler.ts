import { z } from "zod";
import {
  OutboxHandlerError,
  type OutboxHandler,
} from "@reviewrouter/features-outbox";
import {
  syncInstallationRepositories,
  type SyncInstallationRepositoriesDependencies,
} from "../../application/use-cases/sync-installation-repositories";

const installationSyncRequestedPayloadSchema = z.object({
  installationId: z.string().min(1),
  reason: z
    .enum(["installation_access_changed", "installation_repositories_changed"])
    .optional(),
});

export function createInstallationSyncRequestedHandler(
  dependencies: SyncInstallationRepositoriesDependencies,
): OutboxHandler {
  return {
    type: "installation.sync_requested",
    version: 1,
    async handle(event) {
      const parsed = installationSyncRequestedPayloadSchema.safeParse(
        event.payload,
      );
      if (!parsed.success) {
        throw new OutboxHandlerError(
          "Invalid installation sync event payload",
          "invalid_event_payload",
          false,
        );
      }

      await syncInstallationRepositories(parsed.data.installationId, {
        github: dependencies.github,
        repositories: dependencies.repositories,
        clock: dependencies.clock,
      });
    },
  };
}
