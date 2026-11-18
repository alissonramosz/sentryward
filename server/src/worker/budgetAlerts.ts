import { Prisma } from "../generated/prisma/client.ts";
import { type Mail, mailer } from "../lib/mailer.ts";
import { prisma } from "../lib/prisma.ts";
import { budgetPayload, dueAlert, monthSpend, monthStart } from "../services/budget.ts";
import { budgetEmail, type BudgetPayload, MAX_DELIVERY_ATTEMPTS } from "../services/notifications.ts";
import { DELIVERY_LOCK_TIMEOUT_MS } from "./deliveryQueue.ts";

export interface BudgetAlertDeps {
  // Sends one email; rejects when it was not sent.
  send: (mail: Mail) => Promise<void>;
}

// Admin emails claimed at once. A row's sends can each take up to the 10s SMTP
// timeouts, so a batch this size is sent well inside DELIVERY_LOCK_TIMEOUT_MS.
export const ADMIN_EMAIL_BATCH = 10;

// Late-bound so tests can replace mailer.send.
const defaultDeps: BudgetAlertDeps = { send: (mail) => mailer.send(mail) };

// Checks every workspace with a budget against its spend this UTC month and
// announces a newly crossed threshold. The announcement is the budget_alerts
// row plus a pending delivery to each target listening for budget alerts and
// the owners and admins owed an email, all written in one transaction under
// the workspace's row lock: two workers never announce the same threshold
// (SKIP LOCKED), and the unique (workspace, month, threshold) row means it is
// announced once a month whatever happens after. Target deliveries are sent
// and retried by deliveryQueue.ts; the admin emails by sendAdminEmails, at the
// end of this pass and of every later one. Returns how many alerts were
// announced.
export async function runBudgetAlerts(now = new Date(), deps: BudgetAlertDeps = defaultDeps): Promise<number> {
  const workspaces = await prisma.workspace.findMany({
    where: { monthlyBudgetUsd: { not: null } },
    select: { id: true },
  });
  let announced = 0;
  for (const { id } of workspaces) {
    try {
      if (await prisma.$transaction((tx) => checkWorkspace(tx, id, now))) announced++;
    } catch (err) {
      // One workspace failing must not hold up the others; the next pass retries it.
      console.error(`[worker] budget check for workspace ${id} failed`, err);
    }
  }
  try {
    await sendAdminEmails(now, deps);
  } catch (err) {
    // What was claimed stays locked until the lock goes stale, then is retried.
    console.error("[notify] budget emails failed", err);
  }
  return announced;
}

async function checkWorkspace(tx: Prisma.TransactionClient, workspaceId: string, now: Date): Promise<boolean> {
  const [workspace] = await tx.$queryRaw<{ id: string; name: string; monthly_budget_usd: number | null }[]>`
    SELECT id, name, monthly_budget_usd FROM workspaces
    WHERE id = ${workspaceId}::uuid
    FOR UPDATE SKIP LOCKED
  `;
  // Locked by another worker, or the budget was cleared since the list was read.
  if (!workspace?.monthly_budget_usd) return false;
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
  if (announce === null) return false;

  const payload = budgetPayload({ id: workspace.id, name: workspace.name }, month, announce, spend, budget);
  const adminUserIds = mailer.configured() ? await adminRecipients(tx, workspaceId) : [];
  await tx.budgetAlert.createMany({
    data: record.map((threshold) => ({
      workspaceId,
      month,
      threshold,
      spendUsd: spend.usd,
      budgetUsd: budget,
      createdAt: now,
      // The admin email rides on the announced row, in this transaction, so
      // the threshold is never recorded without it.
      ...(threshold === announce && adminUserIds.length
        ? { adminUserIds, adminEmailPayload: payload as unknown as Prisma.InputJsonValue }
        : {}),
    })),
    skipDuplicates: true,
  });
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
  return true;
}

// Owners and admins hear about every alert by email when mail is set up, so a
// workspace with no listening target still finds out. One already mailed by an
// email target listening for budget alerts is skipped.
async function adminRecipients(tx: Prisma.TransactionClient, workspaceId: string): Promise<string[]> {
  const [admins, emailTargets] = await Promise.all([
    tx.membership.findMany({
      where: { workspaceId, role: { in: ["owner", "admin"] } },
      select: { userId: true },
    }),
    tx.notificationTarget.findMany({
      where: { workspaceId, kind: "email", membershipId: null, active: true, events: { has: "budget" } },
      select: { recipientIds: true },
    }),
  ]);
  const covered = new Set(emailTargets.flatMap((target) => target.recipientIds));
  return admins.map((admin) => admin.userId).filter((id) => !covered.has(id));
}

interface ClaimedEmail {
  id: string;
  workspace_id: string;
  admin_user_ids: string[];
  admin_email_payload: BudgetPayload;
  admin_email_attempts: number;
  admin_email_locked_at: Date;
}

// Sends the admin emails still owed, claimed like target deliveries
// (deliveryQueue.ts claimDueDeliveries): SKIP LOCKED so two workers never mail
// the same alert at once, the attempt counted before sending, and locked_at
// cut to milliseconds so it can serve as the claim's token. A lock older than
// any send takes means its worker died, so the claim takes such rows back
// itself; that can mail someone twice, which beats never mailing them. Only
// this month's alerts are sent: late news about a budget is no news. Retries
// follow the budget pass's interval rather than a backoff of their own.
//
// Rows are claimed a batch at a time and the next batch only once this one is
// sent, so no claimed row waits behind the others long enough for its lock to
// go stale and another worker to mail it again. A row already handled in this
// pass is not claimed again: one whose emails partly failed is unlocked for a
// retry, which belongs to the next pass, not to this one's next batch.
export async function sendAdminEmails(
  now: Date,
  deps: BudgetAlertDeps = defaultDeps,
  batchSize = ADMIN_EMAIL_BATCH,
): Promise<void> {
  const handled: string[] = [];
  for (;;) {
    const staleBefore = new Date(Date.now() - DELIVERY_LOCK_TIMEOUT_MS);
    const claimed = await prisma.$queryRaw<ClaimedEmail[]>`
      UPDATE budget_alerts
      SET admin_email_locked_at = date_trunc('milliseconds', clock_timestamp()),
          admin_email_attempts = admin_email_attempts + 1
      WHERE id IN (
        SELECT id FROM budget_alerts
        WHERE month = ${monthStart(now)}
          AND cardinality(admin_user_ids) > 0
          AND admin_email_attempts < ${MAX_DELIVERY_ATTEMPTS}
          AND (admin_email_locked_at IS NULL OR admin_email_locked_at < ${staleBefore})
          AND NOT (id = ANY(${handled}::uuid[]))
        ORDER BY created_at, id
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, workspace_id, admin_user_ids, admin_email_payload, admin_email_attempts, admin_email_locked_at
    `;
    for (const row of claimed) {
      handled.push(row.id);
      try {
        await sendAdminEmail(row, deps);
      } catch (err) {
        // Left locked; once the lock is stale a later pass claims it again.
        console.error(`[notify] could not email about budget alert ${row.id}`, err);
      }
    }
    if (claimed.length < batchSize) return;
  }
}

async function sendAdminEmail(row: ClaimedEmail, deps: BudgetAlertDeps): Promise<void> {
  const claim = { id: row.id, adminEmailLockedAt: row.admin_email_locked_at };
  const done = { adminUserIds: [], adminEmailPayload: Prisma.DbNull, adminEmailLockedAt: null };
  if (!mailer.configured() || !row.admin_email_payload) {
    await prisma.budgetAlert.updateMany({ where: claim, data: done });
    return;
  }
  // Re-read so the mail goes to the current address, and not to anyone who
  // stopped being an owner or admin since the alert was announced.
  const admins = await prisma.membership.findMany({
    where: { workspaceId: row.workspace_id, userId: { in: row.admin_user_ids }, role: { in: ["owner", "admin"] } },
    select: { userId: true, user: { select: { email: true } } },
  });
  const mail = budgetEmail(row.admin_email_payload);
  const results = await Promise.allSettled(admins.map((admin) => deps.send({ to: admin.user.email, ...mail })));
  const failed = admins.filter((_, i) => results[i]!.status === "rejected").map((admin) => admin.userId);

  if (!failed.length) {
    await prisma.budgetAlert.updateMany({ where: claim, data: done });
    return;
  }
  const workspace = row.workspace_id;
  if (row.admin_email_attempts >= MAX_DELIVERY_ATTEMPTS) {
    await prisma.budgetAlert.updateMany({ where: claim, data: done });
    console.error(
      `[notify] ${failed.length} of ${admins.length} budget emails for workspace ${workspace} failed after ${row.admin_email_attempts} attempt(s)`,
    );
    return;
  }
  // Only the ones that failed are owed it still.
  await prisma.budgetAlert.updateMany({ where: claim, data: { adminUserIds: failed, adminEmailLockedAt: null } });
  console.error(
    `[notify] ${failed.length} of ${admins.length} budget emails for workspace ${workspace} failed (attempt ${row.admin_email_attempts}); retrying next pass`,
  );
}
