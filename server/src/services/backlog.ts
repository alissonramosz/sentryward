import { lockChange } from "../lib/changeLock.ts";
import { prisma } from "../lib/prisma.ts";
import type { BacklogItem, ChangeStateValue } from "../generated/prisma/client.ts";
import { reviewResultSchema, type ReviewResult } from "../review/core/models.ts";
import { parsePatch } from "../review/diff/parse.ts";

// The backlog holds findings that shipped: still open, or ignored as "fix
// later", when their change merged. Only merging moves anything: a change
// closed unmerged never put its code in the repository, and a fix on a change
// still under review is not in the repository yet. So both promoting a
// change's findings and resolving earlier items happen at merge time, from the
// merged change's latest stored review.

export type BacklogCandidate = Pick<BacklogItem, "fingerprint" | "file" | "startLine" | "endLine" | "baseBranch">;

export interface BacklogTransitions {
  // Its lines were rewritten by a reviewed change that did not report it again.
  fixed: string[];
  // Its file was deleted or renamed: it no longer applies, but was not fixed.
  invalidated: string[];
  // Reported again: still there.
  seenAgain: string[];
}

// Whether a patch removes or rewrites any old-file line in start..end, or
// inserts code between two of them. Context lines are unchanged code, so a
// hunk merely passing by does not count; neither does an insertion just above
// or below the range.
export function patchTouches(patch: string, start: number, end: number): boolean {
  for (const hunk of parsePatch(patch)) {
    let old = hunk.oldStart;
    // The first line of a hunk's content is its @@ header.
    for (const line of hunk.content.split("\n").slice(1)) {
      const marker = line[0];
      if (marker === "\\") continue;
      if (marker === "-") {
        if (old >= start && old <= end) return true;
        old++;
      } else if (marker === "+") {
        // Lands between old lines old-1 and old.
        if (old > start && old <= end) return true;
      } else {
        old++;
      }
    }
  }
  return false;
}

// What one merged change's review says about the backlog of the branch it
// merged into. The same rule a change's own runs use to resolve a finding
// (the run read the file and did not report it), narrowed to changes that
// rewrote the finding's lines: a later change's review looks at its own diff,
// so silence about code it did not touch says nothing. Line numbers are those
// recorded when the item shipped, so later edits above it can shift them;
// that is accepted, and a person can reopen a wrong resolution.
export function backlogTransitions(items: BacklogCandidate[], result: ReviewResult): BacklogTransitions {
  const none: BacklogTransitions = { fixed: [], invalidated: [], seenAgain: [] };
  const base = result.change.baseRef;
  if (result.status === "failed" || !base) return none;
  const reported = new Set(result.findings.map((finding) => finding.fingerprint));
  const reviewed = new Set(result.coverage.reviewedFiles);
  const out: BacklogTransitions = { fixed: [], invalidated: [], seenAgain: [] };
  for (const item of items) {
    if (item.baseBranch !== base) continue;
    if (reported.has(item.fingerprint)) {
      out.seenAgain.push(item.fingerprint);
      continue;
    }
    const gone = result.files.some(
      (file) =>
        (file.changeType === "deleted" && file.path === item.file) ||
        (file.changeType === "renamed" && file.previousPath === item.file && file.path !== item.file),
    );
    if (gone) {
      out.invalidated.push(item.fingerprint);
      continue;
    }
    if (!reviewed.has(item.file)) continue;
    const file = result.files.find((candidate) => candidate.path === item.file);
    // No patch (binary, too large, or a result stored before diffs were kept)
    // means the touched lines are unknown, so nothing is resolved.
    if (!file?.patch) continue;
    if (patchTouches(file.patch, item.startLine, item.endLine ?? item.startLine)) out.fixed.push(item.fingerprint);
  }
  return out;
}

export interface ChangeStateInput {
  repositoryId: string;
  number: number;
  state: ChangeStateValue;
  // The branch the change targets; looked up from its review when unknown.
  baseBranch?: string | null;
  closedAt?: Date | null;
}

export interface MergeOutcome {
  promoted: number;
  fixed: number;
  invalidated: number;
}

// Records what is known about a change being open, closed or merged, and the
// first time it is merged, moves the backlog: earlier items its review shows
// were fixed are resolved first, then its own unaddressed findings are added.
// In that order, so the change's own findings are never resolved by its own
// review. Returns null when nothing was merged now (not merged, or already
// processed): a webhook delivered twice, or the sweep and a webhook both
// noticing, add nothing.
export async function recordChangeState(input: ChangeStateInput): Promise<MergeOutcome | null> {
  const { repositoryId, number, state } = input;
  const now = new Date();
  return prisma.$transaction(async (tx) => {
    await lockChange(tx, "backlog", repositoryId, 0);
    const existing = await tx.changeState.findUnique({ where: { repositoryId_number: { repositoryId, number } } });
    if (existing?.state === "merged") {
      await tx.changeState.update({ where: { id: existing.id }, data: { checkedAt: now } });
      return null;
    }
    // Open is the default for a change with no row: only one recorded as
    // closed needs saying so (a reopened change).
    if (state === "open" && !existing) return null;
    const closedAt = state === "open" ? null : (input.closedAt ?? existing?.closedAt ?? now);
    const baseBranch = input.baseBranch ?? existing?.baseBranch ?? null;
    if (state !== "merged") {
      await tx.changeState.upsert({
        where: { repositoryId_number: { repositoryId, number } },
        create: { repositoryId, number, state, baseBranch, closedAt, checkedAt: now },
        update: { state, baseBranch, closedAt, checkedAt: now },
      });
      return null;
    }

    // The newest review that stored a result speaks for what merged. A push
    // after it that was never reviewed is not seen; nothing better is known.
    const job = await tx.reviewJob.findFirst({
      where: { repositoryId, number, status: { in: ["completed", "partial"] }, resultExpiredAt: null },
      orderBy: { createdAt: "desc" },
      select: { id: true, result: true },
    });
    const parsed = job?.result ? reviewResultSchema.safeParse(job.result) : null;
    const result = parsed?.success ? parsed.data : null;
    const repo = await tx.repository.findUniqueOrThrow({ where: { id: repositoryId }, select: { defaultBranch: true } });
    const branch = baseBranch ?? result?.change.baseRef ?? repo.defaultBranch;

    await tx.changeState.upsert({
      where: { repositoryId_number: { repositoryId, number } },
      create: { repositoryId, number, state, baseBranch: branch, closedAt, checkedAt: now },
      update: { state, baseBranch: branch, closedAt, checkedAt: now },
    });

    let fixed = 0;
    let invalidated = 0;
    if (result && job) {
      const open = await tx.backlogItem.findMany({
        where: { repositoryId, state: "open", baseBranch: branch },
        select: { fingerprint: true, file: true, startLine: true, endLine: true, baseBranch: true },
      });
      const moves = backlogTransitions(open, { ...result, change: { ...result.change, baseRef: branch } });
      const resolve = (prints: string[], resolution: "fixed" | "invalidated") =>
        tx.backlogItem.updateMany({
          where: { repositoryId, state: "open", fingerprint: { in: prints } },
          data: { state: "resolved", resolution, resolvedNumber: number, resolvedJobId: job.id, resolvedAt: now },
        });
      if (moves.fixed.length) fixed = (await resolve(moves.fixed, "fixed")).count;
      if (moves.invalidated.length) invalidated = (await resolve(moves.invalidated, "invalidated")).count;
      if (moves.seenAgain.length) {
        await tx.backlogItem.updateMany({
          where: { repositoryId, state: "open", fingerprint: { in: moves.seenAgain } },
          data: { lastSeenAt: now },
        });
      }
    }

    // Ignored for any other reason (a false positive, intentional) is a
    // decision already made about the finding, not work left to do.
    const findings = await tx.finding.findMany({
      where: { repositoryId, number, OR: [{ state: "open" }, { state: "ignored", ignoreReason: "fix_later" }] },
    });
    const mergedAt = closedAt ?? now;
    let promoted = 0;
    for (const finding of findings) {
      const snapshot = {
        baseBranch: branch,
        sourceNumber: number,
        sourceChangeTitle: finding.changeTitle,
        author: finding.author,
        title: finding.title,
        file: finding.file,
        startLine: finding.startLine,
        endLine: finding.endLine,
        severity: finding.severity,
        category: finding.category,
        kind: finding.kind,
        ruleId: finding.ruleId,
        model: finding.model,
        origin: finding.state === "ignored" ? ("fix_later" as const) : ("open" as const),
        ignoreNote: finding.state === "ignored" ? finding.ignoreNote : null,
        mergedAt,
        lastSeenAt: finding.lastSeenAt,
      };
      const item = await tx.backlogItem.findUnique({
        where: { repositoryId_fingerprint: { repositoryId, fingerprint: finding.fingerprint } },
        select: { id: true, state: true, firstSeenAt: true },
      });
      if (!item) {
        await tx.backlogItem.create({
          data: { repositoryId, fingerprint: finding.fingerprint, firstSeenAt: finding.firstSeenAt, ...snapshot },
        });
      } else if (item.state === "dismissed") {
        // Dismissing is a person's call; shipping the problem again does not undo it.
        continue;
      } else {
        // Open: the same problem shipped again, refreshed. Resolved: it is back.
        // The dismiss route does not hold the backlog lock, so a dismissal can
        // land after the read above: the write checks again.
        const { count } = await tx.backlogItem.updateMany({
          where: { id: item.id, state: { not: "dismissed" } },
          data: {
            ...snapshot,
            state: "open",
            resolution: null,
            resolvedNumber: null,
            resolvedJobId: null,
            resolvedAt: null,
          },
        });
        if (!count) continue;
      }
      promoted++;
    }
    return { promoted, fixed, invalidated };
    // One query per finding: a change with hundreds of them needs longer than
    // Prisma's 5s default, and only this repository's backlog waits on it.
  }, { timeout: 30_000 });
}

// For callers that must not fail on it (the worker's close watch, webhooks
// after their main work): a failed record is retried by the sweep.
export function recordChangeStateQuietly(input: ChangeStateInput): Promise<MergeOutcome | null> {
  return recordChangeState(input).catch((err: unknown) => {
    // A constant format string: state and number arrive from webhook payloads.
    console.error("[backlog] could not record %s for change %d", input.state, input.number, err);
    return null;
  });
}
