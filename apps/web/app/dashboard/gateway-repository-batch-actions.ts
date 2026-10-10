"use server";

import {
  gatewayRepositoryBatchServerAdapter,
  type GatewayBatchRequest,
  type GatewayBatchResult,
} from "../../src/server/gateway-repository-batch-configuration";
import { revalidatePath } from "next/cache";

export async function saveGatewayRepositoryBatch(
  request: GatewayBatchRequest,
): Promise<GatewayBatchResult> {
  const result = await (
    await gatewayRepositoryBatchServerAdapter()
  ).save(request);
  if (result.results.some((target) => target.status === "applied"))
    revalidatePath("/dashboard");
  return result;
}
export async function readGatewayRepositoryBatch(
  request: GatewayBatchRequest,
): Promise<GatewayBatchResult> {
  return (await gatewayRepositoryBatchServerAdapter()).read(request);
}
