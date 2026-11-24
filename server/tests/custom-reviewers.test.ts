import { describe, expect, it } from "vitest";
import { parseRepoFile } from "../src/review/config/repoFile.ts";
import { resolveConfig } from "../src/review/config/resolve.ts";
import {
  MAX_REVIEWERS,
  configOverrideSchema,
  customReviewerSchema,
  type Config,
  type ConfigOverride,
  type CustomReviewer,
} from "../src/review/config/schema.ts";
import type { Finding } from "../src/review/core/models.ts";
import { lensesFor } from "../src/review/llm/lenses.ts";
import { reviewSystemPrompt } from "../src/review/llm/prompt.ts";
import type { GenerateRequest } from "../src/review/llm/providers.ts";
import { ModelCallError } from "../src/review/llm/providers.ts";
import { runReview } from "../src/review/pipeline.ts";
import { inlineBody } from "../src/review/publish/inline.ts";
import { capPerReviewer } from "../src/review/validate/validator.ts";
import { withTrialReviewer } from "../src/worker/runJob.ts";
import { APP_PATCH, makeChangeSet } from "./helpers/changeSet.ts";
import { fakeModel, modelFinding } from "./helpers/model.ts";

const reviewer = (overrides: Partial<CustomReviewer> = {}): CustomReviewer => ({
  id: "api-contracts",
  name: "API contracts",
  instructions: "Response shapes that change without a version bump.",
  ...overrides,
});

// Walkthrough off so every model call in these tests is a review pass.
const config = (override: ConfigOverride = {}): Config =>
  resolveConfig({ trigger: { ...override, output: { walkthrough: false, ...override.output } } }).config;

const withReviewers = (reviewers: CustomReviewer[], override: ConfigOverride = {}) => config({ ...override, reviewers });

// The custom reviewer a review request was made for, read off its system prompt.
function reviewerOf(request: GenerateRequest<unknown>): string | undefined {
  return /Team-defined reviewer "([^"]+)"/.exec(request.system ?? "")?.[1];
}

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    file: "src/app.ts",
    startLine: 11,
    endLine: 11,
    severity: "major",
    category: "bug",
    kind: "potential_issue",
    effort: "quick_win",
    title: "t",
    body: "b",
    confidence: 0.9,
    evidence: "execution_path",
    evidenceNote: "n",
    evidenceFiles: [],
    source: "llm",
    fingerprint: "fp",
    bucket: "actionable",
    ...overrides,
  };
}

describe("custom reviewer config", () => {
  it("has none by default", () => {
    expect(config().reviewers).toEqual([]);
    expect(lensesFor(config()).map((lens) => lens.id)).toEqual(["general"]);
  });

  it("refuses ids the built-in reviewers use, duplicates and too many", () => {
    expect(customReviewerSchema.safeParse(reviewer({ id: "tests" })).success).toBe(false);
    expect(customReviewerSchema.safeParse(reviewer({ id: "general" })).success).toBe(false);
    // Every file is said by leaving paths out, never by an empty list.
    expect(customReviewerSchema.safeParse(reviewer({ paths: [] })).success).toBe(false);
    expect(configOverrideSchema.safeParse({ reviewers: [reviewer(), reviewer()] }).success).toBe(false);
    const many = Array.from({ length: MAX_REVIEWERS + 1 }, (_, i) => reviewer({ id: `r${i}` }));
    expect(configOverrideSchema.safeParse({ reviewers: many }).success).toBe(false);
  });

  it("reads snake_case from the repository file", () => {
    const parsed = parseRepoFile(
      ".sentryward.yaml",
      "reviewers:\n  - id: docs\n    name: Docs\n    instructions: Public API without docs.\n    severity_floor: info\n    max_findings: 3\n",
    );
    expect(parsed).toEqual({
      override: { reviewers: [{ id: "docs", name: "Docs", instructions: "Public API without docs.", severityFloor: "info", maxFindings: 3 }] },
      warnings: [],
    });
  });

  it("combines across layers like rules: a layer adds, never redefines", () => {
    const resolved = resolveConfig({
      global: { reviewers: [reviewer()] },
      repoFile: { reviewers: [reviewer({ name: "Looser" }), reviewer({ id: "docs", name: "Docs" })] },
    });
    expect(resolved.config.reviewers.map((r) => [r.id, r.name])).toEqual([
      ["api-contracts", "API contracts"],
      ["docs", "Docs"],
    ]);
    expect(resolved.sources["reviewers.api-contracts"]).toBe("global");
    expect(resolved.sources["reviewers.docs"]).toBe("repoFile");
    expect(resolved.warnings).toEqual([
      "Custom reviewer api-contracts in the repository file was ignored: a custom reviewer with that id is already set in the global config",
    ]);
    expect(resolved.combinedIssues[0]).toMatchObject({ layer: "repoFile", list: "reviewers", kind: "clash" });
  });

  it("leaves a layer's reviewers out as a whole when together they pass the limit", () => {
    const below = Array.from({ length: MAX_REVIEWERS }, (_, i) => reviewer({ id: `r${i}` }));
    const resolved = resolveConfig({ global: { reviewers: below }, repoFile: { reviewers: [reviewer({ id: "extra" })] } });
    expect(resolved.config.reviewers).toEqual(below);
    expect(resolved.sources["reviewers.extra"]).toBeUndefined();
    expect(resolved.warnings[0]).toMatch(/^Custom reviewers in the repository file were ignored: together with the custom reviewers below them/);
  });

  it("does not run a disabled reviewer", () => {
    expect(lensesFor(withReviewers([reviewer({ enabled: false })])).map((lens) => lens.id)).toEqual(["general"]);
  });
});

describe("custom reviewer prompts", () => {
  it("give the reviewer its instructions and name instead of the team rules", () => {
    const cfg = withReviewers([reviewer()], { rules: [{ id: "no-console", description: "Do not log with console.", severity: "minor" }] });
    const [general, custom] = lensesFor(cfg);
    const prompt = reviewSystemPrompt(cfg, custom);
    expect(prompt).toContain('Team-defined reviewer "API contracts"');
    expect(prompt).toContain("Response shapes that change without a version bump.");
    expect(prompt).not.toContain("no-console");
    expect(reviewSystemPrompt(cfg, general)).toContain("no-console");
  });
});

describe("runReview with custom reviewers", () => {
  it("adds a pass per reviewer and tags its findings with its id and name", async () => {
    const { generate, requests } = fakeModel({
      code_review: (request: GenerateRequest<unknown>) =>
        reviewerOf(request)
          ? { findings: [modelFinding({ title: "The response drops a field", category: "docs", ruleId: "no-console" })] }
          : { findings: [] },
    });
    const result = await runReview({ changeSet: makeChangeSet(), config: withReviewers([reviewer()]) }, { generate });
    expect(requests.map(reviewerOf)).toEqual([undefined, "API contracts"]);
    // Kept outside review.categories, and never as a rule it was not given.
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ reviewer: "api-contracts", reviewerName: "API contracts", source: "llm", category: "docs" });
    expect(result.findings[0]!.ruleId).toBeUndefined();
    expect(result.usage.map((call) => call.lens)).toEqual([undefined, "api-contracts"]);
  });

  it("skips a reviewer whose paths the change does not touch", async () => {
    const { generate, requests } = fakeModel({ code_review: { findings: [] } });
    await runReview({ changeSet: makeChangeSet(), config: withReviewers([reviewer({ paths: ["docs/**"] })]) }, { generate });
    expect(requests).toHaveLength(1);
    expect(reviewerOf(requests[0]!)).toBeUndefined();
  });

  it("drops a finding on a file outside the reviewer's paths", async () => {
    const changeSet = makeChangeSet([
      { path: "src/app.ts", changeType: "modified", patch: APP_PATCH },
      { path: "lib/app.ts", changeType: "modified", patch: APP_PATCH },
    ]);
    const { generate } = fakeModel({
      code_review: (request: GenerateRequest<unknown>) =>
        reviewerOf(request)
          ? { findings: [modelFinding({ title: "In scope" }), modelFinding({ file: "lib/app.ts", title: "Out of scope" })] }
          : { findings: [] },
    });
    const result = await runReview({ changeSet, config: withReviewers([reviewer({ paths: ["src/**"] })]) }, { generate });
    expect(result.findings.map((f) => f.title)).toEqual(["In scope"]);
    expect(result.validation.dropped.reviewer_mismatch).toBe(1);
  });

  it("holds the reviewer's findings to its own severity floor", async () => {
    const { generate } = fakeModel({
      code_review: (request: GenerateRequest<unknown>) =>
        reviewerOf(request) ? { findings: [modelFinding({ title: "Worth knowing", severity: "info" })] } : { findings: [] },
    });
    const strict = await runReview({ changeSet: makeChangeSet(), config: withReviewers([reviewer()]) }, { generate });
    expect(strict.findings).toEqual([]);
    const own = await runReview({ changeSet: makeChangeSet(), config: withReviewers([reviewer({ severityFloor: "info" })]) }, { generate });
    expect(own.findings.map((f) => f.title)).toEqual(["Worth knowing"]);
  });

  it("caps the reviewer's findings at its comment limit", async () => {
    const { generate } = fakeModel({
      code_review: (request: GenerateRequest<unknown>) =>
        reviewerOf(request)
          ? {
              findings: [
                modelFinding({ title: "Minor one", severity: "minor" }),
                modelFinding({ title: "Major one", severity: "major", startLine: 12, endLine: 12 }),
              ],
            }
          : { findings: [] },
    });
    const result = await runReview({ changeSet: makeChangeSet(), config: withReviewers([reviewer({ maxFindings: 1 })]) }, { generate });
    expect(result.findings.map((f) => f.title)).toEqual(["Major one"]);
    expect(result.validation.dropped.over_limit).toBe(1);
  });

  it("reports a failed reviewer pass as a warning, not a partial review", async () => {
    const { generate } = fakeModel({
      code_review: (request: GenerateRequest<unknown>) =>
        reviewerOf(request) ? new ModelCallError("overloaded", [{ model: "anthropic/x", inputTokens: 900, outputTokens: 0, latencyMs: 4 }]) : { findings: [] },
    });
    const result = await runReview({ changeSet: makeChangeSet(), config: withReviewers([reviewer()]) }, { generate });
    expect(result.status).toBe("completed");
    expect(result.warnings.some((w) => w.startsWith("Custom reviewer API contracts on pass 1 failed"))).toBe(true);
  });

  it("drops what the reviewer found in a pass whose general pass failed, and says so", async () => {
    const { generate } = fakeModel({
      code_review: (request: GenerateRequest<unknown>) =>
        reviewerOf(request)
          ? { findings: [modelFinding({ title: "Found anyway" })] }
          : new ModelCallError("overloaded", [{ model: "anthropic/x", inputTokens: 900, outputTokens: 0, latencyMs: 4 }]),
    });
    const result = await runReview({ changeSet: makeChangeSet(), config: withReviewers([reviewer()]) }, { generate });
    expect(result.findings).toEqual([]);
    expect(result.warnings).toContain("1 custom reviewer finding was dropped with files whose review pass failed");
  });
});

describe("capPerReviewer", () => {
  it("leaves findings without a limited reviewer alone", () => {
    const cfg = withReviewers([reviewer({ maxFindings: 1 })]);
    const findings = [finding({ title: "a" }), finding({ title: "b" }), finding({ title: "c", reviewer: "api-contracts" })];
    expect(capPerReviewer(findings, cfg)).toEqual({ findings, overLimit: 0 });
  });
});

describe("rendering", () => {
  it("names the custom reviewer on the inline comment, escaped", () => {
    const body = inlineBody(finding({ reviewer: "api-contracts", reviewerName: "API *contracts*" }), "github");
    expect(body.split("\n")[0]).toContain("· reviewer API \\*contracts\\*");
    expect(inlineBody(finding({ reviewer: "tests" }), "github").split("\n")[0]).not.toContain("reviewer");
  });
});

describe("trial config", () => {
  it("adds the draft, switched on, in place of a saved reviewer with its id", () => {
    const saved = withReviewers([reviewer(), reviewer({ id: "docs", name: "Docs" })]);
    const draft = reviewer({ name: "API contracts v2", enabled: false });
    const trial = withTrialReviewer(saved, { trial: true, trialReviewer: draft });
    expect(trial.reviewers.map((r) => [r.id, r.name, r.enabled])).toEqual([
      ["docs", "Docs", undefined],
      ["api-contracts", "API contracts v2", true],
    ]);
    expect(withTrialReviewer(saved, { trial: false, trialReviewer: null })).toBe(saved);
  });

  it("refuses a stored draft that no longer validates", () => {
    expect(() => withTrialReviewer(config(), { trial: true, trialReviewer: { id: "tests" } })).toThrow(/no longer valid/);
  });
});
