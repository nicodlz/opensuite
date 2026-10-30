ALTER TABLE "Entry" ADD CONSTRAINT "Entry_parentId_fkey"
  FOREIGN KEY ("parentId") REFERENCES "Entry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "Entry_parentId_idx" ON "Entry"("parentId");
CREATE INDEX "Entry_state_expiresAt_idx" ON "Entry"("state", "expiresAt");
