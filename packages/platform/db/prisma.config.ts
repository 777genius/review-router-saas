import { defineConfig } from "prisma/config";
import { readFileSync } from "node:fs";

const databaseUrl = process.env.REVIEW_ROUTER_DATABASE_URL_FILE
  ? readFileSync(process.env.REVIEW_ROUTER_DATABASE_URL_FILE, "utf8").trim()
  : (process.env.DATABASE_URL ?? "");

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: databaseUrl,
  },
});
