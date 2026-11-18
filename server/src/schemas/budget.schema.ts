import { z } from "zod";
import { MAX_MONTHLY_BUDGET_USD } from "../services/budget.ts";

// USD per UTC calendar month; null switches the budget off.
export const saveBudgetSchema = z.object({
  monthlyBudgetUsd: z
    .number({ error: "Enter an amount in USD" })
    .positive("Enter an amount above 0")
    .max(MAX_MONTHLY_BUDGET_USD, `Enter at most ${MAX_MONTHLY_BUDGET_USD.toLocaleString("en-US")}`)
    .nullable(),
});
