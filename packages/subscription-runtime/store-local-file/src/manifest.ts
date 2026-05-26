import type { RuntimeAdapterManifest } from "@reviewrouter/subscription-runtime-core";
import { localEncryptedFileStoreCapabilities } from "./local-encrypted-file-store";

export const localEncryptedFileStoreManifest = {
  adapterId: "store.local-encrypted-file",
  adapterKind: "store",
  packageName: "@reviewrouter/subscription-runtime-store-local-file",
  packageVersion: "0.0.0",
  protocolVersion: 1,
  capabilities: localEncryptedFileStoreCapabilities,
  custody: "local-only",
  experimental: false,
  minimumCoreVersion: "0.0.0",
} satisfies RuntimeAdapterManifest<typeof localEncryptedFileStoreCapabilities>;
