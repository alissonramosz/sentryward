import { z } from "zod";
import { pageSchema } from "./pagination.ts";
import { CATEGORIES, KINDS, SEVERITIES } from "../review/core/severity.ts";

export const backlogStateSchema = z.enum(["open", "resolved", "dismissed"]);

export const listBacklogQuerySchema = z.object({
  repoId: z.uuid().optional(),
  state: backlogStateSchema.optional(),
  resolution: z.enum(["fixed", "invalidated"]).optional(),
  origin: z.enum(["open", "fix_later"]).optional(),
  severity: z.enum(SEVERITIES).optional(),
  category: z.enum(CATEGORIES).optional(),
  kind: z.enum(KINDS).optional(),
  // Items first raised more than this many days ago.
  olderThanDays: z.coerce.number().int().min(1).max(3650).optional(),
  q: z.string().trim().max(200).optional(),
  sort: z
    .enum(["title", "severity", "repository", "file", "mergedAt", "firstSeenAt", "lastSeenAt"])
    .default("mergedAt"),
  dir: z.enum(["asc", "desc"]).default("desc"),
  page: pageSchema,
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const backlogStatsQuerySchema = z.object({
  repoId: z.uuid().optional(),
});

export const backlogIdParamSchema = z.object({ id: z.uuid() });

// "resolved" belongs to the merge step: only merged work shows an item fixed.
export const updateBacklogItemSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("open") }),
  z.object({
    state: z.literal("dismissed"),
    note: z.string().trim().max(1000, "Keep the note under 1000 characters").optional(),
  }),
]);
