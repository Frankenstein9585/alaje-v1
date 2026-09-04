import { z } from 'zod';
import { formatNaira } from '../../format.js';
import { koboToDecimal, toKobo } from '../../money.js';
import { periodRange, type Period } from '../../period.js';
import type { ToolDefinition } from './registry.js';

/**
 * Reporting.
 *
 * Two rules the numbers depend on: voided rows never count (that is the whole
 * point of voiding), and periods are measured in Lagos time so the evening's
 * sales do not land in tomorrow's report.
 *
 * Payments are deliberately excluded from revenue. A payment is money arriving
 * against a sale that was already counted when it happened; counting both would
 * double the day.
 */

const runReportArgs = z.object({
  period: z
    .enum(['today', 'week', 'month'])
    .describe('today, week (the last 7 days) or month (this calendar month so far)'),
});

export const runReportTool: ToolDefinition<z.infer<typeof runReportArgs>> = {
  name: 'run_report',
  description:
    "Report revenue, expenses and profit for a period. Use this when the owner asks how business is going, what they made, or for today's, this week's or this month's numbers.",
  schema: runReportArgs,
  async execute(ctx, args) {
    const range = periodRange(args.period as Period);
    const rows = await ctx.store.transactionsBetween(ctx.business.id, range.from, range.to);

    let revenueKobo = 0;
    let expensesKobo = 0;
    let saleCount = 0;

    for (const row of rows) {
      if (row.type === 'sale') {
        revenueKobo += toKobo(row.amount);
        saleCount += 1;
      } else if (row.type === 'expense') {
        expensesKobo += toKobo(row.amount);
      }
      // Payments are money against an already-counted sale. Not revenue.
    }

    const profitKobo = revenueKobo - expensesKobo;
    const revenue = koboToDecimal(revenueKobo);
    const expenses = koboToDecimal(expensesKobo);
    const profit = koboToDecimal(profitKobo);

    if (saleCount === 0 && expensesKobo === 0) {
      return {
        ok: true,
        period: args.period,
        label: range.label,
        revenue,
        expenses,
        profit,
        sale_count: 0,
        display: `${range.label}: nothing recorded yet.`,
      };
    }

    const lines = [
      `${range.label}:`,
      `Sales: ${formatNaira(revenue)} from ${saleCount} ${saleCount === 1 ? 'sale' : 'sales'}`,
    ];
    if (expensesKobo > 0) {
      lines.push(`Expenses: ${formatNaira(expenses)}`);
      lines.push(`Profit: ${formatNaira(profit)}`);
    }

    return {
      ok: true,
      period: args.period,
      label: range.label,
      revenue,
      expenses,
      profit,
      sale_count: saleCount,
      display: lines.join('\n'),
    };
  },
};
