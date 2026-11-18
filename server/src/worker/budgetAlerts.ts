import { Prisma } from "../generated/prisma/client.ts";
import { type Mail, mailer } from "../lib/mailer.ts";
import { prisma } from "../lib/prisma.ts";
import { mapLimit } from "../review/core/mapLimit.ts";
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
// and retried by deliveryQueue.ts; the admin emails by sendAdminEmails. Then
// sends every admin email owed. Returns how many alerts were announced.
//
// The worker does not call this: each poll it runs one runBudgetAlertPage and
// one batch of sendAdminEmails, so a scan of many workspaces, or a pile of
// owed emails, never holds up claiming reviews or dispatching deliveries for
// longer than one page or one batch.
export async function runBudgetAlerts(now = new Date(), deps: BudgetAlertDeps = defaultDeps): Promise<number> {
  let announced = 0;
  let after: string | null = null;
  do {
    const page = await runBudgetAlertPage(now, after);
    announced += page.announced;
    after = page.next;
  } while (after !== null);
  // A full batch may mean more are owed. Rows that failed stay locked, so
  // this ends once every claimable row has been tried.
  let claimed: number;
  do {
    claimed = await sendAdminEmails(now, deps);
  } while (claimed === ADMIN_EMAIL_BATCH);
  return announced;
}

// Workspaces checked per page, and how many of their transactions run at once.
// Each check holds a pooled connection for its spend aggregation, so the
// concurrency stays well under the pool the job claims share.
export const BUDGET_PAGE = 50;
const BUDGET_CONCURRENCY = 4;

// Checks the next page of budgeted workspaces after `after` (by id). `next` is
// the cursor for the following page, or null once the scan is done.
export async function runBudgetAlertPage(
  now: Date,
  after: string | null,
  limit = BUDGET_PAGE,
): Promise<{ announced: number; next: string | null }> {
  const workspaces = await prisma.workspace.findMany({
    where: { monthlyBudgetUsd: { not: null }, ...(after ? { id: { gt: after } } : {}) },
    orderBy: { id: "asc" },
    take: limit,
    select: { id: true },
  });
  const outcomes = await mapLimit(workspaces, BUDGET_CONCURRENCY, async ({ id }) => {
    try {
      return await prisma.$transaction((tx) => checkWorkspace(tx, id, now));
    } catch (err) {
      // One workspace failing must not hold up the others; the next pass retries it.
      console.error(`[worker] budget check for workspace ${id} failed`, err);
      return false;
    }
  });
  return {
    announced: outcomes.filter(Boolean).length,
    next: workspaces.length === limit ? workspaces[limit - 1]!.id : null,
  };
}

// NO KEY UPDATE, not UPDATE: it still keeps out another worker's check and a
// budget being saved (saveBudget), but not the KEY SHARE lock that every insert
// referencing the workspace takes (request logs from running reviews,
// memberships, targets). FOR UPDATE would hold those inserts up for the whole
// spend aggregation, and an open one would make this check skip the workspace.
async function checkWorkspace(tx: Prisma.TransactionClient, workspaceId: string, now: Date): Promise<boolean> {
  const [workspace] = await tx.$queryRaw<{ id: string; name: string; monthly_budget_usd: number | null }[]>`
    SELECT id, name, monthly_budget_usd FROM workspaces
    WHERE id = ${workspaceId}::uuid
    FOR NO KEY UPDATE SKIP LOCKED
  `;
  // Locked by another worker, or the budget was cleared since the list was read.
  if (!workspace?.monthly_budget_usd) return false;
  const budget = workspace.monthly_budget_usd;
  const month = monthStart(now);
  const [spend, sent] = await Promise.all([
    monthSpend(workspaceId, now, tx),
    tx.budgetAlert.findMany({ where: { workspaceId, month }, select: { threshold: true } }),
  ]);
  const { announce } = dueAlert(
    spend.usd,
    budget,
    sent.map((row) => row.threshold),
  );
  if (announce === null) return false;

  const payload = budgetPayload({ id: workspace.id, name: workspace.name }, month, announce, spend, budget);
  const adminUserIds = mailer.configured() ? await adminRecipients(tx, workspaceId) : [];
  await tx.budgetAlert.create({
    data: {
      workspaceId,
      month,
      threshold: announce,
      spendUsd: spend.usd,
      budgetUsd: budget,
      createdAt: now,
      // The admin email rides on the alert row, in this transaction, so the
      // threshold is never recorded without it.
      ...(adminUserIds.length ? { adminUserIds, adminEmailPayload: payload as unknown as Prisma.InputJsonValue } : {}),
    },
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
// workspace with no listening target still finds out. One also on an email
// target listening for budget alerts is mailed all the same: that target can be
// paused before it sends, or give up on a recipient for good, and a second copy
// of an alert beats none.
async function adminRecipients(tx: Prisma.TransactionClient, workspaceId: string): Promise<string[]> {
  const admins = await tx.membership.findMany({
    where: { workspaceId, role: { in: ["owner", "admin"] } },
    select: { userId: true },
  });
  return admins.map((admin) => admin.userId);
}

interface ClaimedEmail {
  id: string;
  workspace_id: string;
  admin_user_ids: string[];
  admin_email_payload: BudgetPayload;
  admin_email_attempts: number;
  admin_email_locked_at: Date;
}

// Sends one batch of the admin emails still owed, claimed like target
// deliveries (deliveryQueue.ts claimDueDeliveries): SKIP LOCKED so two workers
// never mail the same alert at once, the attempt counted before sending, and
// locked_at cut to milliseconds so it can serve as the claim's token. A lock
// older than any send takes means its worker died, so the claim takes such
// rows back itself; that can mail someone twice, which beats never mailing
// them. Only this month's alerts are sent: late news about a budget is no news.
//
// The worker calls this once per poll, so a pile of owed emails drains a batch
// at a time and never holds up claims and deliveries for longer than one. A row
// whose emails failed stays locked, so the stale lock is its backoff: it is
// tried again DELIVERY_LOCK_TIMEOUT_MS later, however often this runs, and
// MAX_DELIVERY_ATTEMPTS covers a few outages' worth rather than a few polls.
// Returns how many rows were claimed.
export async function sendAdminEmails(
  now: Date,
  deps: BudgetAlertDeps = defaultDeps,
  batchSize = ADMIN_EMAIL_BATCH,
): Promise<number> {
  const staleBefore = new Date(Date.now() - DELIVERY_LOCK_TIMEOUT_MS);
  // The pick is a MATERIALIZED CTE, not `WHERE id IN (subquery)`: Postgres can
  // plan the IN as a semi join that rescans the subquery for every row it
  // updates, and each rescan skips the rows this statement already updated
  // and hands out the next ones, so the LIMIT stops limiting anything.
  const claimed = await prisma.$queryRaw<ClaimedEmail[]>`
    WITH picked AS MATERIALIZED (
      SELECT id FROM budget_alerts
      WHERE month = ${monthStart(now)}
        AND cardinality(admin_user_ids) > 0
        AND admin_email_attempts < ${MAX_DELIVERY_ATTEMPTS}
        AND (admin_email_locked_at IS NULL OR admin_email_locked_at < ${staleBefore})
      ORDER BY created_at, id
      LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE budget_alerts b
    SET admin_email_locked_at = date_trunc('milliseconds', clock_timestamp()),
        admin_email_attempts = b.admin_email_attempts + 1
    FROM picked
    WHERE b.id = picked.id
    RETURNING b.id, b.workspace_id, b.admin_user_ids, b.admin_email_payload, b.admin_email_attempts, b.admin_email_locked_at
  `;
  for (const row of claimed) {
    try {
      await sendAdminEmail(row, deps);
    } catch (err) {
      // Left locked; once the lock is stale a later call claims it again.
      console.error(`[notify] could not email about budget alert ${row.id}`, err);
    }
  }
  return claimed.length;
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
  // Only the ones that failed are owed it still. The lock is kept: it goes
  // stale after DELIVERY_LOCK_TIMEOUT_MS, which is when the retry is due.
  await prisma.budgetAlert.updateMany({ where: claim, data: { adminUserIds: failed } });
  console.error(
    `[notify] ${failed.length} of ${admins.length} budget emails for workspace ${workspace} failed (attempt ${row.admin_email_attempts}); retrying in ${DELIVERY_LOCK_TIMEOUT_MS / 60_000} min`,
  );
}
