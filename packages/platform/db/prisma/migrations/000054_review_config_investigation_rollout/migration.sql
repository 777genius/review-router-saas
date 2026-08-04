ALTER TABLE "ReviewConfigurationVersion"
ADD COLUMN "investigationRecordingEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "investigationShadowEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "investigationContextCriticEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "investigationVerifiedCleanEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "investigationCrossRevisionReplayEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "investigationProductionEffectsEnabled" BOOLEAN NOT NULL DEFAULT false;
