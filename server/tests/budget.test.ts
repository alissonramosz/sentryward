import request from "supertest";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app.ts";
import type { NotificationEvent, NotificationKind } from "../src/generated/prisma/client.ts";
import { encrypt } from "../src/lib/crypto.ts";
import { mailer } from "../src/lib/mailer.ts";
import { prisma } from "../src/lib/prisma.ts";
import { budgetPayload, dueAlert, monthSpend, monthStart } from "../src/services/budget.ts";
import { deliver, notifyJob } from "../src/services/notifications.ts";
import { runBudgetAlertPage, runBudgetAlerts, sendAdminEmails } from "../src/worker/budgetAlerts.ts";
import { claimDueDeliveries, runDelivery } from "../src/worker/deliveryQueue.ts";
import { runRetention } from "../src/worker/retention.ts";
import { fetchStub } from "./helpers/fetchStub.ts";
import { addMember, createUser } from "./helpers/users.ts";

const PRICED = "anthropic/claude-sonnet-5-5";
const NOW = new Date("2026-11-18T12:00:00Z");

describe("dueAlert", () => {
  it("announces nothing below the first threshold or without a budget", () => {
    expect(dueAlert(4.99, 10, [])).toEqual({ announce: null });
    expect(dueAlert(100, 0, [])).toEqual({ announce: null });
  });

  it("announces a threshold once it is reached", () => {
    expect(dueAlert(5, 10, [])).toEqual({ announce: 50 });
    expect(dueAlert(5, 10, [50])).toEqual({ announce: null });
  });

  it("announces only the highest of the thresholds crossed at once", () => {
    expect(dueAlert(9.5, 10, [])).toEqual({ announce: 90 });
    expect(dueAlert(11, 10, [50])).toEqual({ announce: 110 });
  });

  it("treats the highest threshold sent as covering the ones below it", () => {
    expect(dueAlert(9.5, 10, [90])).toEqual({ announce: null });
    expect(dueAlert(10.1, 10, [90])).toEqual({ announce: 100 });
  });

  it("does not repeat a threshold the budget still reaches, and goes on from there after it is lowered", () => {
    // 50 and 75 announced at a budget of 10; raised to 20, spend 16 is 80%.
    expect(dueAlert(16, 20, [50, 75])).toEqual({ announce: null });
    // Lowered to 15, spend 16 is 106%.
    expect(dueAlert(16, 15, [50, 75])).toEqual({ announce: 100 });
  });

  it("starts months at midnight UTC", () => {
    expect(monthStart(new Date("2026-12-01T00:30:00+02:00"))).toEqual(new Date("2026-11-01T00:00:00Z"));
    expect(monthStart(NOW)).toEqual(new Date("2026-11-01T00:00:00Z"));
  });
});

let cookie: string;
let workspaceId: string;
let userId: string;
let repositoryId: string;

beforeEach(async () => {
  await prisma.workspace.deleteMany();
  await prisma.user.deleteMany();
  const created = await createUser("owner@example.com");
  ({ cookie } = created);
  workspaceId = created.workspace.id;
  userId = created.user.id;
  const connection = await prisma.forgeConnection.create({
    data: { workspaceId, provider: "github", host: "github.com", kind: "github_app", installationId: "1", accountLogin: "acme" },
  });
  repositoryId = (
    await prisma.repository.create({
      data: { connectionId: connection.id, provider: "github", host: "github.com", fullPath: "acme/web", externalId: "1", defaultBranch: "main" },
    })
  ).id;
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(mailer, "configured").mockReturnValue(false);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await prisma.$disconnect();
});

let number = 0;
async function review(usd: number, { createdAt = NOW, model = PRICED, unpricedCalls = 0, status = "completed" as const } = {}) {
  number++;
  return prisma.reviewJob.create({
    data: {
      repositoryId,
      number,
      headSha: `h${number}`,
      trigger: "manual",
      status,
      createdAt,
      summary: {
        usageByModel: { [model]: { calls: 1 + unpricedCalls, unpricedCalls, inputTokens: 100, outputTokens: 10, cost: { total: usd } } },
      },
    },
  });
}

async function target(events: NotificationEvent[], extra: { kind?: NotificationKind; active?: boolean; membershipId?: string; recipientIds?: string[]; repositoryIds?: string[]; deliveryMode?: "each" | "daily"; digestDueAt?: Date } = {}) {
  const kind = extra.kind ?? "webhook";
  return prisma.notificationTarget.create({
    data: {
      workspaceId,
      kind,
      name: `${kind} ${events.join(",")}`,
      events,
      encryptedUrl: kind === "email" ? null : encrypt("https://hooks.example.com/budget"),
      encryptedSecret: kind === "webhook" ? encrypt("secret") : null,
      active: extra.active ?? true,
      membershipId: extra.membershipId ?? null,
      recipientIds: extra.recipientIds ?? [],
      repositoryIds: extra.repositoryIds ?? [],
      deliveryMode: extra.deliveryMode ?? "each",
      digestDueAt: extra.digestDueAt ?? null,
    },
  });
}

const setBudget = (monthlyBudgetUsd: number | null) =>
  prisma.workspace.update({ where: { id: workspaceId }, data: { monthlyBudgetUsd } });

const deliveries = () =>
  prisma.notificationDelivery.findMany({ where: { event: "budget" }, orderBy: { createdAt: "asc" } });

// Ages every admin email lock past DELIVERY_LOCK_TIMEOUT_MS, so a failed send
// is due for its retry.
const staleLocks = () =>
  prisma.budgetAlert.updateMany({
    where: { adminEmailLockedAt: { not: null } },
    data: { adminEmailLockedAt: new Date(Date.now() - 6 * 60_000) },
  });

describe("runBudgetAlerts", () => {
  it("queues one alert per crossed threshold to every listening target, once a month", async () => {
    const listening = await target(["budget"]);
    await target(["blocked"]);
    await setBudget(10);
    await review(4);
    expect(await runBudgetAlerts(NOW)).toBe(0);

    await review(2);
    expect(await runBudgetAlerts(NOW)).toBe(1);
    expect(await runBudgetAlerts(NOW)).toBe(0);
    const rows = await deliveries();
    expect(rows).toMatchObject([{ targetId: listening.id, jobId: null, status: "pending" }]);
    expect(rows[0]!.payload).toMatchObject({
      event: "budget",
      threshold: 50,
      overBudget: false,
      spendUsd: 6,
      budgetUsd: 10,
      percent: 60,
      month: "2026-11",
    });
  });

  it("announces only the highest of several thresholds crossed together", async () => {
    await target(["budget"]);
    await setBudget(10);
    await review(12);
    expect(await runBudgetAlerts(NOW)).toBe(1);
    const rows = await deliveries();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toMatchObject({ threshold: 110, overBudget: true });
    // Only the alert that went out is recorded.
    const recorded = await prisma.budgetAlert.findMany({ orderBy: { threshold: "asc" } });
    expect(recorded.map((row) => row.threshold)).toEqual([110]);
  });

  it("is not held up by an open insert that references the workspace", async () => {
    await target(["budget"]);
    await setBudget(10);
    await review(5);
    // Every insert with a foreign key to the workspace (a running review's
    // request log, say) holds a KEY SHARE lock on its row until it commits.
    const announced = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM workspaces WHERE id = ${workspaceId}::uuid FOR KEY SHARE`;
      return runBudgetAlerts(NOW);
    });
    expect(announced).toBe(1);
  });

  it("checks workspaces a page at a time, resuming after the cursor", async () => {
    await setBudget(10);
    await review(6);
    for (const email of ["two@example.com", "three@example.com"]) {
      const other = await createUser(email);
      const connection = await prisma.forgeConnection.create({
        data: { workspaceId: other.workspace.id, provider: "github", host: "github.com", kind: "github_app", installationId: email, accountLogin: email },
      });
      const repo = await prisma.repository.create({
        data: { connectionId: connection.id, provider: "github", host: "github.com", fullPath: `${email}/web`, externalId: email, defaultBranch: "main" },
      });
      await prisma.workspace.update({ where: { id: other.workspace.id }, data: { monthlyBudgetUsd: 10 } });
      number++;
      await prisma.reviewJob.create({
        data: {
          repositoryId: repo.id,
          number,
          headSha: `h${number}`,
          trigger: "manual",
          status: "completed",
          createdAt: NOW,
          summary: { usageByModel: { [PRICED]: { calls: 1, unpricedCalls: 0, inputTokens: 100, outputTokens: 10, cost: { total: 6 } } } },
        },
      });
    }
    const first = await runBudgetAlertPage(NOW, null, 2);
    expect(first.announced).toBe(2);
    expect(first.next).not.toBeNull();
    const second = await runBudgetAlertPage(NOW, first.next, 2);
    expect(second).toEqual({ announced: 1, next: null });
    const alerted = await prisma.budgetAlert.findMany({ select: { workspaceId: true } });
    expect(new Set(alerted.map((row) => row.workspaceId)).size).toBe(3);
    expect(alerted).toHaveLength(3);
  });

  it("counts only this UTC month's reviews, like the Usage page", async () => {
    await target(["budget"]);
    await setBudget(10);
    await review(9, { createdAt: new Date("2026-10-31T23:59:00Z") });
    await review(4, { status: "superseded" as never });
    expect(await runBudgetAlerts(NOW)).toBe(0);
  });

  it("sums spend and unpriced calls across models, at no cost for digests from before per-model usage", async () => {
    await review(1.5, { unpricedCalls: 2 });
    await review(0.25, { model: "openai/gpt-5" });
    number++;
    await prisma.reviewJob.create({
      data: {
        repositoryId,
        number,
        headSha: `h${number}`,
        trigger: "manual",
        status: "completed",
        createdAt: NOW,
        summary: { usageTotals: { calls: 3, inputTokens: 500, outputTokens: 50 } },
      },
    });
    number++;
    await prisma.reviewJob.create({
      data: { repositoryId, number, headSha: `h${number}`, trigger: "manual", status: "queued", createdAt: NOW },
    });
    expect(await monthSpend(workspaceId, NOW)).toEqual({ usd: 1.75, unpricedCalls: 2 });
  });

  it("starts again in a new month", async () => {
    await target(["budget"]);
    await setBudget(10);
    await review(6);
    expect(await runBudgetAlerts(NOW)).toBe(1);
    await review(6, { createdAt: new Date("2026-12-02T00:00:00Z") });
    expect(await runBudgetAlerts(new Date("2026-12-02T01:00:00Z"))).toBe(1);
    expect((await deliveries()).map((row) => (row.payload as { month: string }).month)).toEqual(["2026-11", "2026-12"]);
  });

  it("sends to digest targets at once and skips paused and personal targets", async () => {
    const digest = await target(["budget"], { deliveryMode: "daily", digestDueAt: new Date("2026-11-19T08:00:00Z") });
    await target(["budget"], { active: false });
    const membership = await prisma.membership.findFirstOrThrow({ where: { workspaceId } });
    await target(["budget"], { kind: "email", membershipId: membership.id });
    await setBudget(10);
    await review(5);
    await runBudgetAlerts(NOW);
    expect(await deliveries()).toMatchObject([{ targetId: digest.id, status: "pending" }]);
  });

  it("still records the alert with no listening target, and mails owners and admins", async () => {
    vi.spyOn(mailer, "configured").mockReturnValue(true);
    const send = vi.spyOn(mailer, "send").mockResolvedValue();
    const admin = (await createUser("admin@example.com")).user;
    await addMember(workspaceId, admin.id, "admin");
    const member = (await createUser("member@example.com")).user;
    await addMember(workspaceId, member.id, "member");
    await setBudget(10);
    await review(5);
    expect(await runBudgetAlerts(NOW)).toBe(1);
    expect(await deliveries()).toEqual([]);
    expect(send.mock.calls.map(([mail]) => mail.to).sort()).toEqual(["admin@example.com", "owner@example.com"]);
    expect(send.mock.calls[0]![0].subject).toBe("50% of this month's budget spent in Dev");
  });

  it("still mails an admin an email target also reaches, since that target can fail or be paused", async () => {
    vi.spyOn(mailer, "configured").mockReturnValue(true);
    const send = vi.spyOn(mailer, "send").mockResolvedValue();
    await target(["budget"], { kind: "email", recipientIds: [userId] });
    await setBudget(10);
    await review(5);
    await runBudgetAlerts(NOW);
    expect(send.mock.calls.map(([mail]) => mail.to)).toEqual(["owner@example.com"]);
    expect(await deliveries()).toHaveLength(1);
  });

  it("keeps a budget-only target running when its repositories are deleted, and pauses a review target", async () => {
    vi.stubGlobal("fetch", fetchStub([]).fetch);
    const budgetOnly = await target(["budget"], { repositoryIds: [repositoryId] });
    const reviews = await target(["blocked", "budget"], { repositoryIds: [repositoryId] });
    const res = await request(app).delete(`/api/repos/${repositoryId}`).set("Cookie", cookie);
    expect(res.status).toBe(204);
    expect(await prisma.notificationTarget.findUniqueOrThrow({ where: { id: budgetOnly.id } })).toMatchObject({
      repositoryIds: [],
      active: true,
      pausedReason: null,
    });
    expect(await prisma.notificationTarget.findUniqueOrThrow({ where: { id: reviews.id } })).toMatchObject({ active: false });
  });

  describe("admin email outbox", () => {
    const owed = async () =>
      (await prisma.budgetAlert.findMany({ where: { workspaceId }, orderBy: { threshold: "asc" } })).map((row) => ({
        threshold: row.threshold,
        adminUserIds: row.adminUserIds,
        attempts: row.adminEmailAttempts,
        locked: row.adminEmailLockedAt !== null,
      }));

    let adminId: string;
    beforeEach(async () => {
      vi.spyOn(mailer, "configured").mockReturnValue(true);
      adminId = (await createUser("admin@example.com")).user.id;
      await addMember(workspaceId, adminId, "admin");
      await setBudget(10);
    });

    it("queues the email with the announced threshold, and clears it once sent", async () => {
      const send = vi.fn().mockResolvedValue(undefined);
      await review(8);
      await runBudgetAlerts(NOW, { send });
      expect(send).toHaveBeenCalledTimes(2);
      expect(await owed()).toEqual([{ threshold: 75, adminUserIds: [], attempts: 1, locked: false }]);
      const row = await prisma.budgetAlert.findFirstOrThrow({ where: { threshold: 75 } });
      expect(row.adminEmailPayload).toBeNull();
    });

    it("retries only the admins whose email failed, once the lock goes stale", async () => {
      const send = vi.fn(async ({ to }: { to: string }) => {
        if (to === "admin@example.com") throw new Error("SMTP 451");
      });
      await review(5);
      await runBudgetAlerts(NOW, { send });
      expect(await owed()).toEqual([{ threshold: 50, adminUserIds: [adminId], attempts: 1, locked: true }]);

      // However often the worker polls, the retry waits out the lock.
      const retry = vi.fn().mockResolvedValue(undefined);
      await runBudgetAlerts(NOW, { send: retry });
      expect(retry).not.toHaveBeenCalled();

      await staleLocks();
      expect(await runBudgetAlerts(NOW, { send: retry })).toBe(0);
      expect(retry.mock.calls.map(([mail]) => mail.to)).toEqual(["admin@example.com"]);
      expect(retry.mock.calls[0]![0].subject).toBe("50% of this month's budget spent in Dev");
      expect(await owed()).toEqual([{ threshold: 50, adminUserIds: [], attempts: 2, locked: false }]);
    });

    it("keeps the email when the worker dies after the threshold is committed", async () => {
      await review(5);
      // A claim that never finishes stands in for a worker dying mid-send.
      vi.spyOn(prisma.membership, "findMany").mockRejectedValueOnce(new Error("connection lost"));
      const send = vi.fn().mockResolvedValue(undefined);
      // The check reads memberships in its transaction client, not this spy;
      // the send's read is the one that fails.
      await runBudgetAlerts(NOW, { send });
      expect(send).not.toHaveBeenCalled();
      expect(await owed()).toMatchObject([{ adminUserIds: expect.arrayContaining([adminId, userId]), locked: true }]);

      // A fresh lock is left alone.
      await runBudgetAlerts(NOW, { send });
      expect(send).not.toHaveBeenCalled();

      await prisma.budgetAlert.updateMany({ data: { adminEmailLockedAt: new Date(Date.now() - 6 * 60_000) } });
      await runBudgetAlerts(NOW, { send });
      expect(send.mock.calls.map(([mail]) => mail.to).sort()).toEqual(["admin@example.com", "owner@example.com"]);
      expect(await owed()).toEqual([{ threshold: 50, adminUserIds: [], attempts: 2, locked: false }]);
    });

    it("gives up after the attempt limit", async () => {
      const send = vi.fn().mockRejectedValue(new Error("SMTP down"));
      await review(5);
      for (let pass = 0; pass < 7; pass++) {
        await staleLocks();
        await runBudgetAlerts(NOW, { send });
      }
      // Owner and admin, five attempts each.
      expect(send).toHaveBeenCalledTimes(10);
      expect(await owed()).toEqual([{ threshold: 50, adminUserIds: [], attempts: 5, locked: false }]);
    });

    it("does not send last month's email in a new month", async () => {
      await review(5);
      await runBudgetAlerts(NOW, { send: vi.fn().mockRejectedValue(new Error("SMTP down")) });
      const send = vi.fn().mockResolvedValue(undefined);
      await runBudgetAlerts(new Date("2026-12-02T00:00:00Z"), { send });
      expect(send).not.toHaveBeenCalled();
    });

    it("does not mail someone who stopped being an admin before the retry", async () => {
      await review(5);
      await runBudgetAlerts(NOW, { send: vi.fn().mockRejectedValue(new Error("SMTP down")) });
      await prisma.membership.updateMany({ where: { workspaceId, userId: adminId }, data: { role: "member" } });
      await staleLocks();
      const send = vi.fn().mockResolvedValue(undefined);
      await runBudgetAlerts(NOW, { send });
      expect(send.mock.calls.map(([mail]) => mail.to)).toEqual(["owner@example.com"]);
      expect(await owed()).toEqual([{ threshold: 50, adminUserIds: [], attempts: 2, locked: false }]);
    });

    // Alert rows owing the admin email, written as checkWorkspace writes them.
    async function owing(thresholds: number[]) {
      const payload = budgetPayload({ id: workspaceId, name: "Dev" }, monthStart(NOW), 50, { usd: 5, unpricedCalls: 0 }, 10);
      await prisma.budgetAlert.createMany({
        data: thresholds.map((threshold, i) => ({
          workspaceId,
          month: monthStart(NOW),
          threshold,
          spendUsd: 5,
          budgetUsd: 10,
          createdAt: new Date(NOW.getTime() + i),
          adminUserIds: [adminId],
          adminEmailPayload: { ...payload, threshold } as never,
        })),
      });
    }

    it("sends one batch per call, oldest first", async () => {
      await owing([50, 75, 90]);
      const send = vi.fn().mockResolvedValue(undefined);
      expect(await sendAdminEmails(NOW, { send }, 1)).toBe(1);
      expect(send).toHaveBeenCalledTimes(1);
      expect(await owed()).toEqual([
        { threshold: 50, adminUserIds: [], attempts: 1, locked: false },
        { threshold: 75, adminUserIds: [adminId], attempts: 0, locked: false },
        { threshold: 90, adminUserIds: [adminId], attempts: 0, locked: false },
      ]);
    });

    it("moves on to the next row while a failed one waits out its lock", async () => {
      await owing([50, 75]);
      await sendAdminEmails(NOW, { send: vi.fn().mockRejectedValue(new Error("SMTP 451")) }, 1);
      const send = vi.fn().mockResolvedValue(undefined);
      expect(await sendAdminEmails(NOW, { send }, 1)).toBe(1);
      expect(await sendAdminEmails(NOW, { send }, 1)).toBe(0);
      expect(await owed()).toEqual([
        { threshold: 50, adminUserIds: [adminId], attempts: 1, locked: true },
        { threshold: 75, adminUserIds: [], attempts: 1, locked: false },
      ]);
      await staleLocks();
      expect(await sendAdminEmails(NOW, { send }, 1)).toBe(1);
      expect((await owed()).map((row) => row.attempts)).toEqual([2, 1]);
    });

    it("never records a threshold without its email", async () => {
      await review(5);
      // The delivery insert runs last in the check's transaction.
      vi.spyOn(prisma, "$transaction").mockRejectedValueOnce(new Error("deadlock"));
      const send = vi.fn().mockResolvedValue(undefined);
      expect(await runBudgetAlerts(NOW, { send })).toBe(0);
      expect(await owed()).toEqual([]);
      expect(await runBudgetAlerts(NOW, { send })).toBe(1);
      expect(send).toHaveBeenCalledTimes(2);
    });
  });

  it("sends the alert through the outbox to a webhook", async () => {
    await target(["budget"]);
    await setBudget(10);
    // The real clock: claiming compares the due time with the database's now().
    const now = new Date();
    await review(5, { createdAt: now });
    await runBudgetAlerts(now);
    const stub = fetchStub([{ method: "POST", url: /hooks\.example\.com/ }]);
    vi.stubGlobal("fetch", stub.fetch);
    for (const id of await claimDueDeliveries(10)) await runDelivery(id);
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]!.headers["x-sentryward-event"]).toBe("budget");
    expect(JSON.parse(stub.calls[0]!.body!)).toMatchObject({ event: "budget", threshold: 50, spendUsd: 5 });
    expect(await deliveries()).toMatchObject([{ status: "sent" }]);
  });

  it("never queues a budget alert for a finished review", async () => {
    await target(["budget"]);
    const job = await review(50);
    await prisma.reviewJob.update({ where: { id: job.id }, data: { finishedAt: NOW } });
    await notifyJob(job.id);
    expect(await prisma.notificationDelivery.count()).toBe(0);
  });

  it("keeps alert rows through privacy retention and drops them after the retention period", async () => {
    await prisma.workspacePrivacy.create({ data: { workspaceId, retentionDays: 1 } });
    await prisma.budgetAlert.create({
      data: { workspaceId, month: monthStart(NOW), threshold: 50, spendUsd: 5, budgetUsd: 10, createdAt: new Date(NOW.getTime() - 3 * 86_400_000) },
    });
    await prisma.budgetAlert.create({
      data: { workspaceId, month: new Date("2025-09-01T00:00:00Z"), threshold: 50, spendUsd: 5, budgetUsd: 10, createdAt: new Date("2025-09-20T00:00:00Z") },
    });
    const result = await runRetention({ now: NOW });
    expect(result.budgetAlerts).toBe(1);
    expect(await prisma.budgetAlert.count()).toBe(1);
  });
});

describe("rendering budget alerts", () => {
  const payload = (threshold: number, unpricedCalls = 0) =>
    budgetPayload({ id: "w", name: "Acme <@here> *team*" }, monthStart(NOW), threshold, { usd: 7.5, unpricedCalls }, 10);

  async function send(kind: NotificationKind, url: string, threshold = 75, unpricedCalls = 0) {
    const created = await prisma.notificationTarget.create({
      data: { workspaceId, kind, name: kind, events: ["budget"], encryptedUrl: encrypt(url) },
    });
    const stub = fetchStub([{ method: "POST", url: new RegExp(new URL(url).hostname.replaceAll(".", "\\.")) }]);
    vi.stubGlobal("fetch", stub.fetch);
    await deliver(created, workspaceId, payload(threshold, unpricedCalls));
    return JSON.parse(stub.calls[0]!.body!);
  }

  it("keeps the workspace name out of Slack mrkdwn", async () => {
    const body = await send("slack", "https://hooks.slack.com/services/T/B/x", 75, 2);
    expect(body.text).toBe("\u{1F7E0} 75% of this month's budget spent");
    const mrkdwn = JSON.stringify(body.blocks).match(/"type":"mrkdwn","text":"[^"]*"/g) ?? [];
    expect(mrkdwn).toHaveLength(1);
    expect(mrkdwn[0]).not.toContain("Acme");
    expect(JSON.stringify(body.blocks)).toContain("2 model calls had no price");
  });

  it("escapes the workspace name for Discord and pings nobody", async () => {
    const body = await send("discord", "https://discord.com/api/webhooks/1/x", 110);
    expect(body.allowed_mentions).toEqual({ parse: [] });
    expect(body.embeds[0].title).toContain("Over budget: 75%");
    expect(body.embeds[0].description).toContain("\\<@\u200Bhere\\> \\*team\\*");
  });

  it("puts the workspace name only in a Google Chat text widget, escaped", async () => {
    const body = await send("google_chat", "https://chat.googleapis.com/v1/spaces/A/messages?key=k&token=t");
    expect(body.fallbackText).toBe("75% of this month's budget spent");
    expect(JSON.stringify(body.cardsV2)).toContain("Acme &lt;@here&gt; *team*");
  });

  it("puts the workspace name only in a Teams text run", async () => {
    const body = await send("teams", "https://example.webhook.office.com/workflows/x");
    const card = body.attachments[0].content;
    const blocks = card.body.filter((block: { type: string }) => block.type === "TextBlock");
    for (const block of blocks) expect(block.text).not.toContain("Acme");
    expect(card.actions).toEqual([{ type: "Action.OpenUrl", title: "View usage", url: expect.stringMatching(/\/usage$/) }]);
  });
});

describe("/api/settings/budget", () => {
  it("shows the month's spend, alerts and listening targets to any member", async () => {
    await target(["budget"]);
    await setBudget(10);
    await review(6, { createdAt: new Date() });
    await runBudgetAlerts(new Date());
    const res = await request(app).get("/api/settings/budget").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      monthlyBudgetUsd: 10,
      spendUsd: 6,
      percent: 60,
      unpricedCalls: 0,
      unpricedModels: [],
      alertsSent: [{ threshold: 50 }],
      budgetTargets: 1,
      adminEmail: false,
    });
  });

  it("lists only the alerts that went out when a budget is set mid-month", async () => {
    await setBudget(10);
    await review(9.5, { createdAt: new Date() });
    await runBudgetAlerts(new Date());
    const res = await request(app).get("/api/settings/budget").set("Cookie", cookie);
    expect(res.body.alertsSent).toMatchObject([{ threshold: 90 }]);
  });

  it("re-arms the thresholds a raised budget no longer reaches, and keeps the rest", async () => {
    await target(["budget"]);
    await setBudget(10);
    const now = new Date();
    await review(10.5, { createdAt: now });
    expect(await runBudgetAlerts(now)).toBe(1);

    // Saving the same budget again sends nothing twice.
    await request(app).put("/api/settings/budget").set("Cookie", cookie).send({ monthlyBudgetUsd: 10 });
    expect(await runBudgetAlerts(now)).toBe(0);

    // Raised to 20, spend 10.5 is 52%: 100% is due again once reached.
    const raised = await request(app).put("/api/settings/budget").set("Cookie", cookie).send({ monthlyBudgetUsd: 20 });
    expect(raised.body.alertsSent).toEqual([]);
    expect(await runBudgetAlerts(now)).toBe(1);
    await review(10, { createdAt: now });
    expect(await runBudgetAlerts(now)).toBe(1);
    const thresholds = (await deliveries()).map((row) => (row.payload as { threshold: number }).threshold);
    expect(thresholds.sort((a, b) => a - b)).toEqual([50, 100, 100]);
  });

  it("keeps the month's alerts when the budget is cleared", async () => {
    await setBudget(10);
    await review(6, { createdAt: new Date() });
    await runBudgetAlerts(new Date());
    await request(app).put("/api/settings/budget").set("Cookie", cookie).send({ monthlyBudgetUsd: null });
    expect(await prisma.budgetAlert.count()).toBe(1);
  });

  it("sets, changes and clears the budget", async () => {
    const saved = await request(app).put("/api/settings/budget").set("Cookie", cookie).send({ monthlyBudgetUsd: 25 });
    expect(saved.status).toBe(200);
    expect(saved.body.monthlyBudgetUsd).toBe(25);
    const cleared = await request(app).put("/api/settings/budget").set("Cookie", cookie).send({ monthlyBudgetUsd: null });
    expect(cleared.body).toMatchObject({ monthlyBudgetUsd: null, percent: null });
  });

  it("refuses an amount that is not positive", async () => {
    const res = await request(app).put("/api/settings/budget").set("Cookie", cookie).send({ monthlyBudgetUsd: 0 });
    expect(res.status).toBe(400);
    expect(res.body.errors.monthlyBudgetUsd).toBeDefined();
  });

  it("refuses to switch a budget on while a recently used model has no price, but lets an existing one change", async () => {
    await review(0, { createdAt: new Date(), model: "openai/my-proxy", unpricedCalls: 1 });
    const refused = await request(app).put("/api/settings/budget").set("Cookie", cookie).send({ monthlyBudgetUsd: 10 });
    expect(refused.status).toBe(400);
    expect(refused.body.errors.monthlyBudgetUsd[0]).toContain("openai/my-proxy");

    await setBudget(10);
    const changed = await request(app).put("/api/settings/budget").set("Cookie", cookie).send({ monthlyBudgetUsd: 20 });
    expect(changed.status).toBe(200);
    expect(changed.body).toMatchObject({ monthlyBudgetUsd: 20, unpricedCalls: 1, unpricedModels: ["openai/my-proxy"] });
  });

  it("holds a price delete while a budget save has the workspace locked", async () => {
    const price = await prisma.modelPrice.create({ data: { workspaceId, model: "openai/my-proxy", input: 1, output: 2 } });
    let deleted!: Promise<request.Response>;
    await prisma.$transaction(async (tx) => {
      // The lock saveBudget holds while it checks prices and saves.
      await tx.$queryRaw`SELECT id FROM workspaces WHERE id = ${workspaceId}::uuid FOR NO KEY UPDATE`;
      deleted = request(app).delete(`/api/settings/model-prices/${price.id}`).set("Cookie", cookie).then((res) => res);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(await prisma.modelPrice.findUnique({ where: { id: price.id } })).not.toBeNull();
    });
    expect((await deleted).status).toBe(204);
    expect(await prisma.modelPrice.findUnique({ where: { id: price.id } })).toBeNull();
  });

  it("lets only admins change the budget", async () => {
    const member = await createUser("member@example.com");
    await addMember(workspaceId, member.user.id, "member");
    const headers = { "x-sentryward-workspace": workspaceId };
    const read = await request(app).get("/api/settings/budget").set("Cookie", member.cookie).set(headers);
    expect(read.status).toBe(200);
    const write = await request(app)
      .put("/api/settings/budget")
      .set("Cookie", member.cookie)
      .set(headers)
      .send({ monthlyBudgetUsd: 10 });
    expect(write.status).toBe(403);
  });

  it("accepts the budget event on workspace targets but not personal ones", async () => {
    const created = await request(app)
      .post("/api/notifications")
      .set("Cookie", cookie)
      .send({ kind: "webhook", name: "Budget", events: ["budget"], url: "https://hooks.example.com/b" });
    expect(created.status).toBe(201);
    const personal = await request(app)
      .put("/api/notifications/personal")
      .set("Cookie", cookie)
      .send({ enabled: true, events: ["budget"] });
    expect(personal.status).toBe(400);
  });
});
