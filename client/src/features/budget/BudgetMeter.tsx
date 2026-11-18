import { Link } from "react-router"
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { cn } from "@/lib/utils"
import { formatUsd } from "@/features/usage/format"
import { useBudget, type Budget } from "./api"

// 90% and up is amber, past the budget red: the same points alerts go out at.
function tone(percent: number) {
  if (percent > 100) return "bg-destructive"
  if (percent >= 90) return "bg-amber-500"
  return "bg-primary"
}

// This month's spend against the budget. Only rendered with a budget set.
export function BudgetMeter({ budget, className }: { budget: Budget & { monthlyBudgetUsd: number }; className?: string }) {
  const percent = budget.percent ?? 0
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-sm">
        <span>
          <span className="font-medium tabular-nums">{formatUsd(budget.spendUsd)}</span>
          <span className="text-muted-foreground"> of {formatUsd(budget.monthlyBudgetUsd)} this month (UTC)</span>
        </span>
        <span className={cn("tabular-nums", percent > 100 ? "font-medium text-destructive" : "text-muted-foreground")}>
          {percent}%
        </span>
      </div>
      <div
        role="meter"
        aria-label="Spend this month"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.min(percent, 100)}
        aria-valuetext={`${percent}% of the monthly budget`}
        className="h-2 w-full overflow-hidden rounded-full bg-muted"
      >
        <div className={cn("h-full rounded-full transition-[width]", tone(percent))} style={{ width: `${Math.min(percent, 100)}%` }} />
      </div>
      {budget.unpricedCalls > 0 && (
        <p className="text-xs text-muted-foreground">
          {budget.unpricedCalls === 1 ? "1 model call" : `${budget.unpricedCalls} model calls`} this month had no price and{" "}
          {budget.unpricedCalls === 1 ? "is" : "are"} not counted.
        </p>
      )}
    </div>
  )
}

// The Usage page's view of the budget: whatever period the page shows, this is
// always the current UTC month. Nothing at all without a budget (or while it
// loads, or if it fails), so the page reads as before.
export function MonthBudget() {
  const { data } = useBudget()
  if (!data || data.monthlyBudgetUsd === null) return null
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Monthly budget</CardTitle>
        <CardAction>
          <Link to="/llm-connections?tab=prices" className="text-sm text-muted-foreground underline-offset-4 hover:underline">
            Budget settings
          </Link>
        </CardAction>
      </CardHeader>
      <CardContent>
        <BudgetMeter budget={{ ...data, monthlyBudgetUsd: data.monthlyBudgetUsd }} />
      </CardContent>
    </Card>
  )
}
