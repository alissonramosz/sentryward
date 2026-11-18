import type { Prisma } from "../generated/prisma/client.ts";
import { prisma } from "../lib/prisma.ts";
import { priceFor, type ModelPrice, type PriceOverrides } from "../review/core/pricing/pricing.ts";

// How far back the price list looks for models the workspace has used.
const RECENT_DAYS = 90;

const PRICE_FIELDS = { id: true, model: true, input: true, output: true, cached: true, cacheWrite: true, reasoning: true, updatedAt: true } as const;

function asPrice(row: { input: number; output: number; cached: number | null; cacheWrite: number | null; reasoning: number | null }): ModelPrice {
  return {
    input: row.input,
    output: row.output,
    ...(row.cached === null ? {} : { cached: row.cached }),
    ...(row.cacheWrite === null ? {} : { cacheWrite: row.cacheWrite }),
    ...(row.reasoning === null ? {} : { reasoning: row.reasoning }),
  };
}

export async function priceOverridesFor(workspaceId: string): Promise<PriceOverrides> {
  const rows = await prisma.modelPrice.findMany({ where: { workspaceId }, select: PRICE_FIELDS });
  return Object.fromEntries(rows.map((row) => [row.model, asPrice(row)]));
}

// The models the workspace's reviews of the last RECENT_DAYS called, sorted.
// Read in Postgres so a check reads one short list, not every review's
// digest: the budget card asks on each view. Keep it in step with
// digestModels (usage.ts): a model counts once it used tokens (usedTokens).
export async function recentModels(
  workspaceId: string,
  now = new Date(),
  db: Prisma.TransactionClient = prisma,
): Promise<string[]> {
  const rows = await db.$queryRaw<{ model: string }[]>`
    SELECT DISTINCT u.key AS model
    FROM review_jobs j
    JOIN repositories r ON r.id = j.repository_id
    JOIN forge_connections c ON c.id = r.connection_id
    CROSS JOIN LATERAL jsonb_each(
      CASE WHEN jsonb_typeof(j.summary->'usageByModel') = 'object'
           THEN j.summary->'usageByModel' ELSE '{}'::jsonb END
    ) u
    WHERE c.workspace_id = ${workspaceId}::uuid
      AND j.created_at >= ${new Date(now.getTime() - RECENT_DAYS * 86_400_000)}
      AND j.status::text NOT IN ('superseded', 'skipped', 'cancelled')
      AND (COALESCE((u.value->>'inputTokens')::numeric, 0) > 0
           OR COALESCE((u.value->>'outputTokens')::numeric, 0) > 0)
  `;
  // Sorted here rather than in SQL so the order is JavaScript's, as before.
  return rows.map((row) => row.model).sort();
}

// The workspace's prices, and the models its recent reviews called with the
// price each would get without one and the one reviews get now (null:
// unknown), so an admin can see which models still need a price. The current
// price goes through priceFor, so a price saved under a shorter id counts.
export async function listModelPrices(workspaceId: string, now = new Date(), db: Prisma.TransactionClient = prisma) {
  const [prices, used] = await Promise.all([
    db.modelPrice.findMany({ where: { workspaceId }, select: PRICE_FIELDS, orderBy: { model: "asc" } }),
    recentModels(workspaceId, now, db),
  ]);
  const overrides: PriceOverrides = Object.fromEntries(prices.map((row) => [row.model, asPrice(row)]));
  return {
    prices: prices.map(({ input, output, cached, cacheWrite, reasoning, ...rest }) => ({
      ...rest,
      price: asPrice({ input, output, cached, cacheWrite, reasoning }),
    })),
    models: used.map((model) => ({ model, builtIn: priceFor(model), price: priceFor(model, overrides) })),
  };
}

// The price a review of one model would be charged at now (null: unknown),
// and the built-in one it gets without a workspace price.
export async function lookupModelPrice(workspaceId: string, model: string) {
  const overrides = await priceOverridesFor(workspaceId);
  return { model, price: priceFor(model, overrides), builtIn: priceFor(model) };
}
