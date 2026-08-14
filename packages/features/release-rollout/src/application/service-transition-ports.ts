import type {
  ObservedServiceState,
  ProtectedSourceEnvironment,
  SourceRecoveryManifest,
  SourceServiceSnapshot,
  TargetServiceRelease,
} from "../domain/service-transition";

export type EnvironmentMutationOutcome =
  | Readonly<{
      status: "applied";
      previousEnvironmentSha256: string;
      environmentSha256: string;
      environmentKeysSha256: string;
      replayed: boolean;
    }>
  | Readonly<{
      status: "conflict";
      observedEnvironmentSha256: string;
    }>
  | Readonly<{
      status: "ambiguous";
      observedEnvironmentSha256?: string;
    }>;

export interface ServiceStatePort {
  observe(serviceId: string): Promise<ObservedServiceState>;
  suspend(serviceId: string): Promise<void>;
  resume(serviceId: string, expected: ObservedServiceState): Promise<void>;
  quiesceDeployments(serviceId: string): Promise<void>;
}

export interface ServiceConfigurationPort {
  configureTarget(contract: TargetServiceRelease): Promise<void>;
  configureSource(contract: SourceServiceSnapshot): Promise<void>;
}

export interface ServiceEnvironmentPort {
  replaceEnvironment(
    serviceId: string,
    input: {
      set: Readonly<Record<string, string>>;
      remove: readonly string[];
      expectedBeforeSha256?: string;
      expectedAfterSha256: string;
    },
  ): Promise<EnvironmentMutationOutcome>;
  planEnvironmentDelta(input: {
    serviceId: string;
    set: Readonly<Record<string, string>>;
    remove: readonly string[];
    expectedBeforeSha256: string;
  }): Promise<{ environmentSha256: string; environmentKeysSha256: string }>;
}

export interface ServiceDeploymentPort {
  deployArtifact(serviceId: string, reference: string): Promise<string>;
  deploySourceRevision(serviceId: string, revision: string): Promise<string>;
  waitForDeployment(
    serviceId: string,
    deploymentId: string,
    expected:
      | { kind: "container_image"; reference: string }
      | { kind: "source_revision"; revision: string },
  ): Promise<void>;
  reconcileSourceDeployment(input: {
    serviceId: string;
    revision: string;
    intentAt: string;
  }): Promise<string | null>;
}

export interface SourceSnapshotPort {
  captureSourceManifest(input: {
    rolloutId: string;
    services: readonly Readonly<{
      serviceId: string;
      databaseEnvKey: string;
      databaseRole: string;
    }>[];
    protectedEnvironment: ProtectedSourceEnvironment;
  }): Promise<SourceRecoveryManifest>;
}

export interface TransactionalServiceProvider
  extends
    ServiceStatePort,
    ServiceConfigurationPort,
    ServiceEnvironmentPort,
    ServiceDeploymentPort,
    SourceSnapshotPort {}
