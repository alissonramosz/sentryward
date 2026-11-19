import { z } from "zod";
import { ruleSchema } from "../review/config/schema.ts";

export const MAX_EXCLUDED_REVIEWERS = 100;

// A page cursor is the last row's `<created_at in epoch microseconds>_<id>`: a
// keyset, so it keeps working after that row is approved or discarded and
// leaves the list. Microseconds, as Postgres keeps them: a millisecond Date
// would skip or repeat rows created within the same millisecond.
const listCursorSchema = z.string().transform((value, ctx) => {
  const match = /^(\d{1,20})_(.+)$/.exec(value);
  if (!match || !z.uuid().safeParse(match[2]).success) {
    ctx.addIssue({ code: "custom", message: "Invalid cursor" });
    return z.NEVER;
  }
  return { atMicros: match[1]!, id: match[2]! };
});

export const listRuleSuggestionsQuerySchema = z.object({
  status: z.enum(["pending", "approved", "discarded"]).default("pending"),
  cursor: listCursorSchema.optional(),
});

export const ruleSuggestionIdParamSchema = z.object({ id: z.uuid() });

export const saveRuleSuggestionSettingsSchema = z.object({
  enabled: z.boolean(),
  minEvidence: z.number().int().min(2, "At least 2").max(50, "At most 50"),
  excludedReviewers: z
    .array(z.string().trim().min(1).max(100))
    .max(MAX_EXCLUDED_REVIEWERS, `At most ${MAX_EXCLUDED_REVIEWERS} reviewers`)
    // Forge logins are case-insensitive; a list that differs only in case is one entry.
    .transform((logins) => [...new Map(logins.map((login) => [login.toLowerCase(), login])).values()]),
});

// The rule as the admin left it (it may be edited), and where it goes:
// the workspace's global settings or one repository's own.
export const approveRuleSuggestionSchema = z.object({
  rule: ruleSchema,
  target: z.union([z.literal("global"), z.object({ repositoryId: z.uuid() })]),
});
