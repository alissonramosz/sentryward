import { ruleSchema, type Rule } from "../config/schema.ts";

// Rule suggestions learned from review history (worker/ruleSuggestions.ts).
// Pure: what to send the model, and which of its drafts hold up. Nothing here
// reaches a config layer; an admin approves each suggestion first.

export interface EvidenceItem {
  // Short handle the model cites ("d3", "c12"), so it never has to copy a
  // database id and a typo cannot cite a real row by accident.
  ref: string;
  kind: "dismissal" | "comment";
  // The finding's or review comment's id.
  id: string;
  repositoryId: string;
  // host/fullPath, for the prompt and the suggestion's excerpts.
  repository: string;
  number: number;
  file: string;
  // Dismissals only.
  category?: string;
  title?: string;
  reason?: string;
  // The dismissal's note or the comment's body: untrusted, written by people
  // on the change.
  text: string;
  // When the comment was left or the finding dismissed: retention expires the
  // stored excerpt by this, not by the suggestion's age.
  at: Date;
}

// What reaches the model is bounded however much history there is: excerpts
// are cut and the selection capped by count and total size.
export const MAX_EXCERPT_CHARS = 500;
export const MAX_SELECTED_ITEMS = 150;
export const MAX_SELECTED_CHARS = 40_000;
// History older than this says little about how the team works now. Review
// comments are kept only this long (worker/retention.ts).
export const HISTORY_MS = 90 * 24 * 60 * 60 * 1000;
// A pattern seen on one change is a habit of that change, not of the team.
export const MIN_CHANGES = 2;

// Lowercased, with quoted names and numbers dropped, so "Unused import `foo`"
// and "Unused import `bar`" fall together. A single quote inside a word is an
// apostrophe ("don't", "user's"), not the start of a quoted name.
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/`[^`]*`|"[^"]*"|(?<![a-z0-9])'[^']*'(?![a-z0-9])/g, " ")
    .replace(/[0-9]+/g, " ")
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8)
    .join(" ");
}

// The first two folders of a path ("src/billing" for src/billing/api/x.ts), the
// level at which a monorepo's conventions usually differ.
export function areaOf(file: string): string {
  const folders = file.split("/").slice(0, -1);
  return folders.slice(0, 2).join("/") || ".";
}

function groupKeys(item: EvidenceItem): string[] {
  const keys = [`area:${item.repositoryId}:${areaOf(item.file)}`];
  if (item.kind === "dismissal" && item.title) {
    const title = normalizeTitle(item.title);
    keys.push(`finding:${item.repositoryId}:${item.category}:${title}`);
    // The same dismissal across repositories points at a workspace rule.
    keys.push(`finding:*:${item.category}:${title}`);
  }
  return keys;
}

function changeKey(item: EvidenceItem): string {
  return `${item.repositoryId}#${item.number}`;
}

// The history worth a model call: items in a group (a repository area, or a
// recurring kind of dismissed finding) with at least minEvidence items across
// at least MIN_CHANGES changes. Largest groups first, then capped. Empty means
// nothing recurs enough, and no call is made.
export function preselect(items: EvidenceItem[], minEvidence: number): EvidenceItem[] {
  const groups = new Map<string, EvidenceItem[]>();
  for (const item of items) {
    for (const key of groupKeys(item)) {
      const group = groups.get(key);
      if (group) group.push(item);
      else groups.set(key, [item]);
    }
  }
  const qualifying = [...groups.values()]
    .filter((group) => group.length >= minEvidence && new Set(group.map(changeKey)).size >= MIN_CHANGES)
    .sort((a, b) => b.length - a.length);

  const selected = new Map<string, EvidenceItem>();
  let chars = 0;
  for (const group of qualifying) {
    for (const item of group) {
      if (selected.has(item.ref)) continue;
      const size = Math.min(item.text.length, MAX_EXCERPT_CHARS) + (item.title?.length ?? 0) + item.file.length;
      if (selected.size >= MAX_SELECTED_ITEMS || chars + size > MAX_SELECTED_CHARS) return [...selected.values()];
      selected.set(item.ref, item);
      chars += size;
    }
  }
  return [...selected.values()];
}

export interface DraftSuggestion {
  rule: unknown;
  rationale: string;
  evidenceRefs: string[];
}

export interface ValidSuggestion {
  rule: Rule;
  rationale: string;
  evidence: EvidenceItem[];
  // The repository every cited item came from, or null (the workspace's
  // global settings) when they span several.
  repositoryId: string | null;
}

// "evidence_removed" is set by the worker (worker/ruleSuggestions.ts), not
// here: a cited comment deleted while the model was answering.
export type SuggestionDropReason = "invalid_rule" | "id_taken" | "unknown_evidence" | "too_little_evidence" | "evidence_removed";

export interface ValidationOutcome {
  suggestions: ValidSuggestion[];
  dropped: Partial<Record<SuggestionDropReason, number>>;
}

// Keeps the drafts an admin could approve as they are: a valid rule (pattern
// included, compiled with RE2 by the schema), an id no rule or pending
// suggestion has, and enough real evidence. A draft citing a ref that was not
// sent is dropped whole rather than trimmed: it is evidence the model made up.
export function validateSuggestions(
  drafts: DraftSuggestion[],
  { evidence, takenIds, minEvidence }: { evidence: EvidenceItem[]; takenIds: ReadonlySet<string>; minEvidence: number },
): ValidationOutcome {
  const byRef = new Map(evidence.map((item) => [item.ref, item]));
  const taken = new Set(takenIds);
  // An item backs one suggestion at most, as it is marked cited by it.
  const cited = new Set<string>();
  const dropped: ValidationOutcome["dropped"] = {};
  const drop = (reason: SuggestionDropReason) => {
    dropped[reason] = (dropped[reason] ?? 0) + 1;
  };
  const suggestions: ValidSuggestion[] = [];

  for (const draft of drafts) {
    const parsed = ruleSchema.safeParse(draft.rule);
    if (!parsed.success) {
      drop("invalid_rule");
      continue;
    }
    const rule = parsed.data;
    if (taken.has(rule.id)) {
      drop("id_taken");
      continue;
    }
    const refs = [...new Set(draft.evidenceRefs.map((ref) => ref.trim()))];
    if (refs.some((ref) => !byRef.has(ref))) {
      drop("unknown_evidence");
      continue;
    }
    const items = refs.filter((ref) => !cited.has(ref)).map((ref) => byRef.get(ref)!);
    if (items.length < minEvidence || new Set(items.map(changeKey)).size < MIN_CHANGES) {
      drop("too_little_evidence");
      continue;
    }
    const repositories = new Set(items.map((item) => item.repositoryId));
    taken.add(rule.id);
    for (const item of items) cited.add(item.ref);
    suggestions.push({
      rule,
      rationale: draft.rationale.trim().slice(0, 1000),
      evidence: items,
      repositoryId: repositories.size === 1 ? items[0]!.repositoryId : null,
    });
  }
  return { suggestions, dropped };
}

// How evidence names its repository, in prompts and stored excerpts; deleting
// a repository finds its excerpts by this too.
export function repoLabel(repo: { host: string; fullPath: string }): string {
  return `${repo.host}/${repo.fullPath}`;
}

export interface StoredEvidence {
  findingIds: string[];
  commentIds: string[];
  // Distinct changes cited, so the page can say "across N changes" after the
  // excerpts are trimmed.
  changes: number;
  // `at` (ISO) is the source's time; excerpts stored before it existed lack it.
  excerpts: { kind: EvidenceItem["kind"]; repository: string; number: number; file: string; text: string; at?: string }[];
}

// What a suggestion keeps of its evidence. Each excerpt is trimmed by
// retention once the comment or dismissal it quotes is past the cutoff; the
// ids and counts stay.
export function storedEvidence(items: EvidenceItem[]): StoredEvidence {
  return {
    findingIds: items.filter((item) => item.kind === "dismissal").map((item) => item.id),
    commentIds: items.filter((item) => item.kind === "comment").map((item) => item.id),
    changes: new Set(items.map(changeKey)).size,
    excerpts: items.map((item) => ({
      kind: item.kind,
      repository: item.repository,
      number: item.number,
      file: item.file,
      text: (item.kind === "dismissal" ? [item.title, item.text].filter(Boolean).join(": ") : item.text).slice(0, MAX_EXCERPT_CHARS),
      at: item.at.toISOString(),
    })),
  };
}
