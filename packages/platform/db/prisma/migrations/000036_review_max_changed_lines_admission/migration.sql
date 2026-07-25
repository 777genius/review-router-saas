BEGIN;

ALTER TYPE "ReviewRequestedIntentTerminalReasonV2"
  ADD VALUE IF NOT EXISTS 'max_changed_lines_exceeded';

CREATE TYPE "ReviewRequestAdmissionStateV2" AS ENUM (
  'not_evaluated',
  'admitted',
  'rejected'
);

ALTER TABLE "ReviewRequestedIntent"
  ADD COLUMN "admissionState" "ReviewRequestAdmissionStateV2"
    NOT NULL DEFAULT 'not_evaluated',
  ADD COLUMN "admissionChangedLines" INTEGER,
  ADD COLUMN "admissionMaxChangedLines" INTEGER,
  ADD COLUMN "admissionPolicySnapshotId" TEXT,
  ADD COLUMN "admissionDecisionHash" TEXT,
  ADD COLUMN "admissionCheckedAt" TIMESTAMP(3);

ALTER TABLE "ReviewRequestedIntent"
  ADD CONSTRAINT "ReviewRequestedIntent_admission_shape_check"
    CHECK (
      (
        "admissionState" = 'not_evaluated'
        AND "admissionChangedLines" IS NULL
        AND "admissionMaxChangedLines" IS NULL
        AND "admissionPolicySnapshotId" IS NULL
        AND "admissionDecisionHash" IS NULL
        AND "admissionCheckedAt" IS NULL
      )
      OR (
        "admissionState" IN ('admitted', 'rejected')
        AND "admissionChangedLines" >= 0
        AND "admissionMaxChangedLines" > 0
        AND LENGTH("admissionPolicySnapshotId") > 0
        AND "admissionDecisionHash" ~ '^[a-f0-9]{64}$'
        AND "admissionCheckedAt" IS NOT NULL
      )
    ),
  ADD CONSTRAINT "ReviewRequestedIntent_admission_verdict_check"
    CHECK (
      (
        "admissionState" = 'rejected'
        AND "state" = 'terminal'
        AND "terminalReason"::text = 'max_changed_lines_exceeded'
        AND "admissionChangedLines" > "admissionMaxChangedLines"
      )
      OR (
        "admissionState" = 'admitted'
        AND "admissionChangedLines" <= "admissionMaxChangedLines"
      )
      OR "admissionState" = 'not_evaluated'
    );

COMMIT;
