-- The immutable configuration version is the operation receipt, scoped to its
-- existing parent. Normal writes remain NULL/NULL; no separate replay ledger.
-- Clearing a receipt-bearing override retains its parent/history but hides it
-- from current configuration reads. Existing overrides remain active.
ALTER TABLE "ReviewConfiguration"
  ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE "ReviewConfigurationVersion"
  ADD COLUMN "operationId" TEXT,
  ADD COLUMN "operationIntentHash" TEXT,
  ADD CONSTRAINT "ReviewConfigurationVersion_operation_pair" CHECK (
    ("operationId" IS NULL AND "operationIntentHash" IS NULL)
    OR (
      "operationId" IS NOT NULL AND "operationIntentHash" IS NOT NULL
      AND "operationId" ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'
      AND "operationIntentHash" ~ '^[0-9a-f]{64}$'
    )
  );

CREATE UNIQUE INDEX "ReviewConfigurationVersion_configurationId_operationId_key"
  ON "ReviewConfigurationVersion" ("configurationId", "operationId");
