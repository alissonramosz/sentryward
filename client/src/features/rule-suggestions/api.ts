import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { Rule } from "@/features/config/api"
import { api } from "@/lib/api"

// Rule suggestions drafted from review history; mirrors
// server/src/controllers/ruleSuggestions.controller.ts.

export type SuggestionStatus = "pending" | "approved" | "discarded"

export interface SuggestionExcerpt {
  kind: "dismissal" | "comment"
  repositoryId?: string
  repository: string
  number: number
  file: string
  text: string
  // When the quoted comment or dismissal was made (absent on older rows).
  at?: string
}

export interface RuleSuggestion {
  id: string
  status: SuggestionStatus
  rule: Rule
  rationale: string
  evidence: {
    findingIds: string[]
    commentIds: string[]
    changes: number
    // Emptied by retention; the counts above stay.
    excerpts: SuggestionExcerpt[]
  }
  model: string
  // "global" or the repository id the approved rule went to.
  appliedTarget: string | null
  decidedAt: string | null
  createdAt: string
  // The suggested target; null is the global settings.
  repository: { id: string; host: string; fullPath: string; followGlobal: boolean } | null
}

export interface SuggestionList {
  suggestions: RuleSuggestion[]
  counts: Record<SuggestionStatus, number>
  // Passed back as `cursor` for the next page; null on the last.
  nextCursor: string | null
}

export interface SuggestionSettings {
  enabled: boolean
  minEvidence: number
  excludedReviewers: string[]
  // When the last run started; null when never run, or a run was asked for.
  lastRunAt: string | null
  // Review comments kept as evidence.
  storedComments: number
}

export type ApproveTarget = "global" | { repositoryId: string }

const KEY = ["rule-suggestions"]
const SETTINGS_KEY = ["rule-suggestions", "settings"]

// Newest first, a page at a time; invalidating KEY refetches every loaded page.
export function useRuleSuggestions(status: SuggestionStatus, options: { enabled?: boolean } = {}) {
  return useInfiniteQuery({
    queryKey: [...KEY, "list", status],
    queryFn: ({ pageParam }) =>
      api<SuggestionList>(`/rule-suggestions?status=${status}${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""}`),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: options.enabled ?? true,
  })
}

// Counts alone, for the nav badge: the list carries every suggestion's
// evidence excerpts. Under KEY, so whatever refreshes the list refreshes this.
export function useRuleSuggestionCounts(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: [...KEY, "counts"],
    queryFn: () => api<Pick<SuggestionList, "counts">>("/rule-suggestions/counts"),
    enabled: options.enabled ?? true,
  })
}

export function useRuleSuggestionSettings(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: SETTINGS_KEY,
    queryFn: () => api<SuggestionSettings>("/rule-suggestions/settings"),
    enabled: options.enabled ?? true,
  })
}

export function useSaveRuleSuggestionSettings() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (settings: Pick<SuggestionSettings, "enabled" | "minEvidence" | "excludedReviewers">) =>
      api<SuggestionSettings>("/rule-suggestions/settings", { method: "PUT", body: JSON.stringify(settings) }),
    onSuccess: (data) => {
      queryClient.setQueryData(SETTINGS_KEY, data)
      // Turning suggestions off or excluding a reviewer strips comment
      // excerpts from the stored suggestions, which only the lists carry.
      return queryClient.invalidateQueries({ queryKey: [...KEY, "list"] })
    },
  })
}

export function useRunRuleSuggestions() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => api<SuggestionSettings>("/rule-suggestions/run", { method: "POST" }),
    onSuccess: (data) => queryClient.setQueryData(SETTINGS_KEY, data),
  })
}

// Approving changes saved settings, so the config and repository caches go too.
export function useApproveRuleSuggestion() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, rule, target }: { id: string; rule: Rule; target: ApproveTarget }) =>
      api<{ suggestion: RuleSuggestion }>(`/rule-suggestions/${id}/approve`, {
        method: "POST",
        body: JSON.stringify({ rule, target }),
      }),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: KEY }),
        queryClient.invalidateQueries({ queryKey: ["global-config"] }),
        queryClient.invalidateQueries({ queryKey: ["repo-config"] }),
        queryClient.invalidateQueries({ queryKey: ["repos"] }),
      ]),
  })
}

export function useDiscardRuleSuggestion() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api<{ suggestion: RuleSuggestion }>(`/rule-suggestions/${id}/discard`, { method: "POST" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: KEY }),
  })
}
