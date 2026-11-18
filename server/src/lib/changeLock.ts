import type { Prisma } from "../generated/prisma/client.ts";

// Serializes work on one pull/merge request until the transaction ends. Each
// kind of work has its own scope, so queueing a review never waits on a thread
// reply being recorded for the same change, and the reverse. The backlog is
// per repository, so its lock passes number 0 (no change has it) to cover them all.
export async function lockChange(
  tx: Prisma.TransactionClient,
  scope: "enqueue" | "replies" | "backlog",
  repositoryId: string,
  number: number,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${scope}:${repositoryId}`}::text), ${number}::int)`;
}
