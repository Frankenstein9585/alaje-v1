import type { Logger } from '../logger.js';
import type { BusinessRecord, Store } from '../store.js';
import type { InboundTextMessage } from '../whatsapp/types.js';
import { stubTool } from './tools/stub.js';

/**
 * Phase 1 agent loop.
 *
 * There is no LLM here yet — Phase 2 replaces the body with a function-calling
 * loop over record_sale / record_expense / run_report. What is already load
 * bearing and must survive that swap:
 *
 *   - the business arrives resolved; the loop never decides whose data it is;
 *   - the loop reaches the database only through the tool layer;
 *   - every tool call is logged with arguments, result, and success;
 *   - a thrown tool reports failure to the owner rather than claiming success.
 */
export async function runAgent(
  deps: { store: Store; logger: Logger },
  business: BusinessRecord,
  message: InboundTextMessage,
): Promise<string> {
  const args = { message: message.text ?? '' };

  try {
    const result = stubTool(business, args);
    await deps.store.logToolCall({
      businessId: business.id,
      toolName: 'stub',
      arguments: args,
      result,
      success: true,
    });
    return `Got it — I logged that against ${business.name}. (Phase 1 stub: I can't act on it yet.)`;
  } catch (err) {
    // Log the real exception. A generic failure reply makes every root cause
    // look identical from the outside; the log is the only place the truth
    // survives.
    deps.logger.error(
      { err, businessId: business.id, waMessageId: message.waMessageId, tool: 'stub' },
      'tool call threw',
    );
    await deps.store.logToolCall({
      businessId: business.id,
      toolName: 'stub',
      arguments: args,
      result: { error: err instanceof Error ? err.message : String(err) },
      success: false,
    });
    return "Sorry — that didn't go through. Please try again.";
  }
}
