import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../src/app.ts";
import { prisma } from "../src/lib/prisma.ts";
import type { Prisma } from "../src/generated/prisma/client.ts";
import type { ReviewResult } from "../src/review/core/models.ts";
import type { ChangeDetails } from "../src/review/forge/types.ts";
import { backlogTransitions, patchTouches, recordChangeState, type BacklogCandidate } from "../src/services/backlog.ts";
import { sweepClosedChanges } from "../src/worker/backlogSweep.ts";
import { pruneBacklog } from "../src/worker/retention.ts";
import { sampleResult } from "./helpers/result.ts";
import { createUser } from "./helpers/users.ts";

let cookie: string;
let workspaceId: string;
let repoId: string;
let base: ReviewResult;

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

async function createRepo(owner: string, fullPath = "team/web") {
  const connection = await prisma.forgeConnection.create({
    data: { workspaceId: owner, provider: "gitlab", host: "gitlab.com", kind: "token", accountLogin: "dev" },
  });
  const repo = await prisma.repository.create({
    data: {
      connectionId: connection.id,
      provider: "gitlab",
      host: "gitlab.com",
      fullPath,
      externalId: fullPath,
      defaultBranch: "main",
      enabled: true,
    },
  });
  return repo.id;
}

// Old lines 20-22 of src/app.ts: 21 is rewritten.
const REWRITE_21 = ["@@ -20,3 +20,3 @@", " keep();", "-broken();", "+fixed();", " keep();"].join("\n");

// One stored result, with only what the backlog reads set.
function result(overrides: Partial<ReviewResult> = {}, files: ReviewResult["files"] = []): ReviewResult {
  return {
    ...base,
    status: "completed",
    findings: [],
    files,
    coverage: { ...base.coverage, reviewedFiles: files.map((file) => file.path) },
    change: { ...base.change, baseRef: "main" },
    ...overrides,
  };
}

const modified = (path: string, patch?: string): ReviewResult["files"][number] => ({
  path,
  changeType: "modified",
  additions: 1,
  deletions: 1,
  ...(patch ? { patch } : { patchOmitted: "too_large" as const }),
});

const candidate = (overrides: Partial<BacklogCandidate> = {}): BacklogCandidate => ({
  fingerprint: "fp1",
  file: "src/app.ts",
  startLine: 21,
  endLine: 21,
  baseBranch: "main",
  ...overrides,
});

async function finding(number: number, fingerprint: string, data: Partial<Prisma.FindingUncheckedCreateInput> = {}) {
  return prisma.finding.create({
    data: {
      repositoryId: repoId,
      number,
      fingerprint,
      title: `Finding ${fingerprint}`,
      file: "src/app.ts",
      startLine: 21,
      endLine: 21,
      severity: "major",
      category: "bug",
      kind: "issue",
      changeTitle: `Change ${number}`,
      author: "alice",
      ...data,
    },
  });
}

async function job(number: number, stored: ReviewResult, createdAt = new Date()) {
  return prisma.reviewJob.create({
    data: { repositoryId: repoId, number, headSha: "head", trigger: "manual", status: "completed", result: stored, createdAt },
  });
}

const merge = (number: number) => recordChangeState({ repositoryId: repoId, number, state: "merged", baseBranch: "main" });
const items = () => prisma.backlogItem.findMany({ orderBy: { fingerprint: "asc" } });

beforeEach(async () => {
  await prisma.workspace.deleteMany();
  await prisma.user.deleteMany();
  const created = await createUser();
  cookie = created.cookie;
  workspaceId = created.workspace.id;
  repoId = await createRepo(workspaceId);
  base ??= await sampleResult();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("patchTouches", () => {
  it("counts removed and rewritten lines, not context passing by", () => {
    expect(patchTouches(REWRITE_21, 21, 21)).toBe(true);
    expect(patchTouches(REWRITE_21, 20, 20)).toBe(false);
    expect(patchTouches(REWRITE_21, 22, 30)).toBe(false);
  });

  it("counts an insertion inside the range but not at its edges", () => {
    const insert = ["@@ -10,2 +10,3 @@", " a();", "+b();", " c();"].join("\n");
    // Lands between old lines 10 and 11.
    expect(patchTouches(insert, 10, 11)).toBe(true);
    expect(patchTouches(insert, 10, 10)).toBe(false);
    expect(patchTouches(insert, 11, 11)).toBe(false);
  });
});

describe("backlogTransitions", () => {
  it("fixes an item whose lines a reviewed change rewrote without reporting it", () => {
    expect(backlogTransitions([candidate()], result({}, [modified("src/app.ts", REWRITE_21)]))).toEqual({
      fixed: ["fp1"],
      invalidated: [],
      seenAgain: [],
    });
  });

  it("leaves an item reported again open, and says so", () => {
    const stored = result({ findings: [{ ...base.findings[0]!, fingerprint: "fp1" }] }, [modified("src/app.ts", REWRITE_21)]);
    expect(backlogTransitions([candidate()], stored)).toEqual({ fixed: [], invalidated: [], seenAgain: ["fp1"] });
  });

  it("invalidates an item whose file was deleted or renamed away", () => {
    const deleted = result({}, [{ path: "src/app.ts", changeType: "deleted", additions: 0, deletions: 30 }]);
    const renamed = result({}, [{ path: "src/main.ts", previousPath: "src/app.ts", changeType: "renamed", additions: 0, deletions: 0 }]);
    expect(backlogTransitions([candidate()], deleted).invalidated).toEqual(["fp1"]);
    expect(backlogTransitions([candidate()], renamed).invalidated).toEqual(["fp1"]);
  });

  it("resolves nothing it cannot see: other lines, unread files, no patch, another branch, a failed run", () => {
    const none = { fixed: [], invalidated: [], seenAgain: [] };
    const touched = result({}, [modified("src/app.ts", REWRITE_21)]);
    expect(backlogTransitions([candidate({ startLine: 5, endLine: 8 })], touched)).toEqual(none);
    expect(backlogTransitions([candidate()], { ...touched, coverage: { ...touched.coverage, reviewedFiles: [] } })).toEqual(none);
    expect(backlogTransitions([candidate()], result({}, [modified("src/app.ts")]))).toEqual(none);
    expect(backlogTransitions([candidate({ baseBranch: "release" })], touched)).toEqual(none);
    expect(backlogTransitions([candidate()], { ...touched, status: "failed" })).toEqual(none);
  });
});

describe("recordChangeState", () => {
  it("promotes open and fix-later findings when a change merges, and nothing else", async () => {
    await finding(7, "fp-open");
    await finding(7, "fp-later", { state: "ignored", ignoreReason: "fix_later", ignoreNote: "after launch" });
    await finding(7, "fp-false", { state: "ignored", ignoreReason: "false_positive" });
    await finding(7, "fp-fixed", { state: "resolved", lifecycle: "fixed" });

    expect(await merge(7)).toEqual({ promoted: 2, fixed: 0, invalidated: 0 });
    const stored = await items();
    expect(stored.map((item) => [item.fingerprint, item.origin, item.ignoreNote, item.state])).toEqual([
      ["fp-later", "fix_later", "after launch", "open"],
      ["fp-open", "open", null, "open"],
    ]);
    expect(stored[0]).toMatchObject({ sourceNumber: 7, sourceChangeTitle: "Change 7", baseBranch: "main", author: "alice" });
    expect(await prisma.changeState.findFirst({ select: { state: true } })).toEqual({ state: "merged" });
  });

  it("is a no-op on a second merge record and on a close without a merge", async () => {
    await finding(7, "fp-open");
    await finding(8, "fp-closed");
    await merge(7);
    expect(await merge(7)).toBeNull();
    expect(await recordChangeState({ repositoryId: repoId, number: 8, state: "closed" })).toBeNull();
    expect((await items()).map((item) => item.fingerprint)).toEqual(["fp-open"]);
  });

  it("resolves earlier items from the merged change's review, but never its own", async () => {
    await finding(7, "fp-old");
    await merge(7);
    // Change 8 rewrites line 21 and raises its own finding on the same line.
    await finding(8, "fp-new");
    const reviewed = await job(8, result({}, [modified("src/app.ts", REWRITE_21)]));

    expect(await merge(8)).toEqual({ promoted: 1, fixed: 1, invalidated: 0 });
    const [fresh, old] = await items();
    expect(old).toMatchObject({ fingerprint: "fp-old", state: "resolved", resolution: "fixed", resolvedNumber: 8, resolvedJobId: reviewed.id });
    expect(fresh).toMatchObject({ fingerprint: "fp-new", state: "open" });
  });

  it("reopens a resolved item that ships again, and leaves a dismissed one dismissed", async () => {
    await finding(7, "fp-back");
    await finding(7, "fp-dismissed");
    await merge(7);
    await prisma.backlogItem.updateMany({ where: { fingerprint: "fp-back" }, data: { state: "resolved", resolution: "fixed" } });
    await prisma.backlogItem.updateMany({ where: { fingerprint: "fp-dismissed" }, data: { state: "dismissed", dismissedAt: new Date() } });

    await finding(9, "fp-back");
    await finding(9, "fp-dismissed");
    expect((await merge(9))!.promoted).toBe(1);
    const [back, dismissed] = await items();
    expect(back).toMatchObject({ state: "open", resolution: null, sourceNumber: 9 });
    expect(dismissed).toMatchObject({ state: "dismissed", sourceNumber: 7 });
  });
});

describe("sweepClosedChanges", () => {
  const now = new Date("2026-11-18T12:00:00Z");
  const details = (state: ChangeDetails["state"]): ChangeDetails => ({
    state,
    isDraft: false,
    sourceBranch: "feature",
    targetBranch: "main",
    createdAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-18T00:00:00Z",
    ...(state === "merged" ? { mergedAt: "2026-11-18T09:00:00Z" } : {}),
  });

  it("asks the forge about quiet changes only, and promotes the merged ones", async () => {
    const quiet = new Date(now.getTime() - 2 * HOUR_MS);
    await finding(7, "fp-merged", { lastSeenAt: quiet });
    await finding(8, "fp-open", { lastSeenAt: quiet });
    // Reviewed a moment ago: the webhook and close watch still speak for it.
    await finding(9, "fp-busy", { lastSeenAt: quiet });
    await job(9, result(), new Date(now.getTime() - 10 * 60_000));

    const asked: number[] = [];
    const forgeFor = () => ({
      getChangeDetails: async (_project: string, number: number) => {
        asked.push(number);
        return details(number === 7 ? "merged" : "open");
      },
    });
    expect(await sweepClosedChanges({ now, forgeFor })).toEqual({ checked: 2, merged: 1, failed: 0 });
    expect(asked.sort()).toEqual([7, 8]);
    expect((await items()).map((item) => [item.fingerprint, item.mergedAt.toISOString()])).toEqual([
      ["fp-merged", "2026-11-18T09:00:00.000Z"],
    ]);

    // An hour on: 7 and 8 were just checked, and only 9 has gone quiet since.
    asked.length = 0;
    expect(await sweepClosedChanges({ now: new Date(now.getTime() + HOUR_MS), forgeFor })).toEqual({ checked: 1, merged: 0, failed: 0 });
    expect(asked).toEqual([9]);
  });

  it("counts a failed check and waits before asking again", async () => {
    await finding(7, "fp", { lastSeenAt: new Date(now.getTime() - 2 * HOUR_MS) });
    const forgeFor = () => ({
      getChangeDetails: async (): Promise<ChangeDetails> => {
        throw new Error("forge down");
      },
    });
    expect(await sweepClosedChanges({ now, forgeFor })).toEqual({ checked: 0, merged: 0, failed: 1 });
    expect(await sweepClosedChanges({ now: new Date(now.getTime() + HOUR_MS), forgeFor })).toEqual({ checked: 0, merged: 0, failed: 0 });
  });
});

describe("pruneBacklog", () => {
  it("deletes items resolved or dismissed before the window and keeps open ones", async () => {
    await finding(7, "fp-open");
    await finding(7, "fp-resolved");
    await finding(7, "fp-recent");
    await finding(7, "fp-dismissed");
    await merge(7);
    const old = new Date(Date.now() - 40 * DAY_MS);
    await prisma.backlogItem.updateMany({ where: { fingerprint: "fp-resolved" }, data: { state: "resolved", resolvedAt: old } });
    await prisma.backlogItem.updateMany({ where: { fingerprint: "fp-recent" }, data: { state: "resolved", resolvedAt: new Date() } });
    await prisma.backlogItem.updateMany({ where: { fingerprint: "fp-dismissed" }, data: { state: "dismissed", dismissedAt: old } });
    await prisma.backlogItem.updateMany({ where: { fingerprint: "fp-open" }, data: { mergedAt: old, firstSeenAt: old } });

    expect(await pruneBacklog(30)).toBe(2);
    expect((await items()).map((item) => item.fingerprint)).toEqual(["fp-open", "fp-recent"]);
  });
});

describe("/api/backlog", () => {
  async function seed() {
    await finding(7, "fp-a", { severity: "critical", title: "SQL injection" });
    await finding(7, "fp-b", { severity: "minor", title: "Unused import", file: "src/util.ts" });
    await merge(7);
  }

  it("lists the workspace's items with filters and search", async () => {
    await seed();
    const all = await request(app).get("/api/backlog").set("Cookie", cookie);
    expect(all.status).toBe(200);
    expect(all.body.total).toBe(2);
    expect(all.body.items[0].repository.fullPath).toBe("team/web");

    const critical = await request(app).get("/api/backlog?severity=critical").set("Cookie", cookie);
    expect(critical.body.items.map((item: { title: string }) => item.title)).toEqual(["SQL injection"]);
    const byNumber = await request(app).get("/api/backlog?q=!7").set("Cookie", cookie);
    expect(byNumber.body.total).toBe(2);
    const byFile = await request(app).get("/api/backlog?q=util").set("Cookie", cookie);
    expect(byFile.body.total).toBe(1);
    expect((await request(app).get("/api/backlog?state=resolved").set("Cookie", cookie)).body.total).toBe(0);
  });

  it("counts open items by severity and age", async () => {
    await seed();
    const res = await request(app).get("/api/backlog/stats").set("Cookie", cookie);
    expect(res.body.open).toBe(2);
    expect(res.body.bySeverity).toEqual([
      { severity: "critical", count: 1 },
      { severity: "minor", count: 1 },
    ]);
    expect(res.body.byAge).toEqual([
      { key: "week", count: 2 },
      { key: "month", count: 0 },
      { key: "quarter", count: 0 },
      { key: "older", count: 0 },
    ]);
  });

  it("dismisses with a note and reopens", async () => {
    await seed();
    const [item] = await items();
    const dismissed = await request(app)
      .patch(`/api/backlog/${item!.id}`)
      .set("Cookie", cookie)
      .send({ state: "dismissed", note: "won't fix" });
    expect(dismissed.body.item).toMatchObject({ state: "dismissed", dismissNote: "won't fix" });

    const reopened = await request(app).patch(`/api/backlog/${item!.id}`).set("Cookie", cookie).send({ state: "open" });
    expect(reopened.body.item).toMatchObject({ state: "open", dismissNote: null, dismissedAt: null });
    expect((await request(app).patch(`/api/backlog/${item!.id}`).set("Cookie", cookie).send({ state: "resolved" })).status).toBe(400);
  });

  it("returns the item with its source review, and hides other workspaces' items", async () => {
    await finding(7, "fp-a");
    const review = await job(7, result());
    await merge(7);
    const [item] = await items();

    const res = await request(app).get(`/api/backlog/${item!.id}`).set("Cookie", cookie);
    expect(res.body).toMatchObject({ item: { id: item!.id }, sourceReviewId: review.id });

    const other = await createUser("other@example.com");
    expect((await request(app).get(`/api/backlog/${item!.id}`).set("Cookie", other.cookie)).status).toBe(404);
    expect((await request(app).patch(`/api/backlog/${item!.id}`).set("Cookie", other.cookie).send({ state: "open" })).status).toBe(404);
    expect((await request(app).get("/api/backlog").set("Cookie", other.cookie)).body.total).toBe(0);
  });
});
