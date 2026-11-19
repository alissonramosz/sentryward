import type { IgnoreReason, Prisma } from "../generated/prisma/client.ts";
import type { Resolve } from "../lib/hostSafety.ts";
import { prisma } from "../lib/prisma.ts";
import { resolveDashboardLayers } from "../review/config/load.ts";
import type { Rule } from "../review/config/schema.ts";
import { preselect, storedEvidence, validateSuggestions, type EvidenceItem } from "../review/learn/suggest.ts";
import { abortableGenerate, createGenerate, modelChain, type ApiKeys, type Endpoint, type Generate, type ProviderBaseUrls } from "../review/llm/providers.ts";
import { suggestRules } from "../review/llm/ruleSuggest.ts";
import { llmCredentialsFor } from "../services/llm.ts";
import { auditedGenerate } from "../services/llmAudit.ts";
import { guardModels, policyFor, type EffectivePolicy } from "../services/privacyPolicy.ts";
import { CLOSE_CHECK_INTERVAL_MS, watchForClose } from "./closeWatch.ts";
import { resolveLlm, type LlmCredentials } from "./llmEndpoint.ts";
import { ruleHistoryCutoff } from "./retention.ts";

// Drafts team rules from a workspace's review history (review/learn/suggest.ts)
// for an admin to approve. Opt-in per workspace, at most once a week each:
// a run is a model call billed to the workspace.

export const SUGGEST_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
// Rows read per source before preselection; the most recent win.
const MAX_ROWS_PER_SOURCE = 2000;
const MAX_DISCARDED_SHOWN = 20;
// Dismissals that say something about the code. "Fix later" agrees with the
// finding, and an unspecified reason says nothing.
const LEARNED_REASONS: IgnoreReason[] = ["false_positive", "intentional"];

export interface RuleSuggestionDeps {
  generateFor: (keys: ApiKeys, endpoint?: Endpoint, baseUrls?: ProviderBaseUrls) => Generate;
  credentialsFor: (workspaceId: string) => Promise<LlmCredentials>;
  policyFor: (workspaceId: string) => Promise<EffectivePolicy>;
  resolveHost?: Resolve;
  // How often a run checks, while the model answers, that it may still go on.
  claimCheckIntervalMs?: number;
}

const defaultDeps: RuleSuggestionDeps = {
  generateFor: createGenerate,
  credentialsFor: llmCredentialsFor,
  policyFor,
};

export type RunOutcome =
  | { workspaceId: string; outcome: "suggested"; created: number; dropped: number }
  | { workspaceId: string; outcome: "not_enough_history" | "blocked" | "failed" | "turned_off"; reason?: string };

// Claims the workspace most overdue for a run and marks it run, in one
// statement: SKIP LOCKED keeps two workers off the same workspace, and the
// mark is set before the model call so a failing run waits a full interval
// instead of retrying (and billing) every poll. The returned token identifies
// this run (see claimStillCurrent).
async function claimDueWorkspace(now: Date): Promise<{ id: string; token: string } | null> {
  const due = new Date(now.getTime() - SUGGEST_INTERVAL_MS);
  const rows = await prisma.$queryRaw<{ id: string; token: string }[]>`
    UPDATE workspaces SET rule_suggestions_last_run_at = ${now}, rule_suggestions_run_token = gen_random_uuid()
    WHERE id = (
      SELECT id FROM workspaces
      WHERE rule_suggestions_enabled
        AND (rule_suggestions_last_run_at IS NULL OR rule_suggestions_last_run_at < ${due})
      ORDER BY rule_suggestions_last_run_at NULLS FIRST, id
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, rule_suggestions_run_token::text AS token
  `;
  return rows[0] ?? null;
}

// Whether the run holding `token` may still go on: suggestions are on, and
// neither another claim nor turning suggestions off has replaced the token.
// The claim time could not serve: saving the settings leaves it alone, so
// turning suggestions off and on again between two checks would make the run
// current again, with evidence loaded before its rows were deleted.
async function claimStillCurrent(db: Prisma.TransactionClient, workspaceId: string, token: string): Promise<boolean> {
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT id FROM workspaces
    WHERE id = ${workspaceId}::uuid AND rule_suggestions_enabled AND rule_suggestions_run_token = ${token}::uuid
  `;
  return rows.length > 0;
}

// Runs one due workspace, if any. The worker calls this in the background, one
// at a time, so a slow model never holds up claiming reviews.
export async function runNextRuleSuggestions(now = new Date(), deps: RuleSuggestionDeps = defaultDeps): Promise<RunOutcome | null> {
  const claim = await claimDueWorkspace(now);
  if (!claim) return null;
  const workspaceId = claim.id;
  try {
    return await suggestForWorkspace(workspaceId, claim.token, now, deps);
  } catch (err) {
    console.error("[worker] rule suggestions failed for workspace %s", workspaceId, err);
    return { workspaceId, outcome: "failed", reason: err instanceof Error ? err.message : String(err) };
  }
}

function repoLabel(repo: { host: string; fullPath: string }): string {
  return `${repo.host}/${repo.fullPath}`;
}

// `since` is the retention cutoff (ruleHistoryCutoff), not the bare history
// window: anything older would be dropped at save time after the model call
// was paid for, and is past what the workspace agreed to keep.
async function loadEvidence(workspaceId: string, excluded: string[], since: Date): Promise<EvidenceItem[]> {
  const inWorkspace = { connection: { workspaceId } };
  const [dismissals, comments] = await Promise.all([
    prisma.finding.findMany({
      where: {
        repository: inWorkspace,
        state: "ignored",
        ignoreReason: { in: LEARNED_REASONS },
        suggestionId: null,
        ignoredAt: { gte: since },
      },
      select: {
        id: true,
        repositoryId: true,
        number: true,
        file: true,
        category: true,
        title: true,
        ignoreReason: true,
        ignoreNote: true,
        ignoredAt: true,
        repository: { select: { host: true, fullPath: true } },
      },
      orderBy: { ignoredAt: "desc" },
      take: MAX_ROWS_PER_SOURCE,
    }),
    prisma.reviewComment.findMany({
      where: { repository: inWorkspace, suggestionId: null, createdAt: { gte: since } },
      select: {
        id: true,
        repositoryId: true,
        number: true,
        file: true,
        author: true,
        body: true,
        createdAt: true,
        repository: { select: { host: true, fullPath: true } },
      },
      orderBy: { createdAt: "desc" },
      take: MAX_ROWS_PER_SOURCE,
    }),
  ]);
  // Comments are dropped at write time too; this covers reviewers excluded since.
  const skip = new Set(excluded.map((login) => login.toLowerCase()));
  return [
    ...dismissals.map(
      (row, index): EvidenceItem => ({
        ref: `d${index + 1}`,
        kind: "dismissal",
        id: row.id,
        repositoryId: row.repositoryId,
        repository: repoLabel(row.repository),
        number: row.number,
        file: row.file,
        category: row.category,
        title: row.title,
        reason: row.ignoreReason ?? undefined,
        text: row.ignoreNote ?? "",
        // Filtered on above, so never null here.
        at: row.ignoredAt!,
      }),
    ),
    ...comments
      .filter((row) => !skip.has(row.author.toLowerCase()))
      .map(
        (row, index): EvidenceItem => ({
          ref: `c${index + 1}`,
          kind: "comment",
          id: row.id,
          repositoryId: row.repositoryId,
          repository: repoLabel(row.repository),
          number: row.number,
          file: row.file,
          text: row.body,
          at: row.createdAt,
        }),
      ),
  ];
}

type KnownRule = Pick<Rule, "id" | "description">;

// Rules saved in any dashboard layer of the workspace. Read leniently: a saved
// value that no longer parses still names ids a new rule must not reuse.
function rulesIn(settings: unknown): KnownRule[] {
  const rules = (settings as { rules?: unknown } | null)?.rules;
  if (!Array.isArray(rules)) return [];
  return rules.flatMap((rule) =>
    rule && typeof rule.id === "string" ? [{ id: rule.id, description: String(rule.description ?? "") }] : [],
  );
}

// Takes a client so the save can read the rules again inside its transaction.
async function knownRules(db: Prisma.TransactionClient, workspaceId: string, globalSettings: unknown) {
  const [repos, pending, discarded] = await Promise.all([
    db.repository.findMany({ where: { connection: { workspaceId } }, select: { settings: true, directories: true } }),
    db.ruleSuggestion.findMany({ where: { workspaceId, status: "pending" }, select: { rule: true } }),
    // Every discarded rule, not only those the prompt shows: the model may
    // ignore the prompt, and a discarded id must never come back.
    db.ruleSuggestion.findMany({
      where: { workspaceId, status: "discarded" },
      select: { rule: true },
      orderBy: { decidedAt: "desc" },
    }),
  ]);
  const discardedRules = discarded.flatMap((row) => rulesIn({ rules: [row.rule] }));
  const existing = new Map<string, KnownRule>();
  const add = (rules: KnownRule[]) => rules.forEach((rule) => existing.has(rule.id) || existing.set(rule.id, rule));
  add(rulesIn(globalSettings));
  for (const repo of repos) {
    add(rulesIn(repo.settings));
    if (Array.isArray(repo.directories)) {
      for (const dir of repo.directories) add(rulesIn((dir as { settings?: unknown } | null)?.settings));
    }
  }
  const pendingRules = pending.flatMap((row) => rulesIn({ rules: [row.rule] }));
  // `.sentryward.yaml` rules are not known here; an approved rule that clashes
  // with one is reported by the review that reads the file, like any clash.
  const takenIds = new Set([
    ...existing.keys(),
    ...pendingRules.map((rule) => rule.id),
    ...discardedRules.map((rule) => rule.id),
  ]);
  return {
    existingRules: [...existing.values(), ...pendingRules],
    discarded: discardedRules.slice(0, MAX_DISCARDED_SHOWN),
    takenIds,
  };
}

export async function suggestForWorkspace(workspaceId: string, token: string, now: Date, deps: RuleSuggestionDeps = defaultDeps): Promise<RunOutcome> {
  const workspace = await prisma.workspace.findUniqueOrThrow({
    where: { id: workspaceId },
    select: { name: true, reviewSettings: true, ruleSuggestionsMinEvidence: true, ruleSuggestionsExcludedReviewers: true },
  });
  const minEvidence = workspace.ruleSuggestionsMinEvidence;
  const policy = await deps.policyFor(workspaceId);
  const since = ruleHistoryCutoff(policy.retentionDays, now);
  const evidence = preselect(await loadEvidence(workspaceId, workspace.ruleSuggestionsExcludedReviewers, since), minEvidence);
  if (!evidence.length) return { workspaceId, outcome: "not_enough_history" };

  // The workspace's own model settings, as its global config resolves them:
  // the run belongs to no repository.
  const config = resolveDashboardLayers({ globalSettings: workspace.reviewSettings, followGlobal: true }).config;
  const model = modelChain(config.llm, "review")[0]!;
  const llm = resolveLlm(config, [model], await deps.credentialsFor(workspaceId));
  const guard = await guardModels(policy, [model, ...llm.fallbackModels], llm.endpoint, llm.baseUrls, deps.resolveHost);
  const refused = guard.rejected.get(model);
  if (refused) {
    console.log("[worker] rule suggestions for workspace %s blocked by its privacy policy: %s", workspaceId, refused.message);
    return { workspaceId, outcome: "blocked", reason: refused.message };
  }
  const fallbackModels = llm.fallbackModels.filter((fallback) => !guard.rejected.has(fallback));
  const known = await knownRules(prisma, workspaceId, workspace.reviewSettings);

  // Suggestions may have been turned off since the claim, and the stored
  // comments deleted with them: checking only at save time would still send
  // the evidence loaded above and bill the call. Checked again now, the last
  // moment before the request, and while it runs, aborting it (fallbacks
  // included) once the claim stops being current.
  if (!(await claimStillCurrent(prisma, workspaceId, token))) return { workspaceId, outcome: "turned_off" };
  const watch = watchForClose(
    async () => !(await claimStillCurrent(prisma, workspaceId, token)),
    deps.claimCheckIntervalMs ?? CLOSE_CHECK_INTERVAL_MS,
  );
  const generate = auditedGenerate(abortableGenerate(deps.generateFor(llm.keys, llm.endpoint, llm.baseUrls), watch.signal), guard.target, {
    workspaceId,
    workspaceName: workspace.name,
  }, guard);
  let result: Awaited<ReturnType<typeof suggestRules>>;
  try {
    result = await suggestRules(
      generate,
      { evidence, existingRules: known.existingRules, discarded: known.discarded },
      { ...config, llm: { ...config.llm, fallbackModels } },
    );
  } catch (err) {
    if (watch.signal.aborted) return { workspaceId, outcome: "turned_off" };
    throw err;
  } finally {
    watch.stop();
  }
  const { drafts, response } = result;

  const saved = await prisma.$transaction(async (tx) => {
    // The settings may have changed during the model call. Read them again
    // under a share lock, as recordReviewComment does: turning suggestions off
    // (or excluding a reviewer) updates this row before deleting stored
    // comments and stripping excerpts, so either that waits for this
    // transaction and strips what it writes, or this sees the new settings and
    // the deletions. FOR KEY SHARE would not conflict with that update. The
    // run token is compared too (see claimStillCurrent), so turning
    // suggestions off and on again during the call still stops this run.
    const [current] = await tx.$queryRaw<{ enabled: boolean; min_evidence: number; review_settings: unknown }[]>`
      SELECT rule_suggestions_enabled AND rule_suggestions_run_token IS NOT DISTINCT FROM ${token}::uuid AS enabled,
        rule_suggestions_min_evidence AS min_evidence, review_settings
      FROM workspaces WHERE id = ${workspaceId}::uuid FOR SHARE
    `;
    if (!current?.enabled) return null;
    // Validated here rather than before the transaction: a raised minimum, or
    // a rule approved under the drafted id, may have landed during the model
    // call. Saving settings, the global config and every approval (repository
    // targets included) write or lock this row first, so they are either
    // visible now or wait for this commit. A rule added by hand to a
    // repository or folder is saved under the repository's lock only; like a
    // `.sentryward.yaml` clash, approval refuses the taken id there.
    const fresh = await knownRules(tx, workspaceId, current.review_settings);
    const { suggestions, dropped } = validateSuggestions(drafts, {
      evidence,
      takenIds: fresh.takenIds,
      minEvidence: current.min_evidence,
    });
    // Every cited comment and dismissal may have gone during the model call:
    // an excluded reviewer's comments are deleted when the exclusion is saved,
    // retention deletes comments and findings, and a dismissal can be undone.
    // Lock the ones still standing (the level of the suggestion_id update
    // below, which conflicts with a delete) so none goes before this commits,
    // and only those retention would keep: evidence was loaded within the
    // cutoff, but an item can age past it during the model call and be deleted
    // the moment the lock is released, leaving an excerpt behind. A suggestion
    // missing any of its evidence is dropped whole.
    const cutoff = ruleHistoryCutoff(policy.retentionDays, new Date());
    const commentIds = suggestions.flatMap((s) => s.evidence.filter((item) => item.kind === "comment").map((item) => item.id));
    const findingIds = suggestions.flatMap((s) => s.evidence.filter((item) => item.kind === "dismissal").map((item) => item.id));
    const lockedComments = commentIds.length
      ? await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM review_comments
          WHERE id = ANY(${commentIds}::uuid[]) AND suggestion_id IS NULL AND created_at >= ${cutoff}
          ORDER BY id FOR NO KEY UPDATE
        `
      : [];
    const lockedFindings = findingIds.length
      ? await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM findings
          WHERE id = ANY(${findingIds}::uuid[]) AND suggestion_id IS NULL
            AND state::text = 'ignored' AND ignore_reason::text = ANY(${LEARNED_REASONS}::text[])
            AND ignored_at >= ${cutoff}
          ORDER BY id FOR NO KEY UPDATE
        `
      : [];
    const standing = new Set([...lockedComments, ...lockedFindings].map((row) => row.id));
    const kept = suggestions.filter((s) => s.evidence.every((item) => standing.has(item.id)));
    for (const suggestion of kept) {
      const created = await tx.ruleSuggestion.create({
        data: {
          workspaceId,
          repositoryId: suggestion.repositoryId,
          rule: suggestion.rule as Prisma.InputJsonValue,
          rationale: suggestion.rationale,
          evidence: storedEvidence(suggestion.evidence) as unknown as Prisma.InputJsonValue,
          model: response.model,
        },
      });
      // Only rows still uncited: each item backs one suggestion at most.
      const findingIds = suggestion.evidence.filter((item) => item.kind === "dismissal").map((item) => item.id);
      const citedComments = suggestion.evidence.filter((item) => item.kind === "comment").map((item) => item.id);
      await tx.finding.updateMany({ where: { id: { in: findingIds }, suggestionId: null }, data: { suggestionId: created.id } });
      await tx.reviewComment.updateMany({ where: { id: { in: citedComments }, suggestionId: null }, data: { suggestionId: created.id } });
    }
    return { created: kept.length, removed: suggestions.length - kept.length, dropped };
  });
  if (!saved) return { workspaceId, outcome: "turned_off" };
  const { dropped } = saved;
  if (saved.removed) dropped.evidence_removed = (dropped.evidence_removed ?? 0) + saved.removed;
  const droppedCount = Object.values(dropped).reduce((sum, count) => sum + (count ?? 0), 0);
  return { workspaceId, outcome: "suggested", created: saved.created, dropped: droppedCount };
}
