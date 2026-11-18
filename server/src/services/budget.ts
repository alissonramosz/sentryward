import { env } from "../config/env.ts";
import type { Prisma } from "../generated/prisma/client.ts";
import { mailer } from "../lib/mailer.ts";
import { prisma } from "../lib/prisma.ts";
import { roundUsd } from "../review/core/pricing/pricing.ts";
import { listModelPrices } from "./modelPrices.ts";
import type { BudgetPayload } from "./notifications.ts";
import { floorTo } from "./usage.ts";

// Percentages of the monthly budget that are announced, each at most once a
// month. 110 is the over-budget alert: spending the budget exactly is news on
// its own (100), and running well past it is news again.
export const BUDGET_THRESHOLDS = [50, 75, 90, 100, 110] as const;
export const OVER_BUDGET_PERCENT = 110;
export const MAX_MONTHLY_BUDGET_USD = 1_000_000;

// Months are the Usage page's UTC buckets, so every viewer and worker agrees
// on when one starts.
export function monthStart(now: Date): Date {
  return floorTo(now, "month");
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

// Whether a month's spend has reached a percentage of the budget.
export function crossed(spend: number, budget: number, threshold: number): boolean {
  return budget > 0 && spend * 100 >= threshold * budget;
}

// The threshold to announce: the highest the month's spend has crossed, when
// it is above every one announced so far. Only that one is announced and
// recorded, so a budget set mid-month, or one costly review, sends one message
// rather than a burst, and the alerts recorded are exactly the ones sent. The
// lower ones it passed never come up again, since the highest sent covers them.
export function dueAlert(spend: number, budget: number, sent: readonly number[]): { announce: number | null } {
  const highest = BUDGET_THRESHOLDS.filter((threshold) => crossed(spend, budget, threshold)).at(-1);
  const covered = Math.max(0, ...sent);
  return { announce: highest !== undefined && highest > covered ? highest : null };
}

// Forgets this month's alerts for thresholds the spend no longer reaches under
// a new budget, so raising it re-arms them: without this, an alert at 100% of
// the old budget would silence 100% of the new one for the rest of the month.
// Thresholds still crossed stay recorded, so saving the same budget again
// sends nothing twice. An admin email still owed on a deleted row goes too:
// it was about a threshold the new budget has not reached. Call in the
// transaction that saves the budget, after the update, so the workspace row
// lock keeps a budget check from running in between (budgetAlerts.ts).
export async function resetUncrossedAlerts(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  budget: number,
  now: Date,
): Promise<void> {
  const month = monthStart(now);
  const spend = await monthSpend(workspaceId, now, tx);
  const uncrossed = BUDGET_THRESHOLDS.filter((threshold) => !crossed(spend.usd, budget, threshold));
  if (!uncrossed.length) return;
  await tx.budgetAlert.deleteMany({ where: { workspaceId, month, threshold: { in: uncrossed } } });
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
export async function unpricedModels(workspaceId: string, now = new Date()): Promise<string[]> {
  const { models } = await listModelPrices(workspaceId, now);
  return models.filter((model) => model.price === null).map((model) => model.model);
}

// Everything the budget card shows. A caller that has just looked up the
// unpriced models passes them, so they are not read twice.
export async function budgetStatus(workspaceId: string, now = new Date(), knownUnpriced?: string[]) {
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
    knownUnpriced ?? unpricedModels(workspaceId, now),
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
