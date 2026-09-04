import type { Logger } from '../logger.js';
import type { BusinessRecord, Store } from '../store.js';
import type { InboundTextMessage } from '../whatsapp/types.js';
import { LlmError, type LlmClient, type LlmMessage, type LlmToolCall } from './llm.js';
import { FALLBACK_REPLY, buildSystemPrompt } from './prompt.js';
import {
  executeTool,
  toolDefinitions,
  type AnyToolDefinition,
  type ToolContext,
} from './tools/registry.js';

export interface AgentDeps {
  store: Store;
  logger: Logger;
  llm: LlmClient;
  tools: AnyToolDefinition[];
  maxIterations: number;
  /** Passed to tools that send files. The recipient is fixed by the caller. */
  channel?: ToolContext['channel'];
}

/**
 * The agent loop.
 *
 * Load bearing properties, all of which must survive any rewrite:
 *
 *   - the business arrives resolved; the loop never decides whose data it is
 *   - the loop reaches the database only through the tool layer
 *   - every tool call is logged with arguments, result and success
 *   - a failed tool reports failure to the owner rather than claiming success
 *   - the owner always gets a reply, even when everything below fails
 */
export async function runAgent(
  deps: AgentDeps,
  business: BusinessRecord,
  message: InboundTextMessage,
  history: LlmMessage[] = [],
): Promise<string> {
  const system = buildSystemPrompt(business);
  const tools = toolDefinitions(deps.tools);
  const ctx: ToolContext = {
    business,
    store: deps.store,
    logger: deps.logger,
    ...(deps.channel ? { channel: deps.channel } : {}),
  };

  const messages: LlmMessage[] = [...history, { role: 'user', content: message.text ?? '' }];

  for (let iteration = 0; iteration < deps.maxIterations; iteration++) {
    let response;
    try {
      response = await deps.llm.complete({ system, messages, tools });
    } catch (err) {
      // The adapter has already retried transient failures, so this is final.
      deps.logger.error(
        { err, businessId: business.id, waMessageId: message.waMessageId, iteration },
        err instanceof LlmError ? 'llm call failed' : 'llm call threw unexpectedly',
      );
      return FALLBACK_REPLY;
    }

    if (response.stopReason !== 'tool_use' || response.toolCalls.length === 0) {
      const text = response.text?.trim();
      if (text) return text;

      // Empty final turn. Rare, but silence is not an acceptable reply.
      deps.logger.warn(
        { businessId: business.id, stopReason: response.stopReason },
        'model returned no text',
      );
      return FALLBACK_REPLY;
    }

    messages.push({
      role: 'assistant',
      content: response.text,
      toolCalls: response.toolCalls,
    });

    // Execute every call in this turn, then return all results together.
    // Splitting results across messages teaches the model to stop batching.
    const outcomes = await Promise.all(
      response.toolCalls.map((call: LlmToolCall) => executeTool(deps.tools, ctx, call)),
    );

    for (const [i, outcome] of outcomes.entries()) {
      const call = response.toolCalls[i];
      if (!call) continue;
      messages.push({
        role: 'tool',
        toolCallId: call.id,
        content: outcome.content,
        isError: outcome.isError,
      });
    }
  }

  // Ran out of iterations mid-conversation. Something was attempted and we
  // cannot describe the outcome honestly, so do not try.
  deps.logger.warn(
    { businessId: business.id, waMessageId: message.waMessageId, cap: deps.maxIterations },
    'agent hit iteration cap',
  );
  return FALLBACK_REPLY;
}
