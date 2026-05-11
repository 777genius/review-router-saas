-- AlterTable
ALTER TABLE "ReviewConfigurationVersion"
ADD COLUMN "providerLimit" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN "providerMaxParallel" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN "inlineMinAgreement" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "ReviewConfigurationVersionProvider" (
    "id" TEXT NOT NULL,
    "configurationVersionId" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "providerKind" TEXT NOT NULL,
    "providerAuthMode" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "reasoningEffort" TEXT NOT NULL,
    "agenticContext" BOOLEAN NOT NULL DEFAULT true,
    "fastMode" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ReviewConfigurationVersionProvider_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReviewConfigurationVersionProvider_configurationVersionId_order_key" ON "ReviewConfigurationVersionProvider"("configurationVersionId", "order");

-- CreateIndex
CREATE INDEX "ReviewConfigurationVersionProvider_configurationVersionId_idx" ON "ReviewConfigurationVersionProvider"("configurationVersionId");

-- AddForeignKey
ALTER TABLE "ReviewConfigurationVersionProvider" ADD CONSTRAINT "ReviewConfigurationVersionProvider_configurationVersionId_fkey" FOREIGN KEY ("configurationVersionId") REFERENCES "ReviewConfigurationVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
