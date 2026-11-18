import { CircleDot, Hourglass } from "lucide-react"
import { Skeleton } from "@/components/ui/skeleton"
import { SeverityBadge } from "@/features/reviews/badges"
import { Stat } from "@/features/reviews/ReviewStatsStrip"
import { useBacklogStats } from "./api"
import { AGE_LABEL } from "./options"

// How much shipped unaddressed, and how long it has been waiting, for the
// repository the list is filtered to. Stays out of the way if it cannot load.
export function BacklogStatsStrip({ repoId }: { repoId?: string }) {
  const { data, isPending, isError } = useBacklogStats(repoId)
  if (isError) return null
  if (isPending) return <Skeleton className="h-24 w-full" />

  return (
    <section aria-label="Backlog stats" className="grid gap-4 sm:grid-cols-2">
      <Stat label="Open items" icon={CircleDot}>
        {data.open}
        <div className="flex flex-wrap gap-2 pt-1 text-xs font-normal">
          {data.bySeverity.map(({ severity, count }) => (
            <span key={severity} className="inline-flex items-center gap-1">
              <SeverityBadge severity={severity} />
              <span className="tabular-nums">{count}</span>
            </span>
          ))}
        </div>
      </Stat>
      <Stat label="Waiting since first raised" icon={Hourglass}>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-0.5 pt-1 text-xs font-normal">
          {data.byAge.map(({ key, count }) => (
            <div key={key} className="flex justify-between gap-2">
              <dt className="text-muted-foreground">{AGE_LABEL[key]}</dt>
              <dd className="tabular-nums">{count}</dd>
            </div>
          ))}
        </dl>
      </Stat>
    </section>
  )
}
