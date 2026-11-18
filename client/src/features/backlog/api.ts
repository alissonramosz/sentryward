import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { api } from "@/lib/api"
import type { Severity } from "@/features/reviews/types"
import type { FindingCategory, FindingKind } from "@/features/findings/types"
import type { BacklogItem, BacklogOrigin, BacklogSortKey, BacklogState, BacklogStats } from "./types"

export interface BacklogPage {
  items: BacklogItem[]
  total: number
  page: number
  limit: number
}

export interface BacklogQuery {
  repoId?: string
  state?: BacklogState
  origin?: BacklogOrigin
  severity?: Severity
  category?: FindingCategory
  kind?: FindingKind
  olderThanDays?: number
  q?: string
  sort?: BacklogSortKey
  dir?: "asc" | "desc"
  page?: number
  limit?: number
}

// Only set params go into the URL, in a fixed order so query keys and stubs
// stay predictable.
function backlogSearch(params: BacklogQuery) {
  const search = new URLSearchParams()
  for (const key of ["repoId", "state", "origin", "severity", "category", "kind", "olderThanDays", "q", "sort", "dir", "page", "limit"] as const) {
    if (params[key]) search.set(key, String(params[key]))
  }
  return search.toString()
}

export function useBacklog(params: BacklogQuery = {}) {
  const query = backlogSearch(params)
  return useQuery({
    queryKey: ["backlog", params],
    queryFn: () => api<BacklogPage>(`/backlog${query ? `?${query}` : ""}`),
    // Keep the current page on screen while the next one loads.
    placeholderData: keepPreviousData,
  })
}

// Under the "backlog" key, so dismissing or reopening an item refreshes the cards too.
// Workspace-wide unless a repository is given.
export function useBacklogStats(repoId?: string) {
  const query = backlogSearch({ repoId })
  return useQuery({
    queryKey: ["backlog", "stats", repoId ?? null],
    queryFn: () => api<BacklogStats>(`/backlog/stats${query ? `?${query}` : ""}`),
  })
}

export type BacklogStateChange = { id: string; state: "open" } | { id: string; state: "dismissed"; note?: string }

export function useSetBacklogState() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...change }: BacklogStateChange) =>
      api<{ item: BacklogItem }>(`/backlog/${id}`, { method: "PATCH", body: JSON.stringify(change) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["backlog"] }),
  })
}
