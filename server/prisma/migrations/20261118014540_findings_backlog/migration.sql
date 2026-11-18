-- CreateEnum
CREATE TYPE "change_state_value" AS ENUM ('open', 'closed', 'merged');

-- CreateEnum
CREATE TYPE "backlog_state" AS ENUM ('open', 'resolved', 'dismissed');

-- CreateEnum
CREATE TYPE "backlog_resolution" AS ENUM ('fixed', 'invalidated');

-- CreateEnum
CREATE TYPE "backlog_origin" AS ENUM ('open', 'fix_later');

-- CreateTable
CREATE TABLE "change_states" (
    "id" UUID NOT NULL,
    "repository_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "state" "change_state_value" NOT NULL,
    "base_branch" TEXT,
    "closed_at" TIMESTAMPTZ,
    "checked_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "change_states_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backlog_items" (
    "id" UUID NOT NULL,
    "repository_id" UUID NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "base_branch" TEXT NOT NULL,
    "source_number" INTEGER NOT NULL,
    "source_change_title" TEXT NOT NULL,
    "author" TEXT,
    "title" TEXT NOT NULL,
    "file" TEXT NOT NULL,
    "start_line" INTEGER NOT NULL,
    "end_line" INTEGER,
    "severity" "finding_severity" NOT NULL,
    "category" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "rule_id" TEXT,
    "model" TEXT,
    "origin" "backlog_origin" NOT NULL,
    "ignore_note" TEXT,
    "state" "backlog_state" NOT NULL DEFAULT 'open',
    "resolution" "backlog_resolution",
    "resolved_number" INTEGER,
    "resolved_job_id" UUID,
    "resolved_at" TIMESTAMPTZ,
    "dismissed_at" TIMESTAMPTZ,
    "dismiss_note" TEXT,
    "first_seen_at" TIMESTAMPTZ NOT NULL,
    "merged_at" TIMESTAMPTZ NOT NULL,
    "last_seen_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "backlog_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "change_states_repository_id_number_key" ON "change_states"("repository_id", "number");

-- CreateIndex
CREATE INDEX "backlog_items_repository_id_state_idx" ON "backlog_items"("repository_id", "state");

-- CreateIndex
CREATE INDEX "backlog_items_state_severity_idx" ON "backlog_items"("state", "severity");

-- CreateIndex
CREATE UNIQUE INDEX "backlog_items_repository_id_fingerprint_key" ON "backlog_items"("repository_id", "fingerprint");

-- AddForeignKey
ALTER TABLE "change_states" ADD CONSTRAINT "change_states_repository_id_fkey" FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "backlog_items" ADD CONSTRAINT "backlog_items_repository_id_fkey" FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "backlog_items" ADD CONSTRAINT "backlog_items_resolved_job_id_fkey" FOREIGN KEY ("resolved_job_id") REFERENCES "review_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
