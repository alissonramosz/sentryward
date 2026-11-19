-- AlterTable
ALTER TABLE "repositories" ADD COLUMN     "directories" JSONB NOT NULL DEFAULT '[]';
