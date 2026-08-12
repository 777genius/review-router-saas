import { config as loadDotenv } from "dotenv";
import { createPrismaClient } from "@reviewrouter/platform-db";
import { createReleaseControlApp } from "./release-control-composition.js";

for (const path of ["../../.env.local", "../../.env", ".env.local", ".env"])
  loadDotenv({ path, override: false });

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`release_control_env_missing:${name}`);
  return value;
};

const controlPrisma = createPrismaClient({
  databaseUrl: required("REVIEW_ROUTER_RELEASE_AUTHORITY_CONTROL_DATABASE_URL"),
  poolMax: 4,
});
const providerAuthorityPrisma = createPrismaClient({
  databaseUrl: required(
    "REVIEW_ROUTER_RELEASE_AUTHORITY_PROVIDER_DATABASE_URL",
  ),
  poolMax: 2,
});
const permitInstallerPrisma = createPrismaClient({
  databaseUrl: required(
    "REVIEW_ROUTER_ACTIVATION_PERMIT_INSTALLER_DATABASE_URL",
  ),
  poolMax: 2,
});
const targetReceiptReaderPrisma = createPrismaClient({
  databaseUrl: required("REVIEW_ROUTER_ACTIVATION_RECEIPT_READER_DATABASE_URL"),
  poolMax: 2,
});
const app = await createReleaseControlApp({
  controlPrisma,
  providerAuthorityPrisma,
  permitInstallerPrisma,
  targetReceiptReaderPrisma,
  credentials: {
    controlTokenSha256: required("REVIEW_ROUTER_RELEASE_CONTROL_TOKEN_SHA256"),
    providerAuthorityTokenSha256: required(
      "REVIEW_ROUTER_PROVIDER_AUTHORITY_TOKEN_SHA256",
    ),
  },
});

app.addHook("onClose", async () => {
  await Promise.all([
    controlPrisma.$disconnect(),
    providerAuthorityPrisma.$disconnect(),
    permitInstallerPrisma.$disconnect(),
    targetReceiptReaderPrisma.$disconnect(),
  ]);
});
await app.listen({
  port: Number(process.env.PORT ?? 4010),
  host: process.env.HOST ?? "127.0.0.1",
});
