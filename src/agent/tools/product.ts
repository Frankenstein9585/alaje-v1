import { z } from 'zod';
import { formatNaira, formatQuantity } from '../../format.js';
import type { ProductPatch } from '../../store.js';
import type { ToolDefinition } from './registry.js';

/**
 * Changing details of a product that already exists.
 *
 * Replaces an earlier cost-only tool. Cost was never the only thing an owner
 * needs to correct after the fact: the unit gets guessed wrong, and a low stock
 * alert is usually something they think of later, once they have run out once.
 */

const updateProductArgs = z.object({
  product: z.string().min(1).max(160).describe('The product, exactly as the owner said it'),
  unit_cost: z
    .number()
    .positive()
    .max(1_000_000_000)
    .optional()
    .describe('What ONE unit costs the shop to buy, in naira. What they pay, not what they sell for'),
  unit: z
    .string()
    .min(1)
    .max(32)
    .optional()
    .describe('What the items are counted in, e.g. "carton", "bag", "crate"'),
  low_stock_alert: z
    .number()
    .int()
    .min(0)
    .max(1_000_000)
    .optional()
    .describe('Warn the owner when stock falls to this level or below. 0 turns the warning off'),
});

export const updateProductTool: ToolDefinition<z.infer<typeof updateProductArgs>> = {
  name: 'update_product',
  description:
    'Change details of a product the shop already has: what it costs to buy, what it is counted in, or when to warn about low stock. Use this for "indomie costs me 12k a carton", "they come in bags not cartons", or "tell me when indomie drops below 5". Not for recording new stock, that is add_stock.',
  schema: updateProductArgs,
  async execute(ctx, args) {
    const product = await ctx.store.findProductByName(ctx.business.id, args.product);
    if (!product) {
      return {
        ok: true,
        found: false,
        display: `No record of ${args.product} yet. Add some stock first and I'll track it.`,
      };
    }

    const patch: ProductPatch = {
      ...(args.unit_cost !== undefined ? { costPrice: args.unit_cost.toFixed(2) } : {}),
      ...(args.unit !== undefined ? { unit: args.unit } : {}),
      ...(args.low_stock_alert !== undefined ? { lowStockThreshold: args.low_stock_alert } : {}),
    };

    if (Object.keys(patch).length === 0) {
      return {
        ok: false,
        display: `What would you like to change about ${product.name}?`,
      };
    }

    const updated = (await ctx.store.updateProduct(ctx.business.id, product.id, patch)) ?? product;
    const unit = updated.unit ?? 'unit';

    // Say back only what changed, so the owner can see it took.
    const changed: string[] = [];
    if (args.unit_cost !== undefined) {
      changed.push(`costs you ${formatNaira(updated.costPrice ?? '0')} per ${unit}`);
    }
    if (args.unit !== undefined) changed.push(`counted in ${unit}s`);
    if (args.low_stock_alert !== undefined) {
      changed.push(
        args.low_stock_alert === 0
          ? 'no low stock warnings'
          : `warn at ${formatQuantity(args.low_stock_alert, unit)}`,
      );
    }

    return {
      ok: true,
      found: true,
      product: updated.name,
      unit_cost: updated.costPrice,
      unit: updated.unit,
      low_stock_threshold: updated.lowStockThreshold,
      display: `Noted. ${updated.name}: ${changed.join(', ')}.`,
    };
  },
};
