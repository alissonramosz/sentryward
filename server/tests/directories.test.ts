import { describe, expect, it } from "vitest";
import { pickDirectory } from "../src/review/config/directories.ts";
import { loadReviewConfig, repoSettingsCombinedIssues } from "../src/review/config/load.ts";
import { resolveConfig } from "../src/review/config/resolve.ts";
import { directorySettingsSchema, type DirectorySetting } from "../src/review/config/schema.ts";
import type { ForgeAdapter } from "../src/review/forge/types.ts";

const billing: DirectorySetting = { path: "services/billing", settings: { profile: "strict" } };
const web: DirectorySetting = { path: "web", settings: { review: { maxFindings: 5 } } };
const files = (...paths: string[]) => paths.map((path) => ({ path }));

describe("directorySettingsSchema", () => {
  it("normalises paths", () => {
    const parsed = directorySettingsSchema.parse([{ path: " ./services//billing/ ", settings: {} }, { path: "\\web", settings: {} }]);
    expect(parsed.map((dir) => dir.path)).toEqual(["services/billing", "web"]);
  });

  it("refuses patterns, parent references and empty paths", () => {
    for (const path of ["services/*", "a/../b", "./", "", "a/./b"]) {
      expect(directorySettingsSchema.safeParse([{ path, settings: {} }]).success, path).toBe(false);
    }
  });

  it("refuses duplicate and nested folders, naming the later one", () => {
    const nested = directorySettingsSchema.safeParse([billing, { path: "services", settings: {} }]);
    expect(nested.success).toBe(false);
    expect(nested.error!.issues[0]).toMatchObject({ path: [1, "path"], message: "services overlaps services/billing; folders cannot be inside one another" });

    const dup = directorySettingsSchema.safeParse([billing, { path: "services/billing/", settings: {} }]);
    expect(dup.error!.issues[0]!.message).toBe("services/billing is already configured");
  });

  it("allows siblings that share a prefix", () => {
    expect(directorySettingsSchema.safeParse([billing, { path: "services/billing-v2", settings: {} }]).success).toBe(true);
  });

  it("refuses settings a dashboard layer cannot hold", () => {
    expect(directorySettingsSchema.safeParse([{ path: "web", settings: { nope: 1 } }]).success).toBe(false);
  });
});

describe("pickDirectory", () => {
  const dirs = [billing, web];

  it("picks the folder every file sits in", () => {
    expect(pickDirectory(dirs, files("services/billing/a.ts", "services/billing/lib/b.ts"), [])).toBe(billing);
  });

  it("uses the repository settings when a file is outside, or in a second folder", () => {
    expect(pickDirectory(dirs, files("services/billing/a.ts", "README.md"), [])).toBeNull();
    expect(pickDirectory(dirs, files("services/billing/a.ts", "web/b.ts"), [])).toBeNull();
    expect(pickDirectory(dirs, files("README.md"), [])).toBeNull();
  });

  it("does not match a sibling that only shares a prefix", () => {
    expect(pickDirectory(dirs, files("services/billing-v2/a.ts"), [])).toBeNull();
  });

  it("leaves ignored files out of the decision", () => {
    expect(pickDirectory(dirs, files("web/a.ts", "package-lock.json"), ["**/package-lock.json"])).toBe(web);
    expect(pickDirectory(dirs, files("package-lock.json"), ["**/package-lock.json"])).toBeNull();
  });

  it("counts both sides of a move", () => {
    expect(pickDirectory(dirs, [{ path: "web/a.ts", previousPath: "services/billing/a.ts" }], [])).toBeNull();
    expect(pickDirectory(dirs, [{ path: "web/b.ts", previousPath: "web/a.ts" }], [])).toBe(web);
  });

  it("picks nothing without folders or files", () => {
    expect(pickDirectory([], files("web/a.ts"), [])).toBeNull();
    expect(pickDirectory(dirs, [], [])).toBeNull();
  });
});

describe("resolveConfig with a folder", () => {
  it("sits above the repository settings and below the repository file", () => {
    const { config, sources } = resolveConfig({
      repoSettings: { review: { maxFindings: 10, minConfidence: 0.7 } },
      directory: { review: { maxFindings: 20, severityFloor: "major" } },
      repoFile: { review: { severityFloor: "critical" } },
    });
    expect(config.review.maxFindings).toBe(20);
    expect(config.review.minConfidence).toBe(0.7);
    expect(config.review.severityFloor).toBe("critical");
    expect(sources["review.maxFindings"]).toBe("directory");
    expect(sources["review.severityFloor"]).toBe("repoFile");
  });

  it("only adds rules, and holds its rules like other dashboard rules", () => {
    const repoRule = { id: "own", description: "Own.", severity: "minor" as const };
    const { config, sources, warnings } = resolveConfig({
      repoSettings: { rules: [repoRule] },
      directory: { review: { severityFloor: "major" }, rules: [{ id: "own", description: "Weaker.", severity: "info" }, { id: "folder", description: "Folder.", severity: "major" }] },
      // Raising the floor cannot quieten dashboard rules, the folder's included.
      repoFile: { review: { severityFloor: "critical" } },
    });
    expect(config.rules.map((rule) => rule.id)).toEqual(["own", "folder"]);
    expect(sources["rules.folder"]).toBe("directory");
    expect(warnings).toEqual(["Rule own in the folder settings was ignored: a rule with that id is already set in the repository settings"]);
    expect(config.ruleGuard).toMatchObject({ ids: ["own", "folder"], severityFloor: "major" });
  });
});

function fakeAdapter(files: Record<string, string> = {}) {
  return { getFileAtRef: async (_project: string, path: string, ref: string) => files[`${ref}:${path}`] ?? null } as unknown as ForgeAdapter;
}

describe("loadReviewConfig with folders", () => {
  const base = { adapter: fakeAdapter(), project: "acme/mono", ref: "base", directories: [billing, web] };

  it("applies the folder the change sits in and names it", async () => {
    const loaded = await loadReviewConfig({ ...base, changedFiles: files("services/billing/a.ts") });
    expect(loaded.directory).toBe("services/billing");
    expect(loaded.config.profile).toBe("strict");
    expect(loaded.sources.profile).toBe("directory");
  });

  it("uses the repository settings for a change across folders", async () => {
    const loaded = await loadReviewConfig({ ...base, changedFiles: files("services/billing/a.ts", "web/b.ts") });
    expect(loaded.directory).toBeNull();
    expect(loaded.config.profile).toBe("balanced");
  });

  it("chooses with the ignore list of the repository file", async () => {
    const loaded = await loadReviewConfig({
      ...base,
      adapter: fakeAdapter({ "base:.sentryward.yaml": "ignore_paths:\n  - docs/**\n" }),
      changedFiles: files("web/a.ts", "docs/x.md"),
    });
    expect(loaded.directory).toBe("web");
  });

  it("applies a folder by name", async () => {
    const loaded = await loadReviewConfig({ ...base, directory: "web/" });
    expect(loaded.directory).toBe("web");
    expect(loaded.config.review.maxFindings).toBe(5);
    expect((await loadReviewConfig({ ...base, directory: "gone" })).directory).toBeNull();
  });

  it("ignores folders while following the global config", async () => {
    const loaded = await loadReviewConfig({ ...base, followGlobal: true, changedFiles: files("web/a.ts") });
    expect(loaded.directory).toBeNull();
    expect(loaded.config.review.maxFindings).toBe(25);
  });

  it("keeps reviewing with a warning when saved folders no longer validate", async () => {
    const loaded = await loadReviewConfig({ ...base, directories: [{ path: "web", settings: { retired: true } }], changedFiles: files("web/a.ts") });
    expect(loaded.directory).toBeNull();
    expect(loaded.warnings).toContain("Saved folder settings are no longer valid and were ignored");
  });
});

describe("repoSettingsCombinedIssues with folders", () => {
  it("reports a folder rule clash with the folder's index and path", () => {
    const issues = repoSettingsCombinedIssues({
      globalSettings: { rules: [{ id: "shared", description: "Strict.", severity: "critical" }] },
      repoSettings: {},
      directories: [web, { path: "api", settings: { rules: [{ id: "shared", description: "Weaker.", severity: "info" }] } }],
    });
    expect(issues).toEqual([
      expect.objectContaining({ layer: "directory", kind: "clash", directory: 1, message: expect.stringMatching(/^api: Rule shared in the folder settings/) }),
    ]);
  });
});
