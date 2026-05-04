ALTER TABLE "ActionRunHealthReport"
  ADD COLUMN "configSource" TEXT,
  ADD COLUMN "findingCriticalCount" INTEGER,
  ADD COLUMN "findingMajorCount" INTEGER,
  ADD COLUMN "findingMinorCount" INTEGER,
  ADD COLUMN "findingInfoCount" INTEGER,
  ADD COLUMN "inlineCommentCount" INTEGER,
  ADD COLUMN "summaryCommentCount" INTEGER,
  ADD COLUMN "skippedReasonCategory" TEXT;
