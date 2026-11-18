-- AlterTable
ALTER TABLE "budget_alerts" ADD COLUMN     "admin_email_attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "admin_email_locked_at" TIMESTAMPTZ,
ADD COLUMN     "admin_email_payload" JSONB,
ADD COLUMN     "admin_user_ids" UUID[] DEFAULT ARRAY[]::UUID[];

-- CreateIndex
CREATE INDEX "budget_alerts_month_idx" ON "budget_alerts"("month");
