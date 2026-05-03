CREATE TABLE "ActionOidcReplayNonce" (
    "key" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActionOidcReplayNonce_pkey" PRIMARY KEY ("key")
);

CREATE INDEX "ActionOidcReplayNonce_expiresAt_idx" ON "ActionOidcReplayNonce"("expiresAt");
