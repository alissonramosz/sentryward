import { env } from "../config/env.ts";
import type { Prisma } from "../generated/prisma/client.ts";
import { mailer } from "../lib/mailer.ts";
import { prisma } from "../lib/prisma.ts";
import { roundUsd } from "../review/core/pricing/pricing.ts";
import { listModelPrices } from "./modelPrices.ts";
import type { BudgetPayload } from "./notifications.ts";
import { digestTotals } from "./usage.ts";

// Percentages of the monthly budget that are announced, each at most once a
// month. 110 is the over-budget alert: spending the budget exactly is news on
// its own (100), and running well past it is news again.
export const BUDGET_THRESHOLDS = [50, 75, 90, 100, 110] as const;
export const OVER_BUDGET_PERCENT = 110;
export const MAX_MONTHLY_BUDGET_USD = 1_000_000;

// Months are UTC, like the Usage page's buckets, so every viewer and worker
// agrees on when one starts.
export function monthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export function monthLabel(month: Date): string {
  return month.toISOString().slice(0, 7);
}

// The same runs the Usage page counts, so an alert and the page agree.
export async function monthSpend(
  workspaceId: string,
  now: Date,
  db: Prisma.TransactionClient = prisma,
): Promise<{ usd: number; unpricedCalls: number }> {
  const jobs = await db.reviewJob.findMany({
    where: {
      repository: { connection: { workspaceId } },
      createdAt: { gte: monthStart(now) },
      status: { notIn: ["superseded", "skipped", "cancelled"] },
    },
    select: { summary: true },
  });
  let usd = 0;
  let unpricedCalls = 0;
  for (const job of jobs) {
    const totals = digestTotals(job.summary);
    usd += totals.usd;
    unpricedCalls += totals.unpricedCalls;
  }
  return { usd: roundUsd(usd), unpricedCalls };
}

export function percentOf(spend: number, budget: number): number {
  return budget > 0 ? Math.floor((spend / budget) * 100) : 0;
}

// The thresholds a month's spend has crossed that were not announced yet, and
// the one to announce: only the highest, so a budget set mid-month, or one
// costly review, sends one message rather than a burst. The rest are recorded
// as announced all the same.
export function dueAlert(
  spend: number,
  budget: number,
  sent: readonly number[],
): { record: number[]; announce: number | null } {
  if (!(budget > 0)) return { record: [], announce: null };
  const record = BUDGET_THRESHOLDS.filter((threshold) => spend * 100 >= threshold * budget && !sent.includes(threshold));
  return { record, announce: record.length ? record[record.length - 1]! : null };
}

export function budgetPayload(
  workspace: { id: string; name: string },
  month: Date,
  threshold: number,
  spend: { usd: number; unpricedCalls: number },
  budgetUsd: number,
): BudgetPayload {
  return {
    event: "budget",
    workspace,
    month: monthLabel(month),
    threshold,
    overBudget: threshold >= OVER_BUDGET_PERCENT,
    spendUsd: spend.usd,
    budgetUsd,
    percent: percentOf(spend.usd, budgetUsd),
    unpricedCalls: spend.unpricedCalls,
    url: `${env.CLIENT_ORIGIN}/usage`,
  };
}

// Models the workspace's recent reviews called that no price covers. Their
// calls cost nothing in the spend, so a budget cannot be switched on while any
// are left.
export async function unpricedModels(workspaceId: string): Promise<string[]> {
  const { models } = await listModelPrices(workspaceId);
  return models.filter((model) => model.price === null).map((model) => model.model);
}

// Everything the budget card shows.
export async function budgetStatus(workspaceId: string, now = new Date()) {
  const month = monthStart(now);
  const [workspace, spend, alerts, budgetTargets, unpriced] = await Promise.all([
    prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { monthlyBudgetUsd: true } }),
    monthSpend(workspaceId, now),
    prisma.budgetAlert.findMany({
      where: { workspaceId, month },
      orderBy: { threshold: "asc" },
      select: { threshold: true, createdAt: true },
    }),
    prisma.notificationTarget.count({
      where: { workspaceId, membershipId: null, active: true, events: { has: "budget" } },
    }),
    unpricedModels(workspaceId),
  ]);
  const budget = workspace.monthlyBudgetUsd;
  return {
    monthlyBudgetUsd: budget,
    month: monthLabel(month),
    spendUsd: spend.usd,
    percent: budget ? percentOf(spend.usd, budget) : null,
    unpricedCalls: spend.unpricedCalls,
    unpricedModels: unpriced,
    alertsSent: alerts.map((alert) => ({ threshold: alert.threshold, at: alert.createdAt.toISOString() })),
    budgetTargets,
    // Owners and admins are mailed every alert too, when mail is set up.
    adminEmail: mailer.configured(),
  };
}
