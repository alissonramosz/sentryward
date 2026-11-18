import { useState } from "react"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { AlertTriangle, BellOff, Loader2, Pencil, Plus } from "lucide-react"
import { Link } from "react-router"
import { toast } from "sonner"
import { z } from "zod"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Skeleton } from "@/components/ui/skeleton"
import { TextField } from "@/features/auth/TextField"
import { applyServerErrors } from "@/features/auth/applyServerErrors"
import { useAuth } from "@/features/auth/useAuth"
import { useBudget, useSaveBudget, type Budget } from "./api"
import { BudgetMeter } from "./BudgetMeter"

// The server's limit, checked here so the form says so before saving.
const MAX_BUDGET = 1_000_000

const budgetSchema = z.object({
  monthlyBudgetUsd: z
    .string()
    .trim()
    .refine((value) => value !== "", "Enter an amount")
    .refine((value) => Number.isFinite(Number(value)) && Number(value) > 0, "Enter an amount above 0")
    .refine((value) => Number(value) <= MAX_BUDGET, "Enter at most 1,000,000"),
})
type BudgetForm = z.infer<typeof budgetSchema>

function thresholdLabel(threshold: number) {
  return threshold > 100 ? "Over budget" : `${threshold}%`
}

function BudgetDialog({ budget, open, onOpenChange }: { budget: Budget; open: boolean; onOpenChange: (open: boolean) => void }) {
  const save = useSaveBudget()
  const form = useForm<BudgetForm>({
    resolver: zodResolver(budgetSchema),
    values: { monthlyBudgetUsd: budget.monthlyBudgetUsd === null ? "" : String(budget.monthlyBudgetUsd) },
  })

  async function onSubmit(values: BudgetForm) {
    try {
      await save.mutateAsync(Number(values.monthlyBudgetUsd))
      toast.success("Saved the monthly budget")
      onOpenChange(false)
    } catch (error) {
      applyServerErrors(error, form.setError)
    }
  }

  async function onRemove() {
    try {
      await save.mutateAsync(null)
      toast.success("Removed the monthly budget")
      onOpenChange(false)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not remove the budget")
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Monthly budget</DialogTitle>
            <DialogDescription>
              USD per calendar month (UTC). Alerts go out at 50, 75, 90 and 100% and when spend passes 110%, each at
              most once a month. Reviews keep running whatever the spend.
            </DialogDescription>
          </DialogHeader>
          <TextField control={form.control} name="monthlyBudgetUsd" label="Budget (USD)" inputMode="decimal" autoComplete="off" />
          <DialogFooter>
            {budget.monthlyBudgetUsd !== null && (
              <Button type="button" variant="outline" className="sm:mr-auto" onClick={onRemove} disabled={save.isPending}>
                Remove budget
              </Button>
            )}
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={form.formState.isSubmitting}>
              {form.formState.isSubmitting && <Loader2 className="animate-spin" />}
              Save budget
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function hasBudget(budget: Budget): budget is Budget & { monthlyBudgetUsd: number } {
  return budget.monthlyBudgetUsd !== null
}

// The workspace's monthly budget: this month's spend against it, the alerts
// sent, and what keeps alerts from being complete or heard. Members see it;
// admins change it. It notifies only: reviews never stop over it.
export function BudgetCard() {
  const { workspace } = useAuth()
  const canManage = workspace?.role === "owner" || workspace?.role === "admin"
  const { data, isPending, isError } = useBudget()
  const [editing, setEditing] = useState(false)

  return (
    <Card>
      <CardHeader>
        <CardTitle>Monthly budget</CardTitle>
        <CardDescription>
          Alerts when this month's estimated review spend reaches 50, 75, 90 and 100% of the budget, and when it goes
          over. Only notifies: reviews never stop.
        </CardDescription>
        {canManage && data && (
          <CardAction>
            <Button size="sm" variant={hasBudget(data) ? "outline" : "default"} onClick={() => setEditing(true)}>
              {hasBudget(data) ? <Pencil /> : <Plus />}
              {hasBudget(data) ? "Edit budget" : "Set budget"}
            </Button>
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {isPending ? (
          <Skeleton className="h-16 w-full" />
        ) : isError ? (
          <Alert variant="destructive">
            <AlertTriangle />
            <AlertTitle>Could not load the budget.</AlertTitle>
          </Alert>
        ) : (
          <>
            {hasBudget(data) ? (
              <>
                <BudgetMeter budget={data} />
                {data.alertsSent.length > 0 && (
                  <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                    <span>Alerts sent in {data.month}:</span>
                    {data.alertsSent.map((alert) => (
                      <Badge key={alert.threshold} variant={alert.threshold > 100 ? "destructive" : "outline"}>
                        {thresholdLabel(alert.threshold)}
                      </Badge>
                    ))}
                  </div>
                )}
                {data.budgetTargets === 0 && (
                  <Alert>
                    <BellOff />
                    <AlertTitle>No notification target listens for budget alerts</AlertTitle>
                    <AlertDescription>
                      {data.adminEmail
                        ? "Owners and admins are emailed each alert. "
                        : "Mail is not set up either, so alerts reach nobody. "}
                      <Link to="/notifications" className="underline underline-offset-4">
                        Add the Budget event to a target
                      </Link>
                      .
                    </AlertDescription>
                  </Alert>
                )}
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                No budget set.{" "}
                {canManage ? "Set one to be alerted as the month's spend grows." : "An admin can set one."}
              </p>
            )}
            {data.unpricedModels.length > 0 && (
              <Alert>
                <AlertTriangle />
                <AlertTitle>
                  {data.unpricedModels.length === 1 ? "1 model" : `${data.unpricedModels.length} models`} used recently{" "}
                  {data.unpricedModels.length === 1 ? "has" : "have"} no price
                </AlertTitle>
                <AlertDescription>
                  <span>
                    Their calls add nothing to the spend
                    {hasBudget(data)
                      ? ", so alerts may come late."
                      : ". Price them in the table below before a budget can be set."}
                  </span>
                  <span className="flex flex-wrap gap-2 pt-1">
                    {data.unpricedModels.map((model) => (
                      <Badge key={model} variant="outline" className="font-mono">
                        {model}
                      </Badge>
                    ))}
                  </span>
                </AlertDescription>
              </Alert>
            )}
          </>
        )}
      </CardContent>
      {data && canManage && <BudgetDialog budget={data} open={editing} onOpenChange={setEditing} />}
    </Card>
  )
}
