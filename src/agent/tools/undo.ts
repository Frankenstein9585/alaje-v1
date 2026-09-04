import { z } from 'zod';
import { formatNaira, formatQuantity } from '../../format.js';
import type { TransactionRecord } from '../../store.js';
import type { ToolDefinition } from './registry.js';

/**
 * Undo the last entry.
 *
 * This exists because re-recording a corrected amount double counts: log
 * ₦42,000 when you meant ₦4,200, then log the right one, and the day is
 * overstated by ₦42,000 with stock decremented twice. Voiding is the only
 * correction that actually corrects.
 */

const undoLastArgs = z.object({});

export const undoLastTool: ToolDefinition<z.infer<typeof undoLastArgs>> = {
  name: 'undo_last',
  description:
    'Reverse the most recent thing that was recorded, when the owner says it was wrong or asks to undo it. Restores any stock that was deducted.',
  schema: undoLastArgs,
  async execute(ctx) {
    const voided = await ctx.store.voidLastEntry(ctx.business.id);
    if (voided.length === 0) {
      return { ok: true, undone: false, display: "There's nothing to undo yet." };
    }

    // Put back any stock the voided sale took out.
    const restored: string[] = [];
    for (const row of voided) {
      if (row.type !== 'sale' || !row.productRef || !row.quantity) continue;
      const product = await ctx.store.adjustStock(
        ctx.business.id,
        row.productRef,
        row.quantity,
      );
      if (product) {
        restored.push(
          `${formatQuantity(row.quantity, product.unit ?? 'unit')} of ${product.name} back in stock`,
        );
      }
    }

    const headline = describe(voided);
    return {
      ok: true,
      undone: true,
      voided_ids: voided.map((v) => v.id),
      display: restored.length > 0 ? `${headline} ${restored.join(', ')}.` : headline,
    };
  },
};

function describe(voided: TransactionRecord[]): string {
  // The sale is the interesting half of a paid-up-front pair; lead with it.
  const primary = voided.find((v) => v.type === 'sale') ?? voided[0];
  if (!primary) return 'Undone.';

  const noun = primary.type === 'sale' ? 'sale' : primary.type === 'payment' ? 'payment' : 'expense';
  return `Undone. That ${noun} of ${formatNaira(primary.amount)} no longer counts.`;
}
