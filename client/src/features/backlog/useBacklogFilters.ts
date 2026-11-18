import type { ActiveFilter } from "@/components/TableFilters"
import { useDebounced } from "@/hooks/use-debounced"
import { usePagination } from "@/hooks/use-pagination"
import { nextSort, type Sort } from "@/hooks/use-sort"
import { useUrlFilters } from "@/hooks/use-url-filters"
import { ALL, choices, only, selectedLabel } from "@/lib/filters"
import { CATEGORY_OPTIONS, KIND_OPTIONS, SEVERITY_OPTIONS } from "@/features/findings/options"
import type { BacklogQuery } from "./api"
import { AGE_OPTIONS, BACKLOG_STATE_OPTIONS, ORIGIN_OPTIONS } from "./options"
import type { BacklogSortKey } from "./types"

const SORT_KEYS = ["title", "severity", "repository", "mergedAt", "firstSeenAt"] satisfies BacklogSortKey[]

// The backlog is the open items; resolved and dismissed ones are a filter away.
const DEFAULTS = {
  state: "open",
  origin: ALL,
  severity: ALL,
  category: ALL,
  kind: ALL,
  age: ALL,
  repo: ALL,
  q: "",
  sort: "",
  dir: "",
}

// Repository ids are not checked: a stale one just matches nothing.
const ALLOWED = {
  state: choices(BACKLOG_STATE_OPTIONS),
  origin: choices(ORIGIN_OPTIONS),
  severity: choices(SEVERITY_OPTIONS),
  category: choices(CATEGORY_OPTIONS),
  kind: choices(KIND_OPTIONS),
  age: choices(AGE_OPTIONS),
  sort: ["", ...SORT_KEYS],
  dir: ["", "asc", "desc"],
}

type RepoOption = { value: string; label: string }

// Filters, search, sort and paging for the backlog list, kept in the URL like
// the findings list's.
export function useBacklogFilters(repoOptions: RepoOption[]) {
  const pagination = usePagination()
  const { values: raw, set } = useUrlFilters(DEFAULTS, { allowed: ALLOWED })
  const { state, origin, severity, category, kind, age, repo } = raw
  const q = useDebounced(raw.q.trim())
  const sort: Sort<BacklogSortKey> =
    raw.sort && raw.dir ? { key: raw.sort as BacklogSortKey, dir: raw.dir as "asc" | "desc" } : null

  const params: BacklogQuery = {
    state: only<NonNullable<BacklogQuery["state"]>>(state),
    origin: only<NonNullable<BacklogQuery["origin"]>>(origin),
    severity: only<NonNullable<BacklogQuery["severity"]>>(severity),
    category: only<NonNullable<BacklogQuery["category"]>>(category),
    kind: only<NonNullable<BacklogQuery["kind"]>>(kind),
    olderThanDays: age === ALL ? undefined : Number(age),
    repoId: only(repo),
    q: q || undefined,
    // Unsorted leaves the server's default: most recently merged first.
    sort: sort?.key,
    dir: sort?.dir,
    page: pagination.page,
    limit: pagination.size,
  }

  const filtering =
    state !== DEFAULTS.state ||
    origin !== ALL ||
    severity !== ALL ||
    category !== ALL ||
    kind !== ALL ||
    age !== ALL ||
    repo !== ALL
  const narrowed = filtering || q !== ""

  function onSort(key: BacklogSortKey) {
    const next = nextSort(sort, key)
    set({ sort: next?.key ?? "", dir: next?.dir ?? "" })
  }

  function setSort(next: Sort<BacklogSortKey>) {
    set({ sort: next?.key ?? "", dir: next?.dir ?? "" })
  }

  function clearFilters() {
    set({ state: DEFAULTS.state, origin: ALL, severity: ALL, category: ALL, kind: ALL, age: ALL, repo: ALL })
  }

  // Each setter starts over at the first page (useUrlFilters does that).
  const setters = {
    setState: (value: string) => set({ state: value }),
    setOrigin: (value: string) => set({ origin: value }),
    setSeverity: (value: string) => set({ severity: value }),
    setCategory: (value: string) => set({ category: value }),
    setKind: (value: string) => set({ kind: value }),
    setAge: (value: string) => set({ age: value }),
    setRepo: (value: string) => set({ repo: value }),
    setQuery: (value: string) => set({ q: value }),
  }

  // The default state is not a chip: it is what the page is.
  const activeFilters = [
    {
      label: "State",
      value: state === DEFAULTS.state ? null : (selectedLabel(state, BACKLOG_STATE_OPTIONS) ?? "All states"),
      onRemove: () => setters.setState(DEFAULTS.state),
    },
    { label: "Origin", value: selectedLabel(origin, ORIGIN_OPTIONS), onRemove: () => setters.setOrigin(ALL) },
    { label: "Severity", value: selectedLabel(severity, SEVERITY_OPTIONS), onRemove: () => setters.setSeverity(ALL) },
    { label: "Category", value: selectedLabel(category, CATEGORY_OPTIONS), onRemove: () => setters.setCategory(ALL) },
    { label: "Type", value: selectedLabel(kind, KIND_OPTIONS), onRemove: () => setters.setKind(ALL) },
    { label: "Age", value: selectedLabel(age, AGE_OPTIONS), onRemove: () => setters.setAge(ALL) },
    { label: "Repository", value: selectedLabel(repo, repoOptions), onRemove: () => setters.setRepo(ALL) },
  ].filter((filter): filter is ActiveFilter => filter.value !== null)

  return {
    values: { state, origin, severity, category, kind, age, repo, query: raw.q },
    setters,
    params,
    sort,
    onSort,
    setSort,
    pagination,
    filtering,
    narrowed,
    clearFilters,
    activeFilters,
  }
}

export type BacklogFilters = ReturnType<typeof useBacklogFilters>
