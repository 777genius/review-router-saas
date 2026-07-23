import type {
  ReviewRequestIngressCommandKind,
  ReviewRequestIngressRepository,
} from "../../domain/review-request-ingress";
import type { ReviewRequestedTriggerKind } from "../../domain/review-requested-intent";

export type EnqueueReviewRequestIngressCommand =
  ReviewRequestIngressRepository & {
    readonly commandKind: ReviewRequestIngressCommandKind;
    readonly sourceIdentity: string;
    readonly occurredAt: Date;
  } & (
      | {
          readonly commandKind: ReviewRequestIngressCommandKind.Request;
          readonly triggerKind: ReviewRequestedTriggerKind;
          readonly expectedBaseSha: string | null;
          readonly expectedHeadSha: string;
          readonly quietPeriodMs: number;
          readonly retentionMs: number;
        }
      | {
          readonly commandKind: ReviewRequestIngressCommandKind.Cancel;
        }
    );

export interface ReviewRequestIngressPort {
  enqueue(command: EnqueueReviewRequestIngressCommand): Promise<{
    readonly created: boolean;
    readonly deliveryIdentityHash: string;
    readonly requestId: string | null;
  }>;
}
