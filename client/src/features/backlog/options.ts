import type { BacklogAge, BacklogOrigin, BacklogResolution, BacklogState } from "./types"

export const BACKLOG_STATE_LABEL: Record<BacklogState, string> = {
  open: "Open",
  resolved: "Resolved",
  dismissed: "Dismissed",
}

export const RESOLUTION_LABEL: Record<BacklogResolution, string> = { fixed: "Fixed", invalidated: "Invalidated" }

export const ORIGIN_LABEL: Record<BacklogOrigin, string> = { open: "Open at merge", fix_later: "Fix later" }

export const AGE_LABEL: Record<BacklogAge, string> = {
  week: "Under a week",
  month: "Under a month",
  quarter: "Under 3 months",
  older: "Older",
}

// The age filter asks for items first raised more than this many days ago.
export const AGE_FILTER: { value: string; label: string; days: number }[] = [
  { value: "7", label: "Older than a week", days: 7 },
  { value: "30", label: "Older than a month", days: 30 },
  { value: "90", label: "Older than 3 months", days: 90 },
]

const options = <T extends string>(labels: Record<T, string>) =>
  (Object.keys(labels) as T[]).map((value) => ({ value, label: labels[value] }))

export const BACKLOG_STATE_OPTIONS = options(BACKLOG_STATE_LABEL)
export const ORIGIN_OPTIONS = options(ORIGIN_LABEL)
export const AGE_OPTIONS = AGE_FILTER.map(({ value, label }) => ({ value, label }))
