import { Prisma } from "../generated/prisma/client.ts";
import { prisma } from "../lib/prisma.ts";
import { ForgeError } from "../review/forge/http.ts";
import { REVIEW_COMMAND } from "../lib/webhook.ts";
import { markersIn, REPLY_MARKER } from "../review/core/markers.ts";
import type { ThreadRoot } from "../review/forge/types.ts";
import type { RepoWithConnection } from "./providers/types.ts";
import { isUniqueViolation } from "./users.ts";

// Human review comments, kept as evidence for rule suggestions
// (worker/ruleSuggestions.ts). Only the start of a long comment is kept; the
// model sees a shorter excerpt still.
export const MAX_COMMENT_BODY = 4000;
// A one-word "nit" or "+1" teaches nothing a rule could hold.
const MIN_COMMENT_CHARS = 15;

export interface ReviewCommentInput {
  repo: RepoWithConnection;
  number: number;
  commentId: string;
  // The thread the comment is in, when it is a reply (GitHub: root comment id;
  // GitLab: discussion id). A reply in one of Sentryward's threads is the reply
  // queue's (threadReplies.ts), not evidence: it is about a finding, not the code.
  threadId?: string;
  // Reads the thread's first comment from the forge (shared with the reply
  // queue, so one delivery costs one call). Only asked when the thread is not
  // known locally and the change holds findings.
  threadRoot?: () => Promise<ThreadRoot | null>;
  author: string | undefined;
  body: string;
  file: string | undefined;
  line: number | null | undefined;
  // Whether the author is Sentryward itself. Only decidable from the login on
  // a connection that posts as an account of its own; markers cover the rest.
  isSelf: boolean;
  // Whether the author may push to the repository: only they teach rules, so
  // an outsider's comments cannot steer what a team enforces. Asked last, as it
  // may cost a forge call.
  allowed: () => Promise<boolean>;
  // Whether the author is a bot, for forges whose webhook does not say (a
  // GitHub bot is recognised by its login). Asked only once the author is
  // allowed, as it may cost a forge call too.
  isBot?: () => Promise<boolean>;
}

export type ReviewCommentOutcome = "stored" | "off" | "skipped" | "not_allowed" | "duplicate" | "failed" | "error";

// Stores a person's comment on a changed line, if its workspace learns rules.
// Never throws: a delivery that also carries a thread reply must go on to it.
// A failure a retry could fix is "failed", so the caller can fail the delivery
// and have it redelivered (a stored comment comes back "duplicate"). One that
// would fail the same way every time is "error" and only logged: failing those
// deliveries would get the hook disabled (GitLab does after repeated failures),
// stopping automatic reviews too, for a comment that can never be kept.
export async function recordReviewComment(input: ReviewCommentInput): Promise<ReviewCommentOutcome> {
  try {
    return await record(input);
  } catch (err) {
    console.error("[webhook] could not store review comment %s on %s#%d", input.commentId, input.repo.fullPath, input.number, err);
    return isPermanent(err) ? "error" : "failed";
  }
}

// Prisma codes for input the database will never accept.
const PERMANENT_PRISMA_CODES = new Set(["P2000", "P2006", "P2007", "P2011", "P2012", "P2019", "P2020"]);

// Errors a redelivery would hit again. Anything not known to be permanent
// counts as transient, so evidence is only given up when it is certain.
function isPermanent(err: unknown): boolean {
  if (err instanceof ForgeError) return err.status >= 400 && err.status < 500 && err.status !== 429 && !err.rateLimited;
  if (err instanceof Prisma.PrismaClientValidationError) return true;
  if (!(err instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (PERMANENT_PRISMA_CODES.has(err.code)) return true;
  // The driver adapter carries Postgres' SQLSTATE: class 22 is a data
  // exception (a value the column cannot hold), 23 an integrity violation.
  const sqlState = (err.meta as { driverAdapterError?: { cause?: { code?: unknown } } } | undefined)?.driverAdapterError?.cause?.code;
  return typeof sqlState === "string" && /^2[23]/.test(sqlState);
}

// Postgres text cannot hold NUL, so a body or path carrying one would be
// refused on every redelivery. It means nothing to a reader either.
function withoutNul(text: string): string {
  return text.replaceAll("\u0000", "");
}

async function record(input: ReviewCommentInput): Promise<ReviewCommentOutcome> {
  const { repo, number, author } = input;
  const body = withoutNul(input.body);
  const workspace = await prisma.workspace.findUnique({
    where: { id: repo.connection.workspaceId },
    select: { ruleSuggestionsEnabled: true, ruleSuggestionsExcludedReviewers: true },
  });
  // Nothing is kept for a workspace that did not opt in.
  if (!workspace?.ruleSuggestionsEnabled) return "off";

  const text = body.trim();
  // Only a comment anchored to a current new-side line is about the change:
  // an outdated or removed-line one (no line) teaches nothing a rule could hold.
  const line = input.line;
  if (!author || !input.file || line == null || input.isSelf || author.endsWith("[bot]")) return "skipped";
  if (text.length < MIN_COMMENT_CHARS || REVIEW_COMMAND.test(text)) return "skipped";
  // Anything Sentryward posts carries a marker; a person quoting one is rare
  // enough to lose.
  if (text.includes(REPLY_MARKER) || markersIn(text).length > 0) return "skipped";
  const excluded = new Set(workspace.ruleSuggestionsExcludedReviewers.map((login) => login.toLowerCase()));
  if (excluded.has(author.toLowerCase())) return "skipped";
  if (input.threadId && (await postedThread(input))) return "skipped";
  if (!(await input.allowed())) return "not_allowed";
  if (input.isBot && (await input.isBot())) return "skipped";
  if (input.threadId && (await markedThread(input))) return "skipped";

  const file = withoutNul(input.file);
  try {
    return await prisma.$transaction(async (tx): Promise<ReviewCommentOutcome> => {
      // The settings may have changed during the forge calls above. Read them
      // again under a share lock: turning suggestions off (or excluding a
      // reviewer) updates this row before deleting stored comments, so either
      // that waits for this insert and deletes it, or this sees the new
      // settings. FOR KEY SHARE would not conflict with that update.
      const [current] = await tx.$queryRaw<{ enabled: boolean; excluded: string[] }[]>`
        SELECT rule_suggestions_enabled AS enabled, rule_suggestions_excluded_reviewers AS excluded
        FROM workspaces WHERE id = ${repo.connection.workspaceId}::uuid
        FOR SHARE
      `;
      if (!current?.enabled) return "off";
      if (current.excluded.some((login) => login.toLowerCase() === author.toLowerCase())) return "skipped";
      await tx.reviewComment.create({
        data: {
          repositoryId: repo.id,
          number,
          forgeCommentId: input.commentId,
          author,
          body: text.slice(0, MAX_COMMENT_BODY),
          file,
          line,
        },
      });
      return "stored";
    });
  } catch (err) {
    // The forge redelivered an event already recorded.
    if (isUniqueViolation(err)) return "duplicate";
    throw err;
  }
}

// A reply in a thread Sentryward opened is the reply queue's. Such a thread is
// usually known locally by its first comment's id, at no forge cost.
async function postedThread({ repo, number, threadId }: ReviewCommentInput): Promise<boolean> {
  const posted = await prisma.postedFinding.findFirst({
    where: { repositoryId: repo.id, number, forgeCommentId: threadId },
    select: { id: true },
  });
  return Boolean(posted);
}

// The local row is replaced when the finding is posted again, purged by
// retention, or never held the comment id (GitHub's review fallback), so an
// unknown thread on a change with findings is checked on the forge by its
// root's marker. The marker, not the author: a token connection posts as a
// person.
async function markedThread({ repo, number, threadRoot }: ReviewCommentInput): Promise<boolean> {
  if (!threadRoot) return false;
  const tracked = await prisma.finding.findFirst({ where: { repositoryId: repo.id, number }, select: { id: true } });
  if (!tracked) return false;
  return Boolean((await threadRoot())?.fingerprint);
}
