-- CreateIndex
CREATE INDEX "findings_suggestion_id_idx" ON "findings"("suggestion_id");

-- CreateIndex
CREATE INDEX "review_comments_suggestion_id_idx" ON "review_comments"("suggestion_id");
