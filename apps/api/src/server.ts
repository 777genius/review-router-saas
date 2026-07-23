import { config as loadDotenv } from "dotenv";
import { createApiApp } from "./app.js";

loadDotenv({ path: "../../.env.local", override: false });
loadDotenv({ path: "../../.env", override: false });
loadDotenv({ path: ".env.local", override: false });
loadDotenv({ path: ".env", override: false });

const port = Number(process.env.PORT ?? 4000);
const host = process.env.HOST ?? "127.0.0.1";
const actionSessionSecret =
  process.env.REVIEW_ROUTER_ACTION_SESSION_SECRET ?? process.env.AUTH_SECRET;
const reviewActionV2Enabled =
  process.env.REVIEW_ROUTER_REVIEW_V2_RUN_CONTROL_ENABLED === "1";
const app = await createApiApp({
  ...(process.env.GITHUB_WEBHOOK_SECRET
    ? { githubWebhookSecret: process.env.GITHUB_WEBHOOK_SECRET }
    : {}),
  ...(actionSessionSecret ? { actionSessionSecret } : {}),
  ...(process.env.REVIEW_ROUTER_ACTION_OIDC_AUDIENCE
    ? { actionOidcAudience: process.env.REVIEW_ROUTER_ACTION_OIDC_AUDIENCE }
    : {}),
  ...(process.env.REVIEW_ROUTER_DISABLE_ACTION_CONTROL_PLANE === "1"
    ? { actionControlPlaneEnabled: false }
    : {}),
  reviewRunControlV2Enabled: reviewActionV2Enabled,
  reviewActionV2Env: process.env,
});

await app.listen({ port, host });
console.info(`ReviewRouter API listening on http://${host}:${port}`);
