import type {
  ProducerRelease,
  ReviewOperationalSloProfileV2,
  ReviewProtocolLimitsV2,
} from "../../domain/producer-release";

export enum ImmutableRegistryWriteStatus {
  Created = "created",
  Restored = "restored",
  Conflict = "conflict",
}

export type ImmutableRegistryWriteResult<T> =
  | {
      readonly status:
        | ImmutableRegistryWriteStatus.Created
        | ImmutableRegistryWriteStatus.Restored;
      readonly value: T;
    }
  | {
      readonly status: ImmutableRegistryWriteStatus.Conflict;
      readonly existingId: string;
    };

export enum ProducerReleaseRevocationStatus {
  Revoked = "revoked",
  Restored = "restored",
  Missing = "missing",
}

export interface ReviewProtocolLimitsProfileQueryPort {
  findProtocolLimitsProfileById(
    protocolLimitsProfileId: string,
  ): Promise<ReviewProtocolLimitsV2 | null>;
}

export interface ReviewProtocolLimitsProfileCommandPort {
  registerProtocolLimitsProfile(
    profile: ReviewProtocolLimitsV2,
  ): Promise<ImmutableRegistryWriteResult<ReviewProtocolLimitsV2>>;
}

export interface ReviewOperationalSloProfileQueryPort {
  findOperationalSloProfileById(
    operationalSloProfileId: string,
  ): Promise<ReviewOperationalSloProfileV2 | null>;
}

export interface ReviewOperationalSloProfileCommandPort {
  registerOperationalSloProfile(
    profile: ReviewOperationalSloProfileV2,
  ): Promise<ImmutableRegistryWriteResult<ReviewOperationalSloProfileV2>>;
}

export interface ProducerReleaseQueryPort {
  findProducerReleaseById(
    producerReleaseId: string,
  ): Promise<ProducerRelease | null>;
}

export interface ProducerReleaseCommandPort {
  registerProducerRelease(
    release: ProducerRelease,
  ): Promise<ImmutableRegistryWriteResult<ProducerRelease>>;
  revokeProducerRelease(input: {
    readonly producerReleaseId: string;
    readonly revokedAt: Date;
  }): Promise<
    | {
        readonly status:
          | ProducerReleaseRevocationStatus.Revoked
          | ProducerReleaseRevocationStatus.Restored;
        readonly release: ProducerRelease;
      }
    | { readonly status: ProducerReleaseRevocationStatus.Missing }
  >;
}
