# Open Questions

## Product

1. What exact free beta limits should be shown publicly?
2. Should SaaS dashboard require GitHub OAuth org admin permission before showing install flow?
3. Should setup PR include only workflow or also `.reviewrouter/config.yml`?
4. How much ReviewRouter Action telemetry should report back to SaaS without storing code/diff?
5. Should AI discussion be included in public beta or delayed?

## Technical

1. Next.js deployment together with API or separate deployment from day one?
2. Exact Auth.js adapter implementation details, including session storage mode and callback typing?
3. How strict should dependency-boundary lint rules be initially?
4. Should audit events live in each feature or one central audit feature with an application port?
5. Exact OIDC claim policy for GitHub Enterprise/customized claims?

## Security

1. Should onboarding recommend selected repositories by default even though the App can support all repositories?
2. What is the minimal safe reporting payload from action to SaaS?
3. How should support debug access be controlled before paid enterprise roles exist?
4. How should trusted rerun for fork PRs work without weakening secret safety?

## Business

1. Which future paid metric is best: seats, repos, or workspace plan?
2. What features stay free after beta?
3. When to add managed cloud execution, if ever?
