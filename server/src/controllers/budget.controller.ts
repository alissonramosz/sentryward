import type { Request, Response } from "express";
import { HttpError } from "../lib/httpError.ts";
import { prisma } from "../lib/prisma.ts";
import { saveBudgetSchema } from "../schemas/budget.schema.ts";
import { budgetStatus, unpricedModels } from "../services/budget.ts";

export async function getBudget(req: Request, res: Response) {
  res.json(await budgetStatus(req.workspaceId!));
}

// Switching a budget on needs a price for every model recent reviews called:
// an unpriced call adds nothing to the spend, so alerts would come late or not
// at all. Changing an existing budget is not held up, since alerts are already
// running and the card warns about the calls left out.
export async function saveBudget(req: Request, res: Response) {
  const { monthlyBudgetUsd } = saveBudgetSchema.parse(req.body);
  const workspaceId = req.workspaceId!;
  if (monthlyBudgetUsd !== null) {
    const current = await prisma.workspace.findUniqueOrThrow({
      where: { id: workspaceId },
      select: { monthlyBudgetUsd: true },
    });
    if (current.monthlyBudgetUsd === null) {
      const missing = await unpricedModels(workspaceId);
      if (missing.length) {
        const message = `Set a price for ${missing.join(", ")} under Model prices first`;
        throw new HttpError(400, message, { monthlyBudgetUsd: [message] });
      }
    }
  }
  await prisma.workspace.update({ where: { id: workspaceId }, data: { monthlyBudgetUsd } });
  res.json(await budgetStatus(workspaceId));
}
