import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  WorkspaceHandle,
  WorkspacePort,
} from "@reviewrouter/subscription-runtime-core";

export class TempWorkspace implements WorkspacePort {
  readonly workspaceId = "temp-workspace";
  readonly capabilities = {
    workspaceId: this.workspaceId,
    supportsTempDir: true,
    supportsExistingCheckout: true,
    supportsContainer: false,
  };

  constructor(private readonly prefix = "subscription-runtime-worker-") {}

  async create(): Promise<WorkspaceHandle> {
    const path = await mkdtemp(join(tmpdir(), this.prefix));
    return {
      path,
      dispose: () => rm(path, { recursive: true, force: true }),
    };
  }
}
