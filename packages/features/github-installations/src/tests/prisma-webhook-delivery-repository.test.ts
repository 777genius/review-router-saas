import { describe, expect, it, vi } from "vitest";
import { PrismaWebhookDeliveryRepository } from "../infrastructure/prisma/prisma-webhook-delivery-repository";

describe("PrismaWebhookDeliveryRepository", () => {
  it("reclaims an exact failed delivery without reopening a different payload", async () => {
    const create = vi.fn(async () => {
      throw { code: "P2002" };
    });
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const repository = new PrismaWebhookDeliveryRepository({
      gitHubWebhookDelivery: { create, updateMany },
    } as never);

    await expect(
      repository.tryStartProcessing({
        deliveryId: "delivery-1",
        eventName: "pull_request",
        action: "synchronize",
        installationId: "123",
        payloadHash: "payload-hash",
      }),
    ).resolves.toBe(true);
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        deliveryId: "delivery-1",
        eventName: "pull_request",
        action: "synchronize",
        installationId: 123n,
        payloadHash: "payload-hash",
        status: "failed",
      },
      data: {
        status: "processing",
        errorSummary: null,
        processedAt: null,
      },
    });
  });

  it("does not reclaim a processed or identity-mismatched delivery", async () => {
    const repository = new PrismaWebhookDeliveryRepository({
      gitHubWebhookDelivery: {
        create: vi.fn(async () => {
          throw { code: "P2002" };
        }),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
    } as never);

    await expect(
      repository.tryStartProcessing({
        deliveryId: "delivery-1",
        eventName: "pull_request",
        action: "synchronize",
        payloadHash: "different-payload",
      }),
    ).resolves.toBe(false);
  });
});
