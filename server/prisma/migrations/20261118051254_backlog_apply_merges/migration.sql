-- AlterTable
ALTER TABLE "backlog_items" ADD COLUMN     "scrubbed_at" TIMESTAMPTZ;

-- AlterTable
ALTER TABLE "change_states" ADD COLUMN     "applied_job_id" UUID,
ADD COLUMN     "merge_applied_at" TIMESTAMPTZ;

-- CreateIndex
CREATE INDEX "change_states_state_merge_applied_at_idx" ON "change_states"("state", "merge_applied_at");
