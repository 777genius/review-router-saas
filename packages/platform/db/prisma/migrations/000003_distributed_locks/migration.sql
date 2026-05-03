-- CreateTable
CREATE TABLE "DistributedLock" (
    "key" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DistributedLock_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "DistributedLock_expiresAt_idx" ON "DistributedLock"("expiresAt");
