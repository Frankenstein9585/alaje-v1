import type { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { Logger } from '../../logger.js';
import type { BusinessRecord, Store } from '../../store.js';
import type { LlmToolCall, LlmToolDefinition } from '../llm.js';

/**
 * Everything a tool is allowed to touch.
 *
 * The business is injected by the loop from `resolveBusiness`, never named by
 * the model. No tool takes a business id argument, so there is no way for the
 * model to express "act on someone else's data" even if it tried.
 */
export interface ToolContext {
  business: BusinessRecord;
  store: Store;
  logger: Logger;
}

export interface ToolDefinition<A> {
  name: string;
  description: string;
  schema: z.ZodType<A>;
  execute(ctx: ToolContext, args: A): Promise<unknown>;
}

/** Existential wrapper so tools with different argument types share a registry. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyToolDefinition = ToolDefinition<any>;

export interface ToolOutcome {
  name: string;
  /** JSON string handed back to the model as the tool result. */
  content: string;
  isError: boolean;
  /** Parsed result, for the caller to derive state from. Absent on failure. */
  value?: unknown;
}

/**
 * Render tool schemas for the wire.
 *
 * `$refStrategy: 'none'` inlines everything. Several gateways (and Gemini's
 * restricted schema subset) choke on `$ref`/`definitions`, and a tool the
 * provider silently drops looks exactly like a model that refuses to call it.
 */
export function toolDefinitions(tools: AnyToolDefinition[]): LlmToolDefinition[] {
  return tools.map((tool) => {
    const schema = zodToJsonSchema(tool.schema, {
      $refStrategy: 'none',
      target: 'openApi3',
    }) as Record<string, unknown>;
    delete schema.$schema;
    return { name: tool.name, description: tool.description, parameters: schema };
  });
}

/**
 * Execute one tool call: parse, validate, run, log.
 *
 * Logging lives here rather than inside each tool so a new tool cannot forget
 * to write its audit row. Every path through this function logs exactly once.
 */
export async function executeTool(
  tools: AnyToolDefinition[],
  ctx: ToolContext,
  call: LlmToolCall,
): Promise<ToolOutcome> {
  const tool = tools.find((t) => t.name === call.name);
  if (!tool) {
    // The model invented a tool. Tell it plainly rather than failing the turn;
    // it will usually recover by calling a real one.
    await logCall(ctx, call.name, null, { error: 'unknown tool' }, false);
    return fail(call.name, `No tool named "${call.name}" exists.`);
  }

  let raw: unknown;
  try {
    // Always parse. Providers differ in how they escape strings, so never
    // string-match against the model's arguments.
    raw = JSON.parse(call.argumentsJson || '{}');
  } catch {
    await logCall(ctx, tool.name, call.argumentsJson, { error: 'invalid JSON' }, false);
    return fail(tool.name, 'Arguments were not valid JSON. Send them again.');
  }

  const parsed = tool.schema.safeParse(raw);
  if (!parsed.success) {
    // Do not coerce. A guessed amount is worse than an asked question.
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    await logCall(ctx, tool.name, raw, { error: issues }, false);
    return fail(tool.name, `Invalid arguments: ${issues}`);
  }

  try {
    const value = await tool.execute(ctx, parsed.data);
    await logCall(ctx, tool.name, parsed.data, value, true);
    return { name: tool.name, content: JSON.stringify(value), isError: false, value };
  } catch (err) {
    // Log the real exception. A generic failure makes every root cause look
    // identical from the outside.
    ctx.logger.error(
      { err, tool: tool.name, businessId: ctx.business.id },
      'tool execution threw',
    );
    const message = err instanceof Error ? err.message : String(err);
    await logCall(ctx, tool.name, parsed.data, { error: message }, false);
    return fail(tool.name, 'That action did not go through.');
  }
}

function fail(name: string, error: string): ToolOutcome {
  return { name, content: JSON.stringify({ ok: false, error }), isError: true };
}

async function logCall(
  ctx: ToolContext,
  toolName: string,
  args: unknown,
  result: unknown,
  success: boolean,
): Promise<void> {
  try {
    await ctx.store.logToolCall({
      businessId: ctx.business.id,
      toolName,
      arguments: args,
      result,
      success,
    });
  } catch (err) {
    // The audit row failing must never take down the actual reply.
    ctx.logger.error({ err, tool: toolName }, 'failed to write tool call log');
  }
}
