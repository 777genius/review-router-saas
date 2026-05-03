export type InstallationSyncReason =
  | "installation_access_changed"
  | "installation_repositories_changed"
  | "manual_dashboard_sync";

export type InstallationSyncRequest = {
  readonly githubInstallationId: string;
  readonly deliveryId: string;
  readonly reason: InstallationSyncReason;
  readonly occurredAt: Date;
};

export interface InstallationSyncRequestPort {
  requestInstallationSync(
    input: InstallationSyncRequest,
  ): Promise<{ readonly created: boolean }>;
}
