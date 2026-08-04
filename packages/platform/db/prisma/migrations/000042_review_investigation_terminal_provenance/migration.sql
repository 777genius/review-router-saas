ALTER TABLE "ReviewInvestigationCertificate"
  ADD COLUMN "terminalProviderKind" TEXT,
  ADD COLUMN "terminalActualModel" TEXT;

ALTER TABLE "ReviewInvestigationCertificate"
  ADD CONSTRAINT "ReviewInvestigationCertificate_terminalProvenance_pair_check"
  CHECK (
    ("terminalProviderKind" IS NULL AND "terminalActualModel" IS NULL)
    OR
    ("terminalProviderKind" IS NOT NULL AND "terminalActualModel" IS NOT NULL)
  );
