-- CreateEnum
CREATE TYPE "rule_suggestion_status" AS ENUM ('pending', 'approved', 'discarded');

-- AlterTable
ALTER TABLE "findings" ADD COLUMN     "suggestion_id" UUID;

-- AlterTable
ALTER TABLE "workspaces" ADD COLUMN     "rule_suggestions_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "rule_suggestions_excluded_reviewers" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "rule_suggestions_last_run_at" TIMESTAMPTZ,
ADD COLUMN     "rule_suggestions_min_evidence" INTEGER NOT NULL DEFAULT 5;

-- CreateTable
CREATE TABLE "review_comments" (
    "id" UUID NOT NULL,
    "repository_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "forge_comment_id" TEXT NOT NULL,
    "author" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "file" TEXT NOT NULL,
    "line" INTEGER,
    "suggestion_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "review_comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rule_suggestions" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "repository_id" UUID,
    "status" "rule_suggestion_status" NOT NULL DEFAULT 'pending',
    "rule" JSONB NOT NULL,
    "rationale" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "model" TEXT NOT NULL,
    "applied_target" TEXT,
    "decided_by_id" UUID,
    "decided_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rule_suggestions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "review_comments_repository_id_created_at_idx" ON "review_comments"("repository_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "review_comments_repository_id_forge_comment_id_key" ON "review_comments"("repository_id", "forge_comment_id");

-- CreateIndex
CREATE INDEX "rule_suggestions_workspace_id_status_created_at_idx" ON "rule_suggestions"("workspace_id", "status", "created_at");

-- AddForeignKey
ALTER TABLE "findings" ADD CONSTRAINT "findings_suggestion_id_fkey" FOREIGN KEY ("suggestion_id") REFERENCES "rule_suggestions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_comments" ADD CONSTRAINT "review_comments_repository_id_fkey" FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_comments" ADD CONSTRAINT "review_comments_suggestion_id_fkey" FOREIGN KEY ("suggestion_id") REFERENCES "rule_suggestions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_suggestions" ADD CONSTRAINT "rule_suggestions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_suggestions" ADD CONSTRAINT "rule_suggestions_repository_id_fkey" FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE SET NULL ON UPDATE CASCADE;
