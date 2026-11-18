import type { Prisma } from "../generated/prisma/client.ts";
import { mailer } from "../lib/mailer.ts";
import { prisma } from "../lib/prisma.ts";
import { budgetPayload, dueAlert, monthSpend, monthStart } from "../services/budget.ts";
import { budgetEmail, type BudgetPayload } from "../services/notifications.ts";

export interface BudgetAlertDeps {
  // Mails the owners and admins about one alert. Never throws.
  emailAdmins: (workspaceId: string, payload: BudgetPayload) => Promise<void>;
}

const defaultDeps: BudgetAlertDeps = { emailAdmins: emailBudgetToAdmins };

// Checks every workspace with a budget against its spend this UTC month and
// announces a newly crossed threshold. The announcement is the budget_alerts
// row plus a pending delivery to each target listening for budget alerts,
// written in one transaction under the workspace's row lock: two workers never
// announce the same threshold (SKIP LOCKED), and the unique (workspace, month,
// threshold) row means it is announced once a month whatever happens after.
// Sending and retries are deliveryQueue.ts's, as for any delivery. Owners and
// admins are mailed after the commit, best-effort. Returns how many alerts
// were announced.
export async function runBudgetAlerts(now = new Date(), deps: BudgetAlertDeps = defaultDeps): Promise<number> {
  const workspaces = await prisma.workspace.findMany({
    where: { monthlyBudgetUsd: { not: null } },
    select: { id: true },
  });
  let announced = 0;
  for (const { id } of workspaces) {
    try {
      const payload = await prisma.$transaction((tx) => checkWorkspace(tx, id, now));
      if (!payload) continue;
      announced++;
      await deps.emailAdmins(id, payload);
    } catch (err) {
      // One workspace failing must not hold up the others; the next pass retries it.
      console.error(`[worker] budget check for workspace ${id} failed`, err);
    }
  }
  return announced;
}

async function checkWorkspace(tx: Prisma.TransactionClient, workspaceId: string, now: Date): Promise<BudgetPayload | null> {
  const [workspace] = await tx.$queryRaw<{ id: string; name: string; monthly_budget_usd: number | null }[]>`
    SELECT id, name, monthly_budget_usd FROM workspaces
    WHERE id = ${workspaceId}::uuid
    FOR UPDATE SKIP LOCKED
  `;
  // Locked by another worker, or the budget was cleared since the list was read.
  if (!workspace?.monthly_budget_usd) return null;
  const budget = workspace.monthly_budget_usd;
  const month = monthStart(now);
  const [spend, sent] = await Promise.all([
    monthSpend(workspaceId, now, tx),
    tx.budgetAlert.findMany({ where: { workspaceId, month }, select: { threshold: true } }),
  ]);
  const { record, announce } = dueAlert(
    spend.usd,
    budget,
    sent.map((row) => row.threshold),
  );
  if (announce === null) return null;

  await tx.budgetAlert.createMany({
    data: record.map((threshold) => ({ workspaceId, month, threshold, spendUsd: spend.usd, budgetUsd: budget, createdAt: now })),
    skipDuplicates: true,
  });
  const payload = budgetPayload({ id: workspace.id, name: workspace.name }, month, announce, spend, budget);
  // Repository scope, severity filters and digest schedules are about reviews:
  // a budget is the whole workspace's, and late news about it is no news, so
  // every listening target gets it at once. Personal targets are about a
  // member's own changes and never get it.
  const targets = await tx.notificationTarget.findMany({
    where: { workspaceId, membershipId: null, active: true, events: { has: "budget" } },
    select: { id: true },
  });
  if (targets.length) {
    await tx.notificationDelivery.createMany({
      data: targets.map((target) => ({
        targetId: target.id,
        event: "budget",
        status: "pending" as const,
        attempts: 0,
        payload: payload as unknown as Prisma.InputJsonValue,
        nextAttemptAt: now,
        createdAt: now,
      })),
    });
  }
  return payload;
}

// Owners and admins hear about every alert by email when mail is set up, so a
// workspace with no listening target still finds out. One already mailed by an
// email target listening for budget alerts is skipped. Not retried: like
// emailAboutPause, this is a nudge beside the targets, not the outbox.
export async function emailBudgetToAdmins(workspaceId: string, payload: BudgetPayload): Promise<void> {
  if (!mailer.configured()) return;
  try {
    const [admins, emailTargets] = await Promise.all([
      prisma.membership.findMany({
        where: { workspaceId, role: { in: ["owner", "admin"] } },
        select: { userId: true, user: { select: { email: true } } },
      }),
      prisma.notificationTarget.findMany({
        where: { workspaceId, kind: "email", membershipId: null, active: true, events: { has: "budget" } },
        select: { recipientIds: true },
      }),
    ]);
    const covered = new Set(emailTargets.flatMap((target) => target.recipientIds));
    const recipients = admins.filter((admin) => !covered.has(admin.userId)).map((admin) => admin.user.email);
    if (!recipients.length) return;
    const mail = budgetEmail(payload);
    const results = await Promise.allSettled(recipients.map((to) => mailer.send({ to, ...mail })));
    const failed = results.filter((result) => result.status === "rejected").length;
    if (failed) console.error(`[notify] ${failed} of ${recipients.length} budget emails for workspace ${workspaceId} failed`);
  } catch (err) {
    console.error(`[notify] could not email about the budget of workspace ${workspaceId}`, err);
  }
}
