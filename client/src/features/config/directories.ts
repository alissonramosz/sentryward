import type { DirectorySetting, ForgeRepo } from "@/features/forge/api"

export const MAX_DIRECTORIES = 50

// Older repository payloads (and test fixtures) may not carry the list yet.
export function directoriesOf(repo: Pick<ForgeRepo, "directories">): DirectorySetting[] {
  return repo.directories ?? []
}

// The same normalisation and checks as directorySettingsSchema on the server,
// so most mistakes show before a save; the server has the last word.
export function normalizeDirectory(path: string) {
  return path
    .trim()
    .replace(/\\/g, "/")
    .replace(/^(\.\/)+/, "")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/{2,}/g, "/")
}

export function directoryError(path: string, existing: string[]): string | undefined {
  if (!path) return "Enter a folder path"
  if (path.length > 300) return "Use at most 300 characters"
  if (/[*?[\]{}]/.test(path)) return "Enter a folder path, not a pattern"
  if (path.split("/").some((part) => part === "." || part === "..")) return "Use a path inside the repository"
  const inside = (outer: string, inner: string) => inner === outer || inner.startsWith(`${outer}/`)
  const other = existing.find((dir) => inside(dir, path) || inside(path, dir))
  if (other === path) return `${path} is already configured`
  if (other) return `${path} overlaps ${other}; folders cannot be inside one another`
  if (existing.length >= MAX_DIRECTORIES) return `Use at most ${MAX_DIRECTORIES} folders`
  return undefined
}
