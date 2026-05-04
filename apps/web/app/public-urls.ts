const hostedApiUrl = "https://api.reviewrouter.site";
const hostedWebUrl = "https://reviewrouter.site";

export const reviewRouterWebUrl = (
  process.env.REVIEW_ROUTER_PUBLIC_WEB_URL ??
  process.env.REVIEW_ROUTER_WEB_URL ??
  process.env.NEXTAUTH_URL ??
  hostedWebUrl
).replace(/\/+$/, "");

export const reviewRouterApiUrl = (
  process.env.REVIEW_ROUTER_PUBLIC_API_URL ??
  process.env.REVIEW_ROUTER_API_URL ??
  hostedApiUrl
).replace(/\/+$/, "");

export const reviewRouterApiDemoUrl = `${reviewRouterApiUrl}/docs`;
