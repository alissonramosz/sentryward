-- AlterEnum
ALTER TYPE "notification_event" ADD VALUE 'budget';

-- AlterTable
ALTER TABLE "workspaces" ADD COLUMN     "monthly_budget_usd" DOUBLE PRECISION;

-- CreateTable
CREATE TABLE "budget_alerts" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "month" TIMESTAMPTZ NOT NULL,
    "threshold" INTEGER NOT NULL,
    "spend_usd" DOUBLE PRECISION NOT NULL,
    "budget_usd" DOUBLE PRECISION NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "budget_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "budget_alerts_created_at_idx" ON "budget_alerts"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "budget_alerts_workspace_id_month_threshold_key" ON "budget_alerts"("workspace_id", "month", "threshold");

-- AddForeignKey
ALTER TABLE "budget_alerts" ADD CONSTRAINT "budget_alerts_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
