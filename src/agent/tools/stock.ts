import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { formatNaira, formatQuantity } from '../../format.js';
import { koboToDecimal, toKobo } from '../../money.js';
import type { ProductRecord } from '../../store.js';
import { describeBalance, findOrCreateCustomer } from './customers.js';
import type { ToolContext, ToolDefinition } from './registry.js';

/**
 * Stock tools.
 *
 * Every result carries a `display` string built here rather than left to the
 * model. The confirmation echo is how the owner catches a misparse, so its
 * formatting is correctness, not decoration.
 */

const productName = z
  .string()
  .min(1)
  .max(160)
  .describe('The product name exactly as the owner said it, e.g. "Indomie"');

const quantity = z
  .number()
  .int()
  .positive()
  .max(1_000_000)
  .describe('A whole number of units');

function stockDisplay(product: ProductRecord): string {
  return formatQuantity(product.stockQty, product.unit ?? 'unit');
}

function isLow(product: ProductRecord): boolean {
  // A threshold of 0 means the owner never set one, so nothing is "low".
  return product.lowStockThreshold > 0 && product.stockQty <= product.lowStockThreshold;
}

function summarize(product: ProductRecord) {
  return {
    name: product.name,
    stock: product.stockQty,
    stock_display: stockDisplay(product),
    unit: product.unit,
    unit_cost: product.costPrice,
    low_stock: isLow(product),
    low_stock_threshold: product.lowStockThreshold,
  };
}

/** Find by normalized name, or create. Shared by add_stock and record_sale. */
async function findOrCreate(
  ctx: ToolContext,
  name: string,
  defaults: { unit?: string | null; lowStockThreshold?: number; costPrice?: string | null } = {},
): Promise<{ product: ProductRecord; created: boolean }> {
  const existing = await ctx.store.findProductByName(ctx.business.id, name);
  if (existing) return { product: existing, created: false };

  const product = await ctx.store.createProduct(ctx.business.id, {
    name,
    unit: defaults.unit ?? null,
    costPrice: defaults.costPrice ?? null,
    stockQty: 0,
    lowStockThreshold: defaults.lowStockThreshold ?? 0,
  });
  return { product, created: true };
}

const addStockArgs = z.object({
  product: productName,
  quantity,
  unit: z
    .string()
    .min(1)
    .max(32)
    .optional()
    .describe('What the items are counted in, e.g. "carton", "bag", "crate"'),
  low_stock_threshold: z
    .number()
    .int()
    .min(0)
    .max(1_000_000)
    .optional()
    .describe('Warn the owner when stock falls to this level or below'),
  unit_cost: z
    .number()
    .positive()
    .max(1_000_000_000)
    .optional()
    .describe('What ONE unit cost the shop to buy, in naira. Only if the owner says.'),
});

export const addStockTool: ToolDefinition<z.infer<typeof addStockArgs>> = {
  name: 'add_stock',
  description:
    'Add stock for a product the owner has bought or received. Creates the product if it is new. Use this for restocking, not for recording what it cost.',
  schema: addStockArgs,
  async execute(ctx, args) {
    const { product, created } = await findOrCreate(ctx, args.product, {
      unit: args.unit ?? null,
      lowStockThreshold: args.low_stock_threshold ?? 0,
      costPrice: args.unit_cost === undefined ? null : args.unit_cost.toFixed(2),
    });

    // Details given while restocking apply to the existing row too. Previously
    // only cost updated, so "warn me when Indomie drops below 5" on a product
    // that already existed silently did nothing.
    //
    // Restocking at a new price changes the cost going forward only; sales
    // already recorded keep the cost they were sold at.
    if (!created) {
      await ctx.store.updateProduct(ctx.business.id, product.id, {
        ...(args.unit !== undefined ? { unit: args.unit } : {}),
        ...(args.low_stock_threshold !== undefined
          ? { lowStockThreshold: args.low_stock_threshold }
          : {}),
        ...(args.unit_cost !== undefined ? { costPrice: args.unit_cost.toFixed(2) } : {}),
      });
    }

    const updated = (await ctx.store.adjustStock(ctx.business.id, product.id, args.quantity)) ?? product;

    const unit = args.unit ?? updated.unit ?? 'unit';
    return {
      ok: true,
      created,
      product: summarize(updated),
      added_display: formatQuantity(args.quantity, unit),
      display: `Added ${formatQuantity(args.quantity, unit)} of ${updated.name}. Now ${stockDisplay(updated)} in stock.`,
    };
  },
};

const checkStockArgs = z.object({
  product: productName.optional().describe('Leave empty to list everything in stock'),
});

export const checkStockTool: ToolDefinition<z.infer<typeof checkStockArgs>> = {
  name: 'check_stock',
  description:
    'Look up how much of a product is left, or list all products and their stock levels if no product is named.',
  schema: checkStockArgs,
  async execute(ctx, args) {
    if (args.product) {
      const product = await ctx.store.findProductByName(ctx.business.id, args.product);
      if (!product) {
        // Not an error: the owner asked about something we have never seen.
        // Say so plainly rather than reporting a failure.
        return {
          ok: true,
          found: false,
          display: `No record of ${args.product} yet.`,
        };
      }
      return {
        ok: true,
        found: true,
        product: summarize(product),
        display: `${product.name}: ${stockDisplay(product)} left.`,
      };
    }

    const all = await ctx.store.listProducts(ctx.business.id);
    if (all.length === 0) {
      return { ok: true, products: [], display: 'Nothing in stock yet.' };
    }

    return {
      ok: true,
      products: all.map(summarize),
      display: all.map((p) => `${p.name}: ${stockDisplay(p)}`).join('\n'),
    };
  },
};

const recordSaleArgs = z.object({
  product: productName,
  quantity,
  amount: z
    .number()
    .positive()
    .max(1_000_000_000)
    .describe('Total amount of the sale in naira. "42k" means 42000'),
  customer: z
    .string()
    .min(1)
    .max(160)
    .optional()
    .describe('Who bought it, if the owner named them. Always pass this along when they do.'),
});

/*
 * There is deliberately no "paid" flag.
 *
 * It existed, and a live model set it to true on "sold 3 to chika for 42k" —
 * a message that says nothing about payment — inventing a ₦42,000 payment that
 * never happened and leaving the customer's balance wrong in the direction that
 * loses the shop money. A boolean the model can reach for is a boolean it will
 * reach for. Money arriving is its own event, with its own tool, its own audit
 * row and its own undo.
 */

export const recordSaleTool: ToolDefinition<z.infer<typeof recordSaleArgs>> = {
  name: 'record_sale',
  description:
    'Record a sale: log the money received and reduce the stock count. Use this whenever the owner says they sold something.',
  schema: recordSaleArgs,
  async execute(ctx, args) {
    const existing = await ctx.store.findProductByName(ctx.business.id, args.product);

    // Selling something with no stock behind it produces a negative count and
    // a confusing reply. Ask for the stock first: it is one message, and it
    // keeps the books honest instead of quietly going below zero.
    if (!existing) {
      return {
        ok: true,
        recorded: false,
        reason: 'unknown_product',
        display: `I don't have ${args.product} on your list yet. Tell me how many you have and I'll record the sale after that.`,
      };
    }
    if (existing.stockQty <= 0) {
      return {
        ok: true,
        recorded: false,
        reason: 'out_of_stock',
        product: summarize(existing),
        display: `My count says you have no ${existing.name} left. Add what you restocked and I'll record this sale.`,
      };
    }

    const product = existing;
    const created = false;

    const customer = args.customer ? await findOrCreateCustomer(ctx, args.customer) : null;

    const amount = args.amount.toFixed(2);
    // Snapshot the cost of goods now. Reading it back from the product at
    // report time would let a later restock rewrite past profit.
    const costAmount =
      product.costPrice === null ? null : koboToDecimal(toKobo(product.costPrice) * args.quantity);
    // One group per thing the owner said, so undoing reverses all of it.
    const groupId = randomUUID();
    const transaction = await ctx.store.createTransaction(ctx.business.id, {
      type: 'sale',
      amount,
      productRef: product.id,
      quantity: args.quantity,
      customerId: customer?.customer.id ?? null,
      costAmount,
      groupId,
    });

    const updated =
      (await ctx.store.adjustStock(ctx.business.id, product.id, -args.quantity)) ?? product;

    const unit = updated.unit ?? 'unit';
    const soldTo = customer ? ` to ${customer.customer.name}` : '';
    const parts = [
      `Sold ${formatQuantity(args.quantity, unit)} of ${updated.name}${soldTo} for ${formatNaira(args.amount)}.`,
    ];

    // Stock existed but did not cover the whole sale. The shop clearly had the
    // goods, so the count was stale rather than the sale imaginary. Record it
    // and say the count needs fixing.
    if (updated.stockQty < 0) {
      parts.push(`That takes you to ${updated.stockQty}, so my count was off. What's the real number?`);
    } else {
      parts.push(`${stockDisplay(updated)} left.`);
      if (isLow(updated)) {
        // Inline, in the same reply. Never a follow-up message.
        parts.push(`That's low.`);
      }
    }

    // What they owe now, so the owner never has to ask a second question.
    let balance: string | null = null;
    if (customer) {
      balance = await ctx.store.customerBalance(ctx.business.id, customer.customer.id);
      parts.push(describeBalance(customer.customer.name, balance));
    }

    if (created) {
      parts.push(`I hadn't seen ${updated.name} before, so I started tracking it.`);
    }

    return {
      ok: true,
      transaction_id: transaction.id,
      amount_display: formatNaira(args.amount),
      product: summarize(updated),
      customer: customer?.customer.name ?? null,
      customer_balance: balance,
      stock_went_negative: updated.stockQty < 0,
      product_created: created,
      display: parts.join(' '),
    };
  },
};
