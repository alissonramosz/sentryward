-- Prisma creates scalar list columns nullable, but the admin email claim in
-- worker/budgetAlerts.ts filters on cardinality(admin_user_ids) > 0, which is
-- NULL (never true) for a NULL array, so such a row's email would never be sent.
UPDATE "budget_alerts" SET "admin_user_ids" = ARRAY[]::UUID[] WHERE "admin_user_ids" IS NULL;

-- AlterTable
ALTER TABLE "budget_alerts" ALTER COLUMN "admin_user_ids" SET NOT NULL;
