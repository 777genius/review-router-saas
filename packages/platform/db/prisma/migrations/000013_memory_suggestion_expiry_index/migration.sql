CREATE INDEX "MemorySuggestion_status_expiresAt_workspaceId_idx"
  ON "MemorySuggestion"("status", "expiresAt", "workspaceId");
