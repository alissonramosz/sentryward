import type { Request, Response } from "express";
import { HttpError } from "../lib/httpError.ts";
import { prisma } from "../lib/prisma.ts";
import type { Prisma } from "../generated/prisma/client.ts";
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

export async function listRuleSuggestions(req: Request, res: Response) {
  const { status } = listRuleSuggestionsQuerySchema.parse(req.query);
  const workspaceId = req.workspaceId!;
  const [suggestions, counts] = await Promise.all([
    prisma.ruleSuggestion.findMany({
      where: { workspaceId, status },
      select: suggestionSelect,
      orderBy: { createdAt: "desc" },
      take: LIST_LIMIT,
    }),
    prisma.ruleSuggestion.groupBy({ by: ["status"], where: { workspaceId }, _count: { _all: true } }),
  ]);
  const count = (name: string) => counts.find((row) => row.status === name)?._count._all ?? 0;
  res.json({
    suggestions,
    counts: { pending: count("pending"), approved: count("approved"), discarded: count("discarded") },
  });
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

// Turning suggestions off deletes the review comments kept for them: they were
// stored only for this. Cited dismissals stay, as findings in their own right.
export async function saveRuleSuggestionSettings(req: Request, res: Response) {
  const { enabled, minEvidence, excludedReviewers } = saveRuleSuggestionSettingsSchema.parse(req.body);
  const workspaceId = req.workspaceId!;
  await prisma.$transaction(async (tx) => {
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
    } else if (excludedReviewers.length) {
      // An excluded reviewer's comments are not kept, including those already stored.
      await tx.reviewComment.deleteMany({
        where: { ...inWorkspace, OR: excludedReviewers.map((login) => ({ author: { equals: login, mode: "insensitive" as const } })) },
      });
    }
  });
  res.json(await settingsBody(workspaceId));
}

// Makes the workspace due, so the worker picks it up within its check
// interval. Refused while a run started within the hour.
export async function runRuleSuggestions(req: Request, res: Response) {
  const workspaceId = req.workspaceId!;
  const recent = new Date(Date.now() - RUN_COOLDOWN_MS);
  const updated = await prisma.workspace.updateMany({
    where: {
      id: workspaceId,
      ruleSuggestionsEnabled: true,
      OR: [{ ruleSuggestionsLastRunAt: null }, { ruleSuggestionsLastRunAt: { lt: recent } }],
    },
    data: { ruleSuggestionsLastRunAt: null },
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
    await lockPending(tx, workspaceId, id);
    // Under the workspace row lock, like the other writers of reviewSettings,
    // so a global save meanwhile is not overwritten with a stale copy.
    const [workspace] = await tx.$queryRaw<{ review_settings: unknown }[]>`
      SELECT review_settings FROM workspaces WHERE id = ${workspaceId}::uuid FOR NO KEY UPDATE
    `;
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
