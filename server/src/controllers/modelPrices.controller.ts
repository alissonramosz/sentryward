import type { Request, Response } from "express";
import { HttpError } from "../lib/httpError.ts";
import { prisma } from "../lib/prisma.ts";
import { modelPriceIdParamSchema, modelPriceLookupSchema, saveModelPriceSchema } from "../schemas/modelPrices.schema.ts";
import { listModelPrices, lookupModelPrice } from "../services/modelPrices.ts";

export async function getModelPrices(req: Request, res: Response) {
  res.json(await listModelPrices(req.workspaceId!));
}

// For the settings page, which shows the price of whatever model is typed,
// used by a review yet or not.
export async function getModelPriceLookup(req: Request, res: Response) {
  const { model } = modelPriceLookupSchema.parse(req.query);
  res.json(await lookupModelPrice(req.workspaceId!, model));
}

// Keyed by model, so saving a model's price again replaces it.
export async function saveModelPrice(req: Request, res: Response) {
  const { model, ...rates } = saveModelPriceSchema.parse(req.body);
  const data = {
    input: rates.input,
    output: rates.output,
    cached: rates.cached ?? null,
    cacheWrite: rates.cacheWrite ?? null,
    reasoning: rates.reasoning ?? null,
  };
  const workspaceId = req.workspaceId!;
  await prisma.modelPrice.upsert({
    where: { workspaceId_model: { workspaceId, model } },
    create: { workspaceId, model, ...data },
    update: data,
  });
  res.json(await listModelPrices(workspaceId));
}

// Takes the workspace row lock saveBudget checks prices under, so a delete
// cannot land between that check and the budget being switched on. Saving a
// price needs no lock: a new price can only make the check pass.
export async function deleteModelPrice(req: Request, res: Response) {
  const { id } = modelPriceIdParamSchema.parse(req.params);
  const workspaceId = req.workspaceId!;
  const count = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM workspaces WHERE id = ${workspaceId}::uuid FOR NO KEY UPDATE`;
    const { count } = await tx.modelPrice.deleteMany({ where: { id, workspaceId } });
    return count;
  });
  if (!count) throw new HttpError(404, "Price not found");
  res.status(204).end();
}
