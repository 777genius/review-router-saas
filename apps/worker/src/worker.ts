import { config as loadDotenv } from "dotenv";
import { ConsoleLogger } from "@reviewrouter/platform-logger";

loadDotenv({ path: ".env.local", override: false });
loadDotenv({ path: ".env", override: false });

const logger = new ConsoleLogger();
logger.info("ReviewRouter worker booted", {
  mode: process.env.NODE_ENV ?? "development",
});
