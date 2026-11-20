-- Prisma generates scalar lists as nullable columns, but the model field is a
-- required String[] and callers map over it, so a NULL written outside Prisma
-- would crash comment recording and settings handling.
UPDATE "workspaces" SET "rule_suggestions_excluded_reviewers" = ARRAY[]::TEXT[]
WHERE "rule_suggestions_excluded_reviewers" IS NULL;

-- AlterTable
ALTER TABLE "workspaces" ALTER COLUMN "rule_suggestions_excluded_reviewers" SET NOT NULL;
