import type { PrismaClient } from "@prisma/client";
import type {
  WebhookDeliveryRecord,
  WebhookDeliveryRepositoryPort,
} from "../../application/ports/webhook-delivery-repository-port.js";

export class PrismaWebhookDeliveryRepository implements WebhookDeliveryRepositoryPort {
  constructor(private readonly prisma: PrismaClient) {}

  async wasProcessed(deliveryId: string): Promise<boolean> {
    const existing = await this.prisma.gitHubWebhookDelivery.findUnique({
      where: { deliveryId },
      select: { id: true },
    });
    return existing !== null;
  }

  async recordProcessed(delivery: WebhookDeliveryRecord): Promise<void> {
    await this.prisma.gitHubWebhookDelivery.upsert({
      where: { deliveryId: delivery.deliveryId },
      update: {
        eventName: delivery.eventName,
        action: delivery.action ?? null,
        installationId: delivery.installationId
          ? BigInt(delivery.installationId)
          : null,
        processedAt: new Date(),
      },
      create: {
        deliveryId: delivery.deliveryId,
        eventName: delivery.eventName,
        action: delivery.action ?? null,
        installationId: delivery.installationId
          ? BigInt(delivery.installationId)
          : null,
        processedAt: new Date(),
      },
    });
  }
}
