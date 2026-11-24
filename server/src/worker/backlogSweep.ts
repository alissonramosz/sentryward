import { prisma } from "../lib/prisma.ts";
import { Prisma } from "../generated/prisma/client.ts";
import { recordChangeState } from "../services/backlog.ts";
import { adapterForConnection, type Forge } from "../services/forge.ts";

// Merges reach the backlog through the close webhook, but a webhook can be
// missed: the forge gave up retrying, the connection's credentials were
// rejected (its hooks are answered without being acted on), or reviews ran
// without hooks at all. This asks the forge about changes that still have
// unaddressed findings once they have gone quiet. Retention purges a change's
// findings only after days without activity, so a merge is found here long
// before its findings are gone.

const QUIET_MS = 60 * 60 * 1000;
const RECHECK_MS = 6 * 60 * 60 * 1000;

export interface SweepOptions {
  now?: Date;
  batchSize?: number;
  // Tests pass a stub; the worker builds one from the repository's connection.
  forgeFor?: (connection: Parameters<typeof adapterForConnection>[0]) => Pick<Forge, "getChangeDetails">;
}

export interface SweepResult {
  checked: number;
  merged: number;
  failed: number;
}

export async function sweepClosedChanges({
  now = new Date(),
  batchSize = 25,
  forgeFor = adapterForConnection,
}: SweepOptions = {}): Promise<SweepResult> {
  const quiet = new Date(now.getTime() - QUIET_MS);
  const recheck = new Date(now.getTime() - RECHECK_MS);
  // A change a review is queued or running for, or ran recently, is busy:
  // the close watch and the webhook speak for it. A trial is not activity on
  // the change: it syncs no findings and never speaks for it.
  const candidates = await prisma.$queryRaw<{ repository_id: string; number: number }[]>`
    SELECT f.repository_id, f.number
    FROM findings f
    JOIN repositories r ON r.id = f.repository_id
    JOIN forge_connections c ON c.id = r.connection_id
    LEFT JOIN change_states s ON s.repository_id = f.repository_id AND s.number = f.number
    WHERE (f.state = 'open' OR (f.state = 'ignored' AND f.ignore_reason = 'fix_later'))
      AND r.enabled AND r.access_lost_at IS NULL AND c.credentials_rejected_at IS NULL
      -- A merge already recorded is the applier's (backlog.ts), not the sweep's.
      AND (s.id IS NULL OR (s.state <> 'merged' AND s.checked_at < ${recheck}))
      AND NOT EXISTS (
        SELECT 1 FROM review_jobs j
        WHERE j.repository_id = f.repository_id AND j.number = f.number AND j.trial = false
          AND (j.status IN ('queued', 'running') OR j.created_at >= ${quiet})
      )
    GROUP BY f.repository_id, f.number
    HAVING max(f.last_seen_at) < ${quiet}
    ORDER BY min(s.checked_at) NULLS FIRST
    LIMIT ${batchSize}
  `;
  const result: SweepResult = { checked: 0, merged: 0, failed: 0 };
  if (!candidates.length) return result;

  const repos = await prisma.repository.findMany({
    where: { id: { in: [...new Set(candidates.map((row) => row.repository_id))] } },
    include: { connection: true },
  });
  const byId = new Map(repos.map((repo) => [repo.id, repo]));
  for (const { repository_id: repositoryId, number } of candidates) {
    const repo = byId.get(repositoryId);
    // Deleted since the candidate query: its findings went with it.
    if (!repo) continue;
    try {
      const details = await forgeFor(repo.connection).getChangeDetails(repo.fullPath, number);
      result.checked++;
      if (details.state === "open") {
        await touch(repositoryId, number, now, true);
        continue;
      }
      const at = details.state === "merged" ? details.mergedAt : details.closedAt;
      const recorded = await recordChangeState({
        repositoryId,
        number,
        state: details.state,
        baseBranch: details.targetBranch,
        closedAt: at ? new Date(at) : null,
      });
      // Recorded only; the worker applies it (applyPendingMerges).
      if (recorded) result.merged++;
    } catch (err) {
      // A flaky forge or a change it no longer knows: asked again after the
      // recheck period rather than every pass.
      result.failed++;
      // A constant format string: the path is forge-provided text.
      console.error("[backlog] could not check %s#%d", repo.fullPath, number, err);
      await touch(repositoryId, number, now).catch(() => undefined);
    }
  }
  return result;
}

// Remembers that the change was asked about. Only an answer of "open" changes
// what is known (a closed change was reopened); a failed check leaves it.
async function touch(repositoryId: string, number: number, now: Date, open = false): Promise<void> {
  try {
    await prisma.changeState.upsert({
      where: { repositoryId_number: { repositoryId, number } },
      create: { repositoryId, number, state: "open", checkedAt: now },
      update: { checkedAt: now, ...(open ? { state: "open" as const, closedAt: null } : {}) },
    });
  } catch (err) {
    // Two workers creating the same row: the other one recorded the check.
    if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) throw err;
  }
}
