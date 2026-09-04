import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { formatNaira, formatQuantity } from '../../format.js';
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
    low_stock: isLow(product),
    low_stock_threshold: product.lowStockThreshold,
  };
}

/** Find by normalized name, or create. Shared by add_stock and record_sale. */
async function findOrCreate(
  ctx: ToolContext,
  name: string,
  defaults: { unit?: string | null; lowStockThreshold?: number } = {},
): Promise<{ product: ProductRecord; created: boolean }> {
  const existing = await ctx.store.findProductByName(ctx.business.id, name);
  if (existing) return { product: existing, created: false };

  const product = await ctx.store.createProduct(ctx.business.id, {
    name,
    unit: defaults.unit ?? null,
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
    });

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
  paid: z
    .boolean()
    .optional()
    .describe(
      'True if the customer has already paid in full. Leave empty or false if it was on credit or you are unsure.',
    ),
});

export const recordSaleTool: ToolDefinition<z.infer<typeof recordSaleArgs>> = {
  name: 'record_sale',
  description:
    'Record a sale: log the money received and reduce the stock count. Use this whenever the owner says they sold something.',
  schema: recordSaleArgs,
  async execute(ctx, args) {
    const { product, created } = await findOrCreate(ctx, args.product);

    const customer = args.customer ? await findOrCreateCustomer(ctx, args.customer) : null;

    const amount = args.amount.toFixed(2);
    // One group per thing the owner said, so undoing reverses all of it.
    const groupId = randomUUID();
    const transaction = await ctx.store.createTransaction(ctx.business.id, {
      type: 'sale',
      amount,
      productRef: product.id,
      quantity: args.quantity,
      customerId: customer?.customer.id ?? null,
      groupId,
    });

    // A sale that was paid for immediately is logged as both the sale and the
    // payment, so it nets to zero owed rather than showing as a phantom debt.
    if (customer && args.paid) {
      await ctx.store.createTransaction(ctx.business.id, {
        type: 'payment',
        amount,
        customerId: customer.customer.id,
        groupId,
      });
    }

    const updated =
      (await ctx.store.adjustStock(ctx.business.id, product.id, -args.quantity)) ?? product;

    const unit = updated.unit ?? 'unit';
    const soldTo = customer ? ` to ${customer.customer.name}` : '';
    const parts = [
      `Sold ${formatQuantity(args.quantity, unit)} of ${updated.name}${soldTo} for ${formatNaira(args.amount)}.`,
    ];

    // A negative count means our number was stale, not that the sale did not
    // happen. Record the revenue and flag the count instead of refusing.
    if (updated.stockQty < 0) {
      parts.push(`Stock is now ${updated.stockQty}, so my count was off. Tell me the real number.`);
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
      paid: args.paid ?? false,
      stock_went_negative: updated.stockQty < 0,
      product_created: created,
      display: parts.join(' '),
    };
  },
};
