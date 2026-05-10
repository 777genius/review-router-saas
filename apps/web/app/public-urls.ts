const hostedApiUrl = "https://api.reviewrouter.site";
const hostedWebUrl = "https://reviewrouter.site";
const contactEmail = "quantjumppro@gmail.com";
const publicGitHubRepoUrl = "https://github.com/777genius/review-router";

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
export const reviewRouterContactEmail = contactEmail;
export const reviewRouterContactMailto = `mailto:${contactEmail}`;
export const reviewRouterGitHubRepoUrl = publicGitHubRepoUrl;
export const reviewRouterGitHubIssuesChooseUrl = `${publicGitHubRepoUrl}/issues/new/choose`;
export const reviewRouterGitHubSetupIssueUrl = `${publicGitHubRepoUrl}/issues/new?template=setup-help.yml`;
export const reviewRouterGitHubBugIssueUrl = `${publicGitHubRepoUrl}/issues/new?template=bug-report.yml`;
