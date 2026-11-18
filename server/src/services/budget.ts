import { env } from "../config/env.ts";
import type { Prisma } from "../generated/prisma/client.ts";
import { mailer } from "../lib/mailer.ts";
import { prisma } from "../lib/prisma.ts";
import { roundUsd } from "../review/core/pricing/pricing.ts";
import { listModelPrices } from "./modelPrices.ts";
import type { BudgetPayload } from "./notifications.ts";

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

// The same runs the Usage page counts, so an alert and the page agree. Summed
// in Postgres so a check reads one row, not every digest of the month: the
// worker runs it for each budgeted workspace every pass, and the budget card on
// each request. Keep it in step with totalsOf (usage.ts): cost.total and
// unpricedCalls per model, each review rounded like roundUsd; digests from
// before per-model usage carry no cost and add nothing.
export async function monthSpend(
  workspaceId: string,
  now: Date,
  db: Prisma.TransactionClient = prisma,
): Promise<{ usd: number; unpricedCalls: number }> {
  const [row] = await db.$queryRaw<{ usd: number; unpriced_calls: number }[]>`
    SELECT COALESCE(SUM(job.usd), 0)::float8 AS usd,
           COALESCE(SUM(job.unpriced), 0)::int AS unpriced_calls
    FROM (
      SELECT ROUND(COALESCE(SUM((u.value->'cost'->>'total')::numeric), 0), 6) AS usd,
             COALESCE(SUM((u.value->>'unpricedCalls')::int), 0) AS unpriced
      FROM review_jobs j
      JOIN repositories r ON r.id = j.repository_id
      JOIN forge_connections c ON c.id = r.connection_id
      CROSS JOIN LATERAL jsonb_each(
        CASE WHEN jsonb_typeof(j.summary->'usageByModel') = 'object'
             THEN j.summary->'usageByModel' ELSE '{}'::jsonb END
      ) u
      WHERE c.workspace_id = ${workspaceId}::uuid
        AND j.created_at >= ${monthStart(now)}
        AND j.status::text NOT IN ('superseded', 'skipped', 'cancelled')
      GROUP BY j.id
    ) job
  `;
  return { usd: roundUsd(row?.usd ?? 0), unpricedCalls: row?.unpriced_calls ?? 0 };
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
