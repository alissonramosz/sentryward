import type { Request, Response } from "express";
import { HttpError } from "../lib/httpError.ts";
import { prisma } from "../lib/prisma.ts";
import type { Prisma } from "../generated/prisma/client.ts";
import {
  backlogIdParamSchema,
  backlogStatsQuerySchema,
  listBacklogQuerySchema,
  updateBacklogItemSchema,
} from "../schemas/backlog.schema.ts";

const listFields = {
  id: true,
  state: true,
  resolution: true,
  origin: true,
  title: true,
  file: true,
  startLine: true,
  endLine: true,
  severity: true,
  category: true,
  kind: true,
  baseBranch: true,
  sourceNumber: true,
  sourceChangeTitle: true,
  author: true,
  ignoreNote: true,
  resolvedNumber: true,
  resolvedJobId: true,
  resolvedAt: true,
  dismissedAt: true,
  dismissNote: true,
  firstSeenAt: true,
  mergedAt: true,
  lastSeenAt: true,
  repository: { select: { id: true, provider: true, host: true, fullPath: true } },
} as const;

// Retention tombstones (scrubbed dismissed items) only keep a dismissal
// holding; they have no text to show and are never listed, opened or reopened.
function ownedBy(workspaceId: string) {
  return { repository: { connection: { workspaceId } }, scrubbedAt: null };
}

type ListQuery = ReturnType<typeof listBacklogQuerySchema.parse>;
type Dir = ListQuery["dir"];

// Severity is stored most severe first, so "desc" (most severe on top) reads
// the enum backwards, as on the findings list.
const SORT_ORDER: Record<ListQuery["sort"], (dir: Dir) => Prisma.BacklogItemOrderByWithRelationInput> = {
  title: (dir) => ({ title: dir }),
  severity: (dir) => ({ severity: dir === "desc" ? "asc" : "desc" }),
  repository: (dir) => ({ repository: { fullPath: dir } }),
  file: (dir) => ({ file: dir }),
  mergedAt: (dir) => ({ mergedAt: dir }),
  firstSeenAt: (dir) => ({ firstSeenAt: dir }),
  lastSeenAt: (dir) => ({ lastSeenAt: dir }),
};

// "#12" (GitHub) and "!12" (GitLab) are how people write change numbers.
const NUMBER_QUERY = /^[#!]?(\d{1,9})$/;

const DAY_MS = 86_400_000;

// Age buckets for the stats strip, by when the finding was first raised.
const AGE_BUCKETS = [
  { key: "week", maxDays: 7 },
  { key: "month", maxDays: 30 },
  { key: "quarter", maxDays: 90 },
  { key: "older", maxDays: null },
] as const;

export async function listBacklog(req: Request, res: Response) {
  const { repoId, state, resolution, origin, severity, category, kind, olderThanDays, q, sort, dir, page, limit } =
    listBacklogQuerySchema.parse(req.query);
  const where: Prisma.BacklogItemWhereInput = {
    ...ownedBy(req.workspaceId!),
    ...(repoId ? { repositoryId: repoId } : {}),
    ...(state ? { state } : {}),
    ...(resolution ? { resolution } : {}),
    ...(origin ? { origin } : {}),
    ...(severity ? { severity } : {}),
    ...(category ? { category } : {}),
    ...(kind ? { kind } : {}),
    ...(olderThanDays ? { firstSeenAt: { lt: new Date(Date.now() - olderThanDays * DAY_MS) } } : {}),
  };
  if (q) {
    const asNumber = NUMBER_QUERY.exec(q);
    where.OR = [
      { title: { contains: q, mode: "insensitive" } },
      { file: { contains: q, mode: "insensitive" } },
      { author: { contains: q, mode: "insensitive" } },
      { repository: { fullPath: { contains: q, mode: "insensitive" } } },
      ...(asNumber ? [{ sourceNumber: Number(asNumber[1]) }, { resolvedNumber: Number(asNumber[1]) }] : []),
    ];
  }
  const [items, total] = await prisma.$transaction([
    prisma.backlogItem.findMany({
      where,
      // The id tiebreak keeps rows from shifting between pages when values collide.
      orderBy: [SORT_ORDER[sort](dir), { id: "desc" }],
      skip: (page - 1) * limit,
      take: limit,
      select: listFields,
    }),
    prisma.backlogItem.count({ where }),
  ]);
  res.json({ items, total, page, limit });
}

// Open items by severity and by age, for the strip above the list.
export async function getBacklogStats(req: Request, res: Response) {
  const { repoId } = backlogStatsQuerySchema.parse(req.query);
  const scope = { ...ownedBy(req.workspaceId!), ...(repoId ? { repositoryId: repoId } : {}), state: "open" as const };
  const now = Date.now();
  const bySeverity = await prisma.backlogItem.groupBy({
    by: ["severity"],
    where: scope,
    orderBy: { severity: "asc" },
    _count: { _all: true },
  });
  const byAge = await Promise.all(
    AGE_BUCKETS.map(async (bucket, index) => {
      const newer = index === 0 ? null : AGE_BUCKETS[index - 1]!.maxDays;
      const firstSeenAt: Prisma.DateTimeFilter = {
        ...(bucket.maxDays !== null ? { gte: new Date(now - bucket.maxDays * DAY_MS) } : {}),
        ...(newer !== null ? { lt: new Date(now - newer * DAY_MS) } : {}),
      };
      return { key: bucket.key, count: await prisma.backlogItem.count({ where: { ...scope, firstSeenAt } }) };
    }),
  );
  res.json({
    open: bySeverity.reduce((sum, row) => sum + row._count._all, 0),
    bySeverity: bySeverity.map((row) => ({ severity: row.severity, count: row._count._all })),
    byAge,
  });
}

export async function getBacklogItem(req: Request, res: Response) {
  const { id } = backlogIdParamSchema.parse(req.params);
  const item = await prisma.backlogItem.findFirst({ where: { id, ...ownedBy(req.workspaceId!) }, select: listFields });
  if (!item) {
    throw new HttpError(404, "Backlog item not found");
  }
  // The review that last spoke for the source change, if retention kept it.
  const sourceReview = await prisma.reviewJob.findFirst({
    where: { repositoryId: item.repository.id, number: item.sourceNumber, status: { in: ["completed", "partial"] } },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  res.json({ item, sourceReviewId: sourceReview?.id ?? null });
}

export async function updateBacklogItem(req: Request, res: Response) {
  const { id } = backlogIdParamSchema.parse(req.params);
  const input = updateBacklogItemSchema.parse(req.body);
  const existing = await prisma.backlogItem.findFirst({ where: { id, ...ownedBy(req.workspaceId!) }, select: { id: true } });
  if (!existing) {
    throw new HttpError(404, "Backlog item not found");
  }
  // Reopening a resolved item says the merge step got it wrong, so its
  // resolution goes too; the next merge that rewrites its lines can resolve it again.
  const data: Prisma.BacklogItemUpdateInput =
    input.state === "dismissed"
      ? { state: "dismissed", dismissedAt: new Date(), dismissNote: input.note || null }
      : {
          state: "open",
          dismissedAt: null,
          dismissNote: null,
          resolution: null,
          resolvedNumber: null,
          resolvedJob: { disconnect: true },
          resolvedAt: null,
        };
  const item = await prisma.backlogItem.update({ where: { id }, data, select: listFields });
  res.json({ item });
}
