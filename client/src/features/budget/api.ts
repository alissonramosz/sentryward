import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { api } from "@/lib/api"

// Also invalidated by saving or removing a model price, which changes the
// models the budget card lists as unpriced.
export const BUDGET_KEY = ["budget"]

// The workspace's monthly budget and this UTC month's spend, summed the way
// the Usage page sums it.
export interface Budget {
  // Null is no budget.
  monthlyBudgetUsd: number | null
  // "2026-11"
  month: string
  spendUsd: number
  // Null with no budget.
  percent: number | null
  // Calls this month no price was known for; the spend leaves them out.
  unpricedCalls: number
  // Models recent reviews called that have no price. A budget cannot be
  // switched on while there are any.
  unpricedModels: string[]
  // Thresholds announced this month; 110 is the over-budget alert.
  alertsSent: { threshold: number; at: string }[]
  // Active workspace targets listening for budget alerts.
  budgetTargets: number
  // Whether owners and admins are mailed each alert too.
  adminEmail: boolean
}

export function useBudget() {
  return useQuery({ queryKey: BUDGET_KEY, queryFn: () => api<Budget>("/settings/budget") })
}

export function useSaveBudget() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (monthlyBudgetUsd: number | null) =>
      api<Budget>("/settings/budget", { method: "PUT", body: JSON.stringify({ monthlyBudgetUsd }) }),
    onSuccess: (data) => queryClient.setQueryData(BUDGET_KEY, data),
  })
}
