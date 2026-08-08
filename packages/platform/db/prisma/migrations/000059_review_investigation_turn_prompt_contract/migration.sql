ALTER TABLE "ReviewInvestigation"
ADD COLUMN "turnPromptContractHash" TEXT,
ADD CONSTRAINT "ReviewInvestigation_turn_prompt_contract_hash_format" CHECK (
  "turnPromptContractHash" IS NULL
  OR "turnPromptContractHash" ~ '^[a-f0-9]{64}$'
) NOT VALID;

ALTER TABLE "ReviewInvestigation"
VALIDATE CONSTRAINT "ReviewInvestigation_turn_prompt_contract_hash_format";

-- Null identifies pre-v4 profiles. Do not backfill it: historical contracts
-- must retain the exact shape and digest they were admitted with.
