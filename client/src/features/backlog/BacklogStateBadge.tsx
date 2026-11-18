import { Badge } from "@/components/ui/badge"
import { BACKLOG_STATE_LABEL, RESOLUTION_LABEL } from "./options"
import type { BacklogItem } from "./types"

// Same palette as the findings StateBadge: open needs attention, the rest are settled.
const STATE_CLASS: Record<BacklogItem["state"], string> = {
  open: "border-amber-600/40 text-amber-700 dark:text-amber-400",
  resolved: "border-emerald-600/40 text-emerald-700 dark:text-emerald-400",
  dismissed: "border-dashed text-muted-foreground",
}

// A resolved item says how: fixed by later work, or no longer applying.
export function BacklogStateBadge({ item }: { item: Pick<BacklogItem, "state" | "resolution"> }) {
  const label =
    item.state === "resolved" && item.resolution ? RESOLUTION_LABEL[item.resolution] : BACKLOG_STATE_LABEL[item.state]
  return (
    <Badge variant="outline" className={STATE_CLASS[item.state]}>
      <span className="size-1.5 rounded-full bg-current" aria-hidden />
      {label}
    </Badge>
  )
}
