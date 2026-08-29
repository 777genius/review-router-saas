export type CodexRotatingWorkflowReattestation = {
  readonly claimId: string;
  readonly attemptId: string;
  readonly namespaceId: string;
  readonly namespaceEpoch: string;
  readonly secretName: string;
  readonly repositoryId: string;
  readonly expectedGenerationHash: string;
  readonly workflowPath: string;
  readonly workflowSourceCommitSha: string;
  readonly workflowSourceBlobSha: string;
  readonly workflowSourceSha256: string;
  readonly workflowSemanticSha256: string;
  readonly sourceTrust: string;
  readonly expectedCurrentWorkflowSchemaVersion: 4;
  readonly workflowSchemaVersion: 5;
  readonly expectedCurrentWorkflowSourceCommitSha: string;
  readonly expectedCurrentWorkflowSourceBlobSha: string;
  readonly expectedCurrentWorkflowSourceSha256: string;
  readonly expectedCurrentWorkflowSemanticSha256: string;
};

export interface CodexRotatingWorkflowReattestationPort {
  replaceActiveWorkflowSource(
    input: CodexRotatingWorkflowReattestation,
  ): Promise<{ readonly status: "active" }>;
}
