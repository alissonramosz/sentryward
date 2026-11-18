import type { Request, Response } from "express";
import { HttpError } from "../lib/httpError.ts";
import { prisma } from "../lib/prisma.ts";
import { saveBudgetSchema } from "../schemas/budget.schema.ts";
import { budgetStatus, resetUncrossedAlerts, unpricedModels } from "../services/budget.ts";

export async function getBudget(req: Request, res: Response) {
  res.json(await budgetStatus(req.workspaceId!));
}

// Switching a budget on needs a price for every model recent reviews called:
// an unpriced call adds nothing to the spend, so alerts would come late or not
// at all. Changing an existing budget is not held up, since alerts are already
// running and the card warns about the calls left out. The check and the save
// run under the workspace row lock that deleteModelPrice also takes, so a price
// deleted in between cannot slip past the check.
export async function saveBudget(req: Request, res: Response) {
  const { monthlyBudgetUsd } = saveBudgetSchema.parse(req.body);
  const workspaceId = req.workspaceId!;
  const now = new Date();
  const unpriced = await prisma.$transaction(async (tx) => {
    const [current] = await tx.$queryRaw<{ monthly_budget_usd: number | null }[]>`
      SELECT monthly_budget_usd FROM workspaces
      WHERE id = ${workspaceId}::uuid
      FOR NO KEY UPDATE
    `;
    if (!current) throw new HttpError(404, "Workspace not found");
    let unpriced: string[] | undefined;
    if (monthlyBudgetUsd !== null && current.monthly_budget_usd === null) {
      unpriced = await unpricedModels(workspaceId, now, tx);
      if (unpriced.length) {
        const message = `Set a price for ${unpriced.join(", ")} under Model prices first`;
        throw new HttpError(400, message, { monthlyBudgetUsd: [message] });
      }
    }
    await tx.workspace.update({ where: { id: workspaceId }, data: { monthlyBudgetUsd } });
    // Clearing the budget keeps the month's alerts: setting it again re-arms
    // only what that budget has not reached.
    if (monthlyBudgetUsd !== null) await resetUncrossedAlerts(tx, workspaceId, monthlyBudgetUsd, now);
    return unpriced;
  });
  res.json(await budgetStatus(workspaceId, now, unpriced));
}
