import type { Request, Response } from "express";
import { HttpError } from "../lib/httpError.ts";
import { prisma } from "../lib/prisma.ts";
import { Prisma } from "../generated/prisma/client.ts";
import { dashboardOverrideSchema, type DashboardOverride, type Rule } from "../review/config/schema.ts";
import {
  approveRuleSuggestionSchema,
  listRuleSuggestionsQuerySchema,
  ruleSuggestionIdParamSchema,
  saveRuleSuggestionSettingsSchema,
} from "../schemas/ruleSuggestions.schema.ts";
import { requireRepoSettingsRules } from "./repos.controller.ts";

// Rule suggestions drafted by worker/ruleSuggestions.ts. Nothing reaches a
// config layer until an admin approves one here, through the same checks as
// saving the settings by hand.

const LIST_LIMIT = 100;
// "Check now" starts a model call; once an hour is plenty for a weekly job.
const RUN_COOLDOWN_MS = 60 * 60 * 1000;

const suggestionSelect = {
  id: true,
  status: true,
  rule: true,
  rationale: true,
  evidence: true,
  model: true,
  appliedTarget: true,
  decidedAt: true,
  createdAt: true,
  repository: { select: { id: true, host: true, fullPath: true, followGlobal: true } },
} satisfies Prisma.RuleSuggestionSelect;

async function suggestionCounts(workspaceId: string) {
  const counts = await prisma.ruleSuggestion.groupBy({ by: ["status"], where: { workspaceId }, _count: { _all: true } });
  const count = (name: string) => counts.find((row) => row.status === name)?._count._all ?? 0;
  return { pending: count("pending"), approved: count("approved"), discarded: count("discarded") };
}

// Newest first, a page at a time. Keyset rather than Prisma's `cursor`: that
// looks the cursor row up again, and it may have been decided since. The page
// is picked in SQL to compare created_at at full (microsecond) precision.
export async function listRuleSuggestions(req: Request, res: Response) {
  const { status, cursor } = listRuleSuggestionsQuerySchema.parse(req.query);
  const workspaceId = req.workspaceId!;
  const after = cursor
    ? Prisma.sql`AND (created_at, id) < ('epoch'::timestamptz + ${cursor.atMicros}::bigint * interval '1 microsecond', ${cursor.id}::uuid)`
    : Prisma.empty;
  const [page, counts] = await Promise.all([
    prisma.$queryRaw<{ id: string; at_micros: string }[]>`
      SELECT id, (extract(epoch FROM created_at) * 1000000)::bigint::text AS at_micros
      FROM rule_suggestions
      WHERE workspace_id = ${workspaceId}::uuid AND status::text = ${status} ${after}
      ORDER BY created_at DESC, id DESC
      LIMIT ${LIST_LIMIT + 1}
    `,
    suggestionCounts(workspaceId),
  ]);
  const ids = page.slice(0, LIST_LIMIT).map((row) => row.id);
  const rows = await prisma.ruleSuggestion.findMany({ where: { id: { in: ids } }, select: suggestionSelect });
  const byId = new Map(rows.map((row) => [row.id, row]));
  // A row deleted between the two reads is simply left out.
  const suggestions = ids.flatMap((id) => byId.get(id) ?? []);
  const last = page[LIST_LIMIT - 1];
  const nextCursor = page.length > LIST_LIMIT && last ? `${last.at_micros}_${last.id}` : null;
  res.json({ suggestions, counts, nextCursor });
}

// Counts alone, for the nav badge on every page: the list carries each
// suggestion's evidence excerpts.
export async function countRuleSuggestions(req: Request, res: Response) {
  res.json({ counts: await suggestionCounts(req.workspaceId!) });
}

async function settingsBody(workspaceId: string) {
  const workspace = await prisma.workspace.findUniqueOrThrow({
    where: { id: workspaceId },
    select: {
      ruleSuggestionsEnabled: true,
      ruleSuggestionsMinEvidence: true,
      ruleSuggestionsExcludedReviewers: true,
      ruleSuggestionsLastRunAt: true,
    },
  });
  const storedComments = await prisma.reviewComment.count({ where: { repository: { connection: { workspaceId } } } });
  return {
    enabled: workspace.ruleSuggestionsEnabled,
    minEvidence: workspace.ruleSuggestionsMinEvidence,
    excludedReviewers: workspace.ruleSuggestionsExcludedReviewers,
    lastRunAt: workspace.ruleSuggestionsLastRunAt,
    storedComments,
  };
}

export async function getRuleSuggestionSettings(req: Request, res: Response) {
  res.json(await settingsBody(req.workspaceId!));
}

// Drops the review comment excerpts (people's words) from the workspace's
// suggestions, or only from those listed. Dismissal excerpts stay with the
// findings they quote. Excerpts name no author, so a suggestion loses all its
// comment excerpts, not only one reviewer's. The rows are locked in id order
// first, as retention's excerpt trim does: two bulk UPDATEs locking the same
// rows in different orders would deadlock.
async function stripCommentExcerpts(tx: Prisma.TransactionClient, workspaceId: string, suggestionIds?: string[]) {
  const scope = suggestionIds ? Prisma.sql`AND id = ANY(${suggestionIds}::uuid[])` : Prisma.empty;
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM rule_suggestions
    WHERE workspace_id = ${workspaceId}::uuid
      AND jsonb_typeof(evidence->'excerpts') = 'array'
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(evidence->'excerpts') e WHERE e->>'kind' = 'comment')
      ${scope}
    ORDER BY id FOR UPDATE
  `;
  if (!locked.length) return;
  await tx.$executeRaw`
    UPDATE rule_suggestions SET evidence = jsonb_set(evidence, '{excerpts}', COALESCE(
      (SELECT jsonb_agg(e) FROM jsonb_array_elements(evidence->'excerpts') e WHERE e->>'kind' IS DISTINCT FROM 'comment'),
      '[]'::jsonb
    ))
    WHERE id = ANY(${locked.map((row) => row.id)}::uuid[])
  `;
}

// Turning suggestions off deletes the review comments kept for them, and the
// excerpts quoting them: they were stored only for this. Cited dismissals
// stay, as findings in their own right.
export async function saveRuleSuggestionSettings(req: Request, res: Response) {
  const { enabled, minEvidence, excludedReviewers } = saveRuleSuggestionSettingsSchema.parse(req.body);
  const workspaceId = req.workspaceId!;
  await prisma.$transaction(async (tx) => {
    // First, so the row lock is held before any deletion: recordReviewComment
    // re-checks these settings under a share lock on this row before storing.
    await tx.workspace.update({
      where: { id: workspaceId },
      data: {
        ruleSuggestionsEnabled: enabled,
        ruleSuggestionsMinEvidence: minEvidence,
        ruleSuggestionsExcludedReviewers: excludedReviewers,
      },
    });
    const inWorkspace = { repository: { connection: { workspaceId } } };
    if (!enabled) {
      await tx.reviewComment.deleteMany({ where: inWorkspace });
      await stripCommentExcerpts(tx, workspaceId);
    } else if (excludedReviewers.length) {
      // An excluded reviewer's comments are not kept, including those already
      // stored, nor the excerpts of suggestions that cited them.
      const where = {
        ...inWorkspace,
        OR: excludedReviewers.map((login) => ({ author: { equals: login, mode: "insensitive" as const } })),
      };
      const cited = await tx.reviewComment.findMany({
        where: { ...where, suggestionId: { not: null } },
        select: { suggestionId: true },
        distinct: ["suggestionId"],
      });
      await tx.reviewComment.deleteMany({ where });
      if (cited.length) await stripCommentExcerpts(tx, workspaceId, cited.map((row) => row.suggestionId!));
    }
  });
  res.json(await settingsBody(workspaceId));
}

// Makes the workspace due, so the worker picks it up within its check
// interval. Refused while a run started or was requested within the hour: the
// request time is kept apart because a due workspace's last run is null, which
// would otherwise let the button be pressed again until the worker claims it.
export async function runRuleSuggestions(req: Request, res: Response) {
  const workspaceId = req.workspaceId!;
  const now = new Date();
  const recent = new Date(now.getTime() - RUN_COOLDOWN_MS);
  const updated = await prisma.workspace.updateMany({
    where: {
      id: workspaceId,
      ruleSuggestionsEnabled: true,
      AND: [
        { OR: [{ ruleSuggestionsLastRunAt: null }, { ruleSuggestionsLastRunAt: { lt: recent } }] },
        { OR: [{ ruleSuggestionsRequestedAt: null }, { ruleSuggestionsRequestedAt: { lt: recent } }] },
      ],
    },
    data: { ruleSuggestionsLastRunAt: null, ruleSuggestionsRequestedAt: now },
  });
  if (updated.count === 0) {
    const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { ruleSuggestionsEnabled: true } });
    if (!workspace.ruleSuggestionsEnabled) throw new HttpError(409, "Turn rule suggestions on first");
    throw new HttpError(429, "Suggestions were checked within the last hour; try again later");
  }
  res.status(202).json(await settingsBody(workspaceId));
}

// Locks a pending suggestion of this workspace for the rest of the transaction.
async function lockPending(tx: Prisma.TransactionClient, workspaceId: string, id: string) {
  const rows = await tx.$queryRaw<{ status: string }[]>`
    SELECT status FROM rule_suggestions WHERE id = ${id}::uuid AND workspace_id = ${workspaceId}::uuid FOR UPDATE
  `;
  if (!rows[0]) throw new HttpError(404, "Suggestion not found");
  if (rows[0].status !== "pending") throw new HttpError(409, "This suggestion was already decided");
}

function takenId(rule: Rule): never {
  const message = `A rule named ${rule.id} already exists there; choose another id`;
  throw new HttpError(400, "Validation failed", { "rule.id": [message] });
}

// The saved settings with the rule added, validated as a whole: the limits on
// rule count and total size are checked by the same schema the settings
// pages save through.
function withRule(saved: unknown, rule: Rule, label: string): DashboardOverride {
  const parsed = dashboardOverrideSchema.safeParse(saved ?? {});
  if (!parsed.success) throw new HttpError(409, `The saved ${label} settings are not valid; fix them before adding rules`);
  if (parsed.data.rules?.some((existing) => existing.id === rule.id)) takenId(rule);
  const next = dashboardOverrideSchema.safeParse({ ...parsed.data, rules: [...(parsed.data.rules ?? []), rule] });
  if (!next.success) {
    const message = next.error.issues.find((issue) => issue.path[0] === "rules")?.message ?? "These settings cannot take another rule";
    throw new HttpError(400, "Validation failed", { rules: [message] });
  }
  return next.data;
}

export async function approveRuleSuggestion(req: Request, res: Response) {
  const { id } = ruleSuggestionIdParamSchema.parse(req.params);
  const { rule, target } = approveRuleSuggestionSchema.parse(req.body);
  const workspaceId = req.workspaceId!;

  const suggestion = await prisma.$transaction(async (tx) => {
    // Under the workspace row lock, so concurrent approvals each add to the
    // latest settings. The global settings save (updateGlobalConfig) replaces
    // the whole object without it, so a settings form left open can still
    // drop this rule; the client refreshes the global config on approve to
    // keep that window short. Taken before the suggestion's lock, in the same
    // order as saveRuleSuggestionSettings (workspace, then suggestions), which
    // would otherwise deadlock with this.
    const [workspace] = await tx.$queryRaw<{ review_settings: unknown }[]>`
      SELECT review_settings FROM workspaces WHERE id = ${workspaceId}::uuid FOR NO KEY UPDATE
    `;
    await lockPending(tx, workspaceId, id);
    let appliedTarget: string;
    if (target === "global") {
      const settings = withRule(workspace!.review_settings, rule, "global");
      await tx.workspace.update({ where: { id: workspaceId }, data: { reviewSettings: settings } });
      appliedTarget = "global";
    } else {
      // Same row lock as the repository and folder saves (repos.controller.ts).
      const [repo] = await tx.$queryRaw<{ id: string }[]>`
        SELECT r.id FROM repositories r JOIN forge_connections c ON c.id = r.connection_id
        WHERE r.id = ${target.repositoryId}::uuid AND c.workspace_id = ${workspaceId}::uuid
        FOR UPDATE OF r
      `;
      if (!repo) throw new HttpError(404, "Repository not found");
      const saved = await tx.repository.findUniqueOrThrow({
        where: { id: repo.id },
        select: { settings: true, directories: true, followGlobal: true },
      });
      if (saved.followGlobal) {
        throw new HttpError(409, "This repository follows the global settings, so its own rules would be ignored: choose Global, or give it settings of its own first");
      }
      const settings = withRule(saved.settings, rule, "repository");
      requireRepoSettingsRules(workspace!.review_settings, saved, settings, false);
      await tx.repository.update({ where: { id: repo.id }, data: { settings } });
      appliedTarget = repo.id;
    }
    return tx.ruleSuggestion.update({
      where: { id },
      data: {
        status: "approved",
        rule: rule as Prisma.InputJsonValue,
        appliedTarget,
        decidedById: req.userId!,
        decidedAt: new Date(),
      },
      select: suggestionSelect,
    });
  });
  res.json({ suggestion });
}

// A discarded suggestion is shown to later runs as one not to propose again;
// its evidence stays cited, so the same history does not bring it back.
export async function discardRuleSuggestion(req: Request, res: Response) {
  const { id } = ruleSuggestionIdParamSchema.parse(req.params);
  const workspaceId = req.workspaceId!;
  const suggestion = await prisma.$transaction(async (tx) => {
    await lockPending(tx, workspaceId, id);
    return tx.ruleSuggestion.update({
      where: { id },
      data: { status: "discarded", decidedById: req.userId!, decidedAt: new Date() },
      select: suggestionSelect,
    });
  });
  res.json({ suggestion });
}
