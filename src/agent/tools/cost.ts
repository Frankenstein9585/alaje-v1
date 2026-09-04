import { z } from 'zod';
import { formatNaira } from '../../format.js';
import type { ToolDefinition } from './registry.js';

/**
 * Recording what stock costs the shop.
 *
 * Without a cost price we can report revenue but not profit, and profit is the
 * number an owner actually cares about. `add_stock` takes a unit cost when the
 * owner mentions one while restocking; this tool exists for the other path,
 * where a report has just told them the cost is missing and they answer.
 */

const setCostArgs = z.object({
  product: z.string().min(1).max(160).describe('The product, exactly as the owner said it'),
  unit_cost: z
    .number()
    .positive()
    .max(1_000_000_000)
    .describe('What ONE unit costs the shop to buy, in naira'),
});

export const setCostPriceTool: ToolDefinition<z.infer<typeof setCostArgs>> = {
  name: 'set_cost_price',
  description:
    'Record what one unit of a product costs the shop to buy. Use this when the owner says what they pay for something, for example "indomie costs me 12k a carton". This is what they pay, not what they sell it for.',
  schema: setCostArgs,
  async execute(ctx, args) {
    const product = await ctx.store.findProductByName(ctx.business.id, args.product);
    if (!product) {
      return {
        ok: true,
        found: false,
        display: `No record of ${args.product} yet. Add some stock first and I'll track what it costs.`,
      };
    }

    const costPrice = args.unit_cost.toFixed(2);
    await ctx.store.setProductCost(ctx.business.id, product.id, costPrice);

    return {
      ok: true,
      found: true,
      product: product.name,
      unit_cost: costPrice,
      // Only sales from here on carry this cost; past sales keep what they
      // were sold at, so say so rather than implying the books changed.
      display: `Noted: ${product.name} costs you ${formatNaira(costPrice)} per ${product.unit ?? 'unit'}. I'll use that for profit from now on.`,
    };
  },
};
