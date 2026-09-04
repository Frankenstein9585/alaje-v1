import { z } from 'zod';
import { formatNaira } from '../../format.js';
import { toKobo } from '../../money.js';
import type { CustomerRecord } from '../../store.js';
import type { ToolContext, ToolDefinition } from './registry.js';

/**
 * Customer and debt tools.
 *
 * Balances are always computed from transactions, never stored. A running
 * balance column and a voided transaction drift apart the moment anyone
 * corrects anything, and a debt figure nobody trusts is worse than none.
 */

const customerName = z
  .string()
  .min(1)
  .max(160)
  .describe('The customer name exactly as the owner said it, e.g. "Chika"');

/** Find by normalized name, or create. Customers appear on first mention. */
export async function findOrCreateCustomer(
  ctx: ToolContext,
  name: string,
): Promise<{ customer: CustomerRecord; created: boolean }> {
  const existing = await ctx.store.findCustomerByName(ctx.business.id, name);
  if (existing) return { customer: existing, created: false };
  return { customer: await ctx.store.createCustomer(ctx.business.id, name), created: true };
}

/** Positive means they owe; negative means they have paid ahead. */
export function describeBalance(name: string, balance: string): string {
  const kobo = toKobo(balance);
  if (kobo === 0) return `${name} is settled up.`;
  if (kobo > 0) return `${name} owes ${formatNaira(balance)}.`;
  return `${name} is ${formatNaira(String(Math.abs(kobo) / 100))} in credit.`;
}

const recordPaymentArgs = z.object({
  customer: customerName,
  amount: z
    .number()
    .positive()
    .max(1_000_000_000)
    .describe('Amount received in naira. "42k" means 42000'),
});

export const recordPaymentTool: ToolDefinition<z.infer<typeof recordPaymentArgs>> = {
  name: 'record_payment',
  description:
    'Record money received from a customer against what they owe. Use this when the owner says a customer paid, or forwards a bank credit alert naming the sender.',
  schema: recordPaymentArgs,
  async execute(ctx, args) {
    const { customer, created } = await findOrCreateCustomer(ctx, args.customer);

    await ctx.store.createTransaction(ctx.business.id, {
      type: 'payment',
      amount: args.amount.toFixed(2),
      customerId: customer.id,
    });

    const balance = await ctx.store.customerBalance(ctx.business.id, customer.id);

    return {
      ok: true,
      customer: customer.name,
      customer_created: created,
      amount_display: formatNaira(args.amount),
      balance,
      display: `Received ${formatNaira(args.amount)} from ${customer.name}. ${describeBalance(customer.name, balance)}`,
    };
  },
};

const checkBalanceArgs = z.object({
  customer: customerName
    .optional()
    .describe('Leave empty to list everyone who currently owes money'),
});

export const checkBalanceTool: ToolDefinition<z.infer<typeof checkBalanceArgs>> = {
  name: 'check_balance',
  description:
    'Look up what one customer owes, or list everyone who owes money if no customer is named.',
  schema: checkBalanceArgs,
  async execute(ctx, args) {
    if (args.customer) {
      const customer = await ctx.store.findCustomerByName(ctx.business.id, args.customer);
      if (!customer) {
        // Never seen them. Not a failure, just nothing to report.
        return {
          ok: true,
          found: false,
          display: `No record of ${args.customer} yet.`,
        };
      }
      const balance = await ctx.store.customerBalance(ctx.business.id, customer.id);
      return {
        ok: true,
        found: true,
        customer: customer.name,
        balance,
        display: describeBalance(customer.name, balance),
      };
    }

    const owing = await ctx.store.outstandingBalances(ctx.business.id);
    const debtors = owing.filter((row) => toKobo(row.balance) > 0);

    if (debtors.length === 0) {
      return { ok: true, debtors: [], display: 'Nobody owes you anything right now.' };
    }

    return {
      ok: true,
      debtors: debtors.map((row) => ({ customer: row.customer.name, balance: row.balance })),
      total_owed: debtors.reduce((sum, row) => sum + toKobo(row.balance), 0) / 100,
      display: debtors
        .map((row) => `${row.customer.name}: ${formatNaira(row.balance)}`)
        .join('\n'),
    };
  },
};
