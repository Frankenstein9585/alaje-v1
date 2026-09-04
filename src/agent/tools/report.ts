import { z } from 'zod';
import { formatNaira } from '../../format.js';
import { koboToDecimal, toKobo } from '../../money.js';
import { periodRange, type Period } from '../../period.js';
import type { ToolDefinition } from './registry.js';

/**
 * Reporting.
 *
 * Rules the numbers depend on: voided rows never count (that is the whole point
 * of voiding), and periods are measured in Lagos time so the evening's sales do
 * not land in tomorrow's report.
 *
 * Payments are deliberately excluded from revenue. A payment is money arriving
 * against a sale that was already counted when it happened; counting both would
 * double the day.
 *
 * Profit is only reported when the cost of every sale in the period is known.
 * A partial profit figure looks authoritative and is wrong, and this is exactly
 * the sort of number an owner would take to a bank.
 */

const runReportArgs = z.object({
  period: z
    .enum(['today', 'week', 'month'])
    .describe('today, week (the last 7 days) or month (this calendar month so far)'),
});

export const runReportTool: ToolDefinition<z.infer<typeof runReportArgs>> = {
  name: 'run_report',
  description:
    "Report revenue, cost, expenses and profit for a period. Use this when the owner asks how business is going, what they made, or for today's, this week's or this month's numbers.",
  schema: runReportArgs,
  async execute(ctx, args) {
    const range = periodRange(args.period as Period);
    const rows = await ctx.store.transactionsBetween(ctx.business.id, range.from, range.to);

    let revenueKobo = 0;
    let expensesKobo = 0;
    let costKobo = 0;
    let saleCount = 0;
    const missingCost = new Set<string>();

    for (const row of rows) {
      if (row.type === 'sale') {
        revenueKobo += toKobo(row.amount);
        saleCount += 1;
        if (row.costAmount === null) {
          missingCost.add(row.productRef ?? 'unknown');
        } else {
          costKobo += toKobo(row.costAmount);
        }
      } else if (row.type === 'expense') {
        expensesKobo += toKobo(row.amount);
      }
      // Payments are money against an already-counted sale. Not revenue.
    }

    const revenue = koboToDecimal(revenueKobo);
    const expenses = koboToDecimal(expensesKobo);
    const cost = koboToDecimal(costKobo);
    const knowsEveryCost = missingCost.size === 0;
    const profit = knowsEveryCost ? koboToDecimal(revenueKobo - costKobo - expensesKobo) : null;

    if (saleCount === 0 && expensesKobo === 0) {
      return {
        ok: true,
        period: args.period,
        label: range.label,
        revenue,
        expenses,
        cost_of_goods: cost,
        profit,
        sale_count: 0,
        display: `${range.label}: nothing recorded yet.`,
      };
    }

    const lines = [
      `${range.label}:`,
      `Sales: ${formatNaira(revenue)} from ${saleCount} ${saleCount === 1 ? 'sale' : 'sales'}`,
    ];
    if (costKobo > 0) lines.push(`Cost of goods: ${formatNaira(cost)}`);
    if (expensesKobo > 0) lines.push(`Expenses: ${formatNaira(expenses)}`);

    if (profit !== null) {
      lines.push(`Profit: ${formatNaira(profit)}`);
    } else {
      // Name the gap and how to close it, rather than quoting a number that
      // only counts some of the costs.
      const names = await namesFor(ctx, missingCost);
      const which = names.length > 0 ? ` for ${names.join(', ')}` : '';
      lines.push(
        `I can't work out profit yet — I don't know what you paid${which}. Tell me and I'll include it.`,
      );
    }

    return {
      ok: true,
      period: args.period,
      label: range.label,
      revenue,
      expenses,
      cost_of_goods: cost,
      profit,
      sale_count: saleCount,
      products_missing_cost: missingCost.size,
      display: lines.join('\n'),
    };
  },
};

async function namesFor(
  ctx: Parameters<typeof runReportTool.execute>[0],
  productIds: Set<string>,
): Promise<string[]> {
  const products = await ctx.store.listProducts(ctx.business.id);
  return products.filter((p) => productIds.has(p.id)).map((p) => p.name);
}
