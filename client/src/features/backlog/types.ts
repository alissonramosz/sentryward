import type { Provider, Severity } from "@/features/reviews/types"
import type { FindingCategory, FindingKind } from "@/features/findings/types"

// Mirrors the server's backlog_items table (server/prisma/schema.prisma), as
// served by GET /api/backlog: findings still unaddressed when their change merged.

export type BacklogState = "open" | "resolved" | "dismissed"
// Why a merge resolved it: fixed (a later merged change rewrote its lines and
// its review did not report it again) or invalidated (its file was deleted or
// renamed, so it no longer applies).
export type BacklogResolution = "fixed" | "invalidated"
// Still open when its change merged, or ignored there as "fix later".
export type BacklogOrigin = "open" | "fix_later"
export type BacklogAge = "week" | "month" | "quarter" | "older"

export interface BacklogItem {
  id: string
  state: BacklogState
  resolution: BacklogResolution | null
  origin: BacklogOrigin
  title: string
  file: string
  startLine: number
  endLine: number | null
  severity: Severity
  category: FindingCategory
  kind: FindingKind
  baseBranch: string
  sourceNumber: number
  sourceChangeTitle: string
  author: string | null
  ignoreNote: string | null
  resolvedNumber: number | null
  resolvedJobId: string | null
  resolvedAt: string | null
  dismissedAt: string | null
  dismissNote: string | null
  firstSeenAt: string
  mergedAt: string
  lastSeenAt: string
  repository: { id: string; provider: Provider; host: string; fullPath: string }
}

export interface BacklogStats {
  open: number
  // Only severities with open items appear.
  bySeverity: { severity: Severity; count: number }[]
  // By when the finding was first raised, newest bucket first.
  byAge: { key: BacklogAge; count: number }[]
}

export type BacklogSortKey = "title" | "severity" | "repository" | "mergedAt" | "firstSeenAt"
