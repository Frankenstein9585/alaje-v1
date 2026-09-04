import { z } from 'zod';
import { parseBusinessName } from '../../businesses/onboarding.js';
import type { ToolDefinition } from './registry.js';

/**
 * Correcting the business name.
 *
 * Onboarding only runs while `name` is null, so without this a typo in that
 * first exchange is permanent: the wrong name then appears in every reply and
 * on every invoice, and the owner has no way to say so.
 *
 * Deliberately narrow. It changes one string on one row, touches no money and
 * no stock, and is scoped to the business the loop resolved — so there is
 * nothing here for a confused model to damage.
 */

const renameArgs = z.object({
  name: z.string().min(1).max(120).describe('The corrected business name, exactly as given'),
});

export const renameBusinessTool: ToolDefinition<z.infer<typeof renameArgs>> = {
  name: 'rename_business',
  description:
    "Change the name of the owner's own business. Use this only when they say the business name is wrong or should be different, for example \"my shop is actually called X\" or \"you spelt my business name wrong\". This is not for customers or products.",
  schema: renameArgs,
  async execute(ctx, args) {
    // Reuse onboarding's validation so both entry points accept exactly the
    // same set of names.
    const name = parseBusinessName(args.name);
    if (!name) {
      return {
        ok: false,
        display: "That doesn't look like a business name. What should I call it?",
      };
    }

    const previous = ctx.business.name;
    await ctx.store.setBusinessName(ctx.business.id, name);
    // Keep the in-memory copy in step, so the rest of this turn uses the new
    // name rather than the stale one.
    ctx.business.name = name;

    return {
      ok: true,
      previous,
      name,
      display: `Noted, I'll call it ${name} from now on.`,
    };
  },
};
