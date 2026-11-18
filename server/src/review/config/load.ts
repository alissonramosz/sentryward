import { cacheKey, cached, type ForgeCache } from "../forge/cache.ts";
import type { ForgeAdapter } from "../forge/types.ts";
import { parseRepoFile, REPO_CONFIG_FILES } from "./repoFile.ts";
import type { ChangedFile } from "../core/models.ts";
import { pickDirectory } from "./directories.ts";
import { resolveConfig, type ResolvedConfig, type RuleIssue } from "./resolve.ts";
import {
  dashboardOverrideSchema,
  directorySettingsSchema,
  normalizeDirectory,
  type Config,
  type ConfigOverride,
  type DashboardOverride,
  type DirectorySetting,
} from "./schema.ts";

export interface LoadConfigInput {
  adapter: ForgeAdapter;
  project: string;
  // The revision the repository file is read from. For a review this is the
  // base, never the head: a change must not be able to loosen its own review.
  ref: string;
  globalSettings?: unknown;
  repoSettings?: unknown;
  // Folders with settings of their own (Repository.directories).
  directories?: unknown;
  // The repository follows the global config, so its own settings are ignored
  // (but kept, so turning this off brings them back).
  followGlobal?: boolean;
  trigger?: ConfigOverride;
  // How the folder is chosen: by the change's files, or by name (a reply
  // follows the folder its review used; the dashboard previews one). Neither
  // means the repository settings.
  changedFiles?: Pick<ChangedFile, "path" | "previousPath">[];
  directory?: string | null;
  // Files at a sha never change, so a cached read is as good as a fresh one.
  cache?: ForgeCache;
}

export interface LoadedConfig extends ResolvedConfig {
  repoFile: string | null;
  // The folder whose settings applied, if any.
  directory: string | null;
  warnings: string[];
}

type SavedSettings = Pick<LoadConfigInput, "globalSettings" | "repoSettings" | "directories" | "followGlobal">;

// Saved settings were valid when written; a schema change since then must
// not take every review of the repository down with it.
function savedLayers(input: SavedSettings, warnings: string[]) {
  function saved(value: unknown, label: string): DashboardOverride | undefined {
    if (value === undefined) return undefined;
    const parsed = dashboardOverrideSchema.safeParse(value);
    if (parsed.success) return parsed.data;
    warnings.push(`Saved ${label} settings are no longer valid and were ignored`);
    return undefined;
  }
  // Folders belong to the repository settings, so following the global
  // config leaves them out too.
  let directories: DirectorySetting[] = [];
  if (!input.followGlobal && input.directories !== undefined) {
    const parsed = directorySettingsSchema.safeParse(input.directories);
    if (parsed.success) directories = parsed.data;
    else warnings.push("Saved folder settings are no longer valid and were ignored");
  }
  return {
    global: saved(input.globalSettings, "global"),
    repoSettings: input.followGlobal ? undefined : saved(input.repoSettings, "repository"),
    directories,
  };
}

// The configuration before the repository file is read, for decisions that
// come first: whether to read through the cache, and whether a webhook may
// cancel a review without a forge call. No folder applies yet: which one
// depends on the change's files.
export function loadDashboardConfig(input: SavedSettings): Config {
  const { global, repoSettings } = savedLayers(input, []);
  return resolveConfig({ global, repoSettings }).config;
}

// Rules a repository's own settings, or one of its folders, could not add on
// top of the layers below, so a save can be refused instead of the rules being
// left out of every review with only a warning. `directory` is the index of
// the folder at fault, or undefined for the repository settings.
export function repoSettingsRuleIssues(input: SavedSettings): (RuleIssue & { directory?: number })[] {
  const { global, repoSettings, directories } = savedLayers(input, []);
  const issues: (RuleIssue & { directory?: number })[] = resolveConfig({ global, repoSettings }).ruleIssues.filter(
    (issue) => issue.layer === "repoSettings",
  );
  directories.forEach((dir, index) => {
    for (const issue of resolveConfig({ global, repoSettings, directory: dir.settings }).ruleIssues) {
      if (issue.layer === "directory") issues.push({ ...issue, message: `${dir.path}: ${issue.message}`, directory: index });
    }
  });
  return issues;
}

export async function loadReviewConfig(input: LoadConfigInput): Promise<LoadedConfig> {
  const warnings: string[] = [];
  const { global, repoSettings, directories } = savedLayers(input, warnings);

  let repoFile: string | null = null;
  let fileOverride: ConfigOverride | undefined;
  for (const name of REPO_CONFIG_FILES) {
    const text = await cached(input.cache, cacheKey("file", input.adapter.host, input.project, name, input.ref), () =>
      input.adapter.getFileAtRef(input.project, name, input.ref),
    );
    if (text === null) continue;
    // Like roborak, the first file found wins; the two are never merged.
    repoFile = name;
    const result = parseRepoFile(name, text);
    fileOverride = result.override;
    warnings.push(...result.warnings);
    break;
  }

  const layers = { global, repoSettings, repoFile: fileOverride, trigger: input.trigger };
  let directory: DirectorySetting | null = null;
  if (input.directory) {
    const name = normalizeDirectory(input.directory);
    directory = directories.find((dir) => dir.path === name) ?? null;
  } else if (input.changedFiles) {
    directory = pickDirectory(directories, input.changedFiles, resolveConfig(layers).config.ignorePaths);
  }
  const resolved = resolveConfig({ ...layers, directory: directory?.settings });
  return { ...resolved, repoFile, directory: directory?.path ?? null, warnings: [...warnings, ...resolved.warnings] };
}
