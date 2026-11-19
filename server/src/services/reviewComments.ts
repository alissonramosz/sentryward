import { prisma } from "../lib/prisma.ts";
import { REVIEW_COMMAND } from "../lib/webhook.ts";
import { markersIn, REPLY_MARKER } from "../review/core/markers.ts";
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
}

export type ReviewCommentOutcome = "stored" | "off" | "skipped" | "not_allowed" | "duplicate";

// Stores a person's comment on a changed line, if its workspace learns rules.
// Never throws: a failure here must not fail the delivery, which may also
// carry a thread reply.
export async function recordReviewComment(input: ReviewCommentInput): Promise<ReviewCommentOutcome> {
  try {
    return await record(input);
  } catch (err) {
    console.error("[webhook] could not store review comment %s on %s#%d", input.commentId, input.repo.fullPath, input.number, err);
    return "skipped";
  }
}

async function record(input: ReviewCommentInput): Promise<ReviewCommentOutcome> {
  const { repo, number, author, body } = input;
  const workspace = await prisma.workspace.findUnique({
    where: { id: repo.connection.workspaceId },
    select: { ruleSuggestionsEnabled: true, ruleSuggestionsExcludedReviewers: true },
  });
  // Nothing is kept for a workspace that did not opt in.
  if (!workspace?.ruleSuggestionsEnabled) return "off";

  const text = body.trim();
  if (!author || !input.file || input.isSelf || author.endsWith("[bot]")) return "skipped";
  if (text.length < MIN_COMMENT_CHARS || REVIEW_COMMAND.test(text)) return "skipped";
  // Anything Sentryward posts carries a marker; a person quoting one is rare
  // enough to lose.
  if (text.includes(REPLY_MARKER) || markersIn(text).length > 0) return "skipped";
  const excluded = new Set(workspace.ruleSuggestionsExcludedReviewers.map((login) => login.toLowerCase()));
  if (excluded.has(author.toLowerCase())) return "skipped";
  if (input.threadId) {
    // A thread Sentryward opened is known locally by its first comment's id.
    const own = await prisma.postedFinding.findFirst({
      where: { repositoryId: repo.id, number, forgeCommentId: input.threadId },
      select: { id: true },
    });
    if (own) return "skipped";
  }
  if (!(await input.allowed())) return "not_allowed";

  try {
    await prisma.reviewComment.create({
      data: {
        repositoryId: repo.id,
        number,
        forgeCommentId: input.commentId,
        author,
        body: text.slice(0, MAX_COMMENT_BODY),
        file: input.file,
        line: input.line ?? null,
      },
    });
    return "stored";
  } catch (err) {
    // The forge redelivered an event already recorded.
    if (isUniqueViolation(err)) return "duplicate";
    throw err;
  }
}
