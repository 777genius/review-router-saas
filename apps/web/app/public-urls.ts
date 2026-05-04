const hostedApiUrl = "https://api.reviewrouter.site";

export const reviewRouterApiUrl = (
  process.env.REVIEW_ROUTER_PUBLIC_API_URL ??
  process.env.REVIEW_ROUTER_API_URL ??
  hostedApiUrl
).replace(/\/+$/, "");

export const reviewRouterApiDemoUrl = `${reviewRouterApiUrl}/docs`;
