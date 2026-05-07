# Disposable Repository Cleanup

## May 8, 2026 Cleanup

These repositories were created only for ReviewRouter smoke, E2E, reusable
workflow, GitHub App token, and UI setup validation. They are not product
repositories and are not required by the SaaS runtime.

Cleanup policy:

- only delete repositories whose names match explicit ReviewRouter E2E/smoke prefixes
- verify zero stars, zero forks, zero watchers, zero open issues, and no releases before deletion
- keep historical E2E results in `ai-docs`, but do not depend on deleted repository links
- future real E2E runs should create fresh disposable repositories and record fresh PR/run links

Deleted repository candidates approved for cleanup:

```text
777genius/reviewrouter-app-token-e2e-1778144840
777genius/reviewrouter-prod-app-pr-e2e-1778144599
777genius/reviewrouter-prod-app-pr-e2e-1778144543
777genius/reviewrouter-release-e2e-1778141380
777genius/reviewrouter-reusable-e2e-1778072379
777genius/reviewrouter-reusable-smoke-1778062110
777genius/rr-app-bot-e2e-20260505151434
777genius/rr-app-bot-e2e-20260505151339
777genius/rr-ui-e2e-20260505133623
777genius/rr-ui-e2e-20260505131320
777genius/rr-ui-e2e-20260505121539
777genius/rr-ui-e2e-20260505104756
777genius/rr-app-install-e2e-1777913568
777genius/rr-saas-fresh-e2e-1777884682969
777genius/rr-saas-fresh-e2e-1777883214101
777genius/rr-saas-fresh-e2e-1777881944408
777genius/rr-saas-fresh-e2e-1777881824275
777genius/rr-saas-fresh-e2e-1777880754438
777genius/rr-saas-fresh-e2e-1777879956635
777genius/rr-saas-fresh-e2e-1777879895654
777genius/rr-saas-fresh-e2e-1777876904596
777genius/rr-saas-fresh-e2e-1777876068729
777genius/rr-saas-fresh-e2e-1777874235486
777genius/rr-saas-fresh-e2e-1777852871545
777genius/rr-saas-fresh-e2e-1777852435110
777genius/rr-saas-fresh-e2e-1777851508064
777genius/rr-saas-fresh-e2e-1777850784656
777genius/rr-saas-fresh-e2e-1777848830828
777genius/rr-saas-fresh-e2e-1777847651970
777genius/rr-saas-fresh-e2e-1777847561393
777genius/rr-saas-fresh-e2e-1777846695703
777genius/rr-saas-fresh-e2e-1777846574275
777genius/rr-saas-fresh-e2e-1777846539881
777genius/rr-saas-fresh-e2e-1777846464983
777genius/rr-saas-fresh-e2e-20260504010426
777genius/review-router-saas-e2e
777genius/review-router-smoke-20260501203854
777genius/review-router-main-clean-smoke-20260501174945
777genius/review-router-e2e-smoke-20260501172452
777genius/review-router-lifecycle-e2e
```
