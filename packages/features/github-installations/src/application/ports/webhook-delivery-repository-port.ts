export type WebhookDeliveryRecord = {
  readonly deliveryId: string;
  readonly eventName: string;
  readonly action?: string | null;
  readonly installationId?: string | null;
};

export interface WebhookDeliveryRepositoryPort {
  wasProcessed(deliveryId: string): Promise<boolean>;
  recordProcessed(delivery: WebhookDeliveryRecord): Promise<void>;
}
