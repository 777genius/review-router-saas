-- Per-target review output language.
-- Free-text natural language for the human-readable finding text; NULL keeps
-- the default English behaviour. Resolved per repository (with workspace
-- default fallback) and forwarded to the runtime as REVIEW_OUTPUT_LANGUAGE.
ALTER TABLE "ReviewConfigurationVersion"
  ADD COLUMN IF NOT EXISTS "reviewLanguage" TEXT;
