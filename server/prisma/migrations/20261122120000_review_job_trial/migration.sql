-- AlterTable
ALTER TABLE "review_jobs" ADD COLUMN "trial" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "trial_reviewer" JSONB;
