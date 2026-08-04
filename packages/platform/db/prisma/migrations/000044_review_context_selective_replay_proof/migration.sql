ALTER TABLE "ReviewContextTargetReplayProof"
ADD COLUMN "sourceOperationReceiptIdsHash" TEXT;

DROP INDEX "ReviewContextTargetReplayProof_target_key";

CREATE UNIQUE INDEX "ReviewContextTargetReplayProof_target_key"
ON "ReviewContextTargetReplayProof"(
  "sourceAttestationId",
  "targetExecutionId",
  "targetWorkSlotId",
  "targetReviewRevisionHash",
  "reusePolicyVectorHash",
  "sourceOperationReceiptIdsHash"
);

ALTER TABLE "ReviewContextTargetReplayProof"
ADD CONSTRAINT "ReviewContextTargetReplayProof_receipt_hash_format"
CHECK (
  "sourceOperationReceiptIdsHash" IS NULL
  OR "sourceOperationReceiptIdsHash" ~ '^[a-f0-9]{64}$'
);
