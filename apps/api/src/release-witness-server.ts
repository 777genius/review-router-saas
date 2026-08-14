import { config as loadDotenv } from "dotenv";
import { createPrismaClient } from "@reviewrouter/platform-db";
import { createReleaseWitnessApp } from "./release-witness-composition.js";

for (const path of ["../../.env.local", "../../.env", ".env.local", ".env"])
  loadDotenv({ path, override: false });

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`release_witness_env_missing:${name}`);
  return value;
};
const witnessPrisma = createPrismaClient({
  databaseUrl: required("REVIEW_ROUTER_RELEASE_AUTHORITY_WITNESS_DATABASE_URL"),
  poolMax: 2,
});
const app = await createReleaseWitnessApp({
  witnessPrisma,
  triggerTokenSha256: required("REVIEW_ROUTER_RELEASE_WITNESS_TOKEN_SHA256"),
  renderReadToken: required("REVIEW_ROUTER_RELEASE_WITNESS_RENDER_READ_TOKEN"),
  trustedDatabaseIdentity: {
    serverIdentity: required(
      "REVIEW_ROUTER_RELEASE_AUTHORITY_SYSTEM_IDENTIFIER",
    ),
    databaseIdentity: required("REVIEW_ROUTER_RELEASE_AUTHORITY_DATABASE_OID"),
    databaseName: required("REVIEW_ROUTER_RELEASE_AUTHORITY_DATABASE_NAME"),
  },
});
app.addHook("onClose", async () => witnessPrisma.$disconnect());
await app.listen({
  port: Number(process.env.PORT ?? 4011),
  host: process.env.HOST ?? "127.0.0.1",
});
