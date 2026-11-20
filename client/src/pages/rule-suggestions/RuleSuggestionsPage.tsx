import { useState } from "react"
import { Lightbulb, Lock, RotateCw } from "lucide-react"
import { PageHeader } from "@/components/PageHeader"
import { PageShell } from "@/components/PageShell"
import { SegmentedControl } from "@/components/SegmentedControl"
import { Button } from "@/components/ui/button"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { useAuth } from "@/features/auth/useAuth"
import { useRepos } from "@/features/forge/api"
import { useRuleSuggestions, useRuleSuggestionSettings, type SuggestionStatus } from "@/features/rule-suggestions/api"
import { SettingsCard } from "@/features/rule-suggestions/SettingsCard"
import { SuggestionCard } from "@/features/rule-suggestions/SuggestionCard"

const EMPTY_TEXT: Record<SuggestionStatus, string> = {
  pending: "Nothing to review. Suggestions appear here when comments or dismissals recur across changes.",
  approved: "No suggestions approved yet.",
  discarded: "No suggestions discarded.",
}

function ListSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-label="Loading suggestions">
      {[0, 1].map((index) => (
        <div key={index} className="flex flex-col gap-3 rounded-lg border border-l-4 p-6">
          <Skeleton className="h-5 w-48" />
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-12 w-full" />
        </div>
      ))}
    </div>
  )
}

export function RuleSuggestionsPage() {
  const { workspace } = useAuth()
  const canManage = workspace?.role === "owner" || workspace?.role === "admin"
  const [status, setStatus] = useState<SuggestionStatus>("pending")
  const list = useRuleSuggestions(status, { enabled: canManage })
  const settings = useRuleSuggestionSettings({ enabled: canManage })
  const repos = useRepos()
  const suggestions = list.data?.pages.flatMap((page) => page.suggestions) ?? []
  // From the first page: refetched first, so it is as fresh as any.
  const counts = list.data?.pages[0]?.counts
  const enabled = settings.data?.enabled
  // Until toggled by hand, settings start open only while the feature is off,
  // so first-time setup is in view and a configured page leads with the list.
  const [settingsOpen, setSettingsOpen] = useState<boolean>()
  const open = settingsOpen ?? enabled === false

  if (!canManage) {
    return (
      <PageShell>
        <PageHeader title="Rule suggestions" />
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Lock />
            </EmptyMedia>
            <EmptyTitle>Owners and admins only</EmptyTitle>
            <EmptyDescription>Ask a workspace owner or admin to review rule suggestions.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </PageShell>
    )
  }

  function openSettings() {
    setSettingsOpen(true)
    document.getElementById("rule-suggestion-settings")?.scrollIntoView?.({ behavior: "smooth", block: "start" })
  }

  const turnedOff = enabled === false && status === "pending"

  return (
    <PageShell>
      <PageHeader
        title="Rule suggestions"
        description="Team rules drafted from what your reviewers keep asking for and the findings they dismiss. Nothing changes in your review settings until you approve one."
      />
      <SettingsCard open={open} onOpenChange={setSettingsOpen} />
      <SegmentedControl
        label="Suggestion status"
        value={status}
        onChange={setStatus}
        options={[
          { value: "pending", label: `Pending${counts ? ` (${counts.pending})` : ""}` },
          { value: "approved", label: `Approved${counts ? ` (${counts.approved})` : ""}` },
          { value: "discarded", label: `Discarded${counts ? ` (${counts.discarded})` : ""}` },
        ]}
      />
      {list.isPending ? (
        <ListSkeleton />
      ) : list.isError ? (
        <div className="flex items-center gap-3">
          <p className="text-sm text-destructive">Could not load the suggestions.</p>
          <Button type="button" variant="outline" size="sm" onClick={() => list.refetch()}>
            <RotateCw />
            Retry
          </Button>
        </div>
      ) : suggestions.length === 0 ? (
        <Empty className="border border-dashed">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Lightbulb />
            </EmptyMedia>
            <EmptyTitle>{turnedOff ? "Rule suggestions are off" : "No suggestions"}</EmptyTitle>
            <EmptyDescription>
              {turnedOff
                ? "Turn them on and Sentryward will draft rules from the comments and dismissals that keep coming up."
                : EMPTY_TEXT[status]}
            </EmptyDescription>
          </EmptyHeader>
          {turnedOff && !open && (
            <EmptyContent>
              <Button type="button" size="sm" onClick={openSettings}>
                Open settings
              </Button>
            </EmptyContent>
          )}
        </Empty>
      ) : (
        <div className="flex flex-col gap-4">
          {suggestions.map((suggestion) => (
            <SuggestionCard key={suggestion.id} suggestion={suggestion} repos={repos.data?.repos ?? []} />
          ))}
          {list.hasNextPage && (
            <Button
              type="button"
              variant="outline"
              className="self-center"
              disabled={list.isFetchingNextPage}
              onClick={() => list.fetchNextPage()}
            >
              {list.isFetchingNextPage ? "Loading..." : "Load more"}
            </Button>
          )}
        </div>
      )}
    </PageShell>
  )
}
