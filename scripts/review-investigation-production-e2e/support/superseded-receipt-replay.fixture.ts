export const supersededReceiptReplayFixture = Object.freeze({
  environment: "disposable_sandbox",
  source: Object.freeze({
    revisionLabel: "A",
    terminalState: "superseded",
    publicationCount: 0,
  }),
  target: Object.freeze({
    revisionLabel: "B",
    expectedReusedReceiptCount: 2,
    requireFreshCritic: true,
    expectedCopiedFindings: 0,
    expectedCopiedPublicationEffects: 0,
  }),
});
