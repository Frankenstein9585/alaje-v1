import type { Logger } from '../logger.js';
import {
  LlmError,
  type LlmClient,
  type LlmMessage,
  type LlmRequest,
  type LlmResponse,
  type LlmStopReason,
  type LlmToolCall,
} from './llm.js';

/**
 * Adapter for the OpenAI chat-completions wire format.
 *
 * DeepSeek, OpenRouter, Groq, Together, Fireworks and OpenAI itself all speak
 * this shape, so the provider is a base URL, a model slug and a key. Point it
 * wherever; if one is rate limiting mid-demo, change the env vars and restart.
 *
 * Not every model behind these gateways supports tool calling. Check before
 * picking a slug: a model without it will simply answer in prose and never
 * emit a tool call, which looks like a broken agent rather than a config error.
 */

export interface OpenAiCompatConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  maxTokens: number;
  temperature: number;
  timeoutMs: number;
  /** Sent as OpenRouter attribution headers; harmless elsewhere. */
  appUrl?: string;
  appTitle?: string;
}

/** Injected so tests can drive the adapter without a network. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

interface WireToolCall {
  id?: unknown;
  function?: { name?: unknown; arguments?: unknown };
}

interface WireChoice {
  message?: { content?: unknown; tool_calls?: unknown };
  finish_reason?: unknown;
}

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

export class OpenAiCompatClient implements LlmClient {
  constructor(
    private readonly config: OpenAiCompatConfig,
    private readonly logger: Logger,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async complete(req: LlmRequest): Promise<LlmResponse> {
    // One retry on transient failures, per the plan's error handling. Anything
    // still failing after that is the loop's problem, not the transport's.
    try {
      return await this.attempt(req);
    } catch (err) {
      if (err instanceof LlmError && err.options.retryable) {
        this.logger.warn({ err: err.message }, 'llm call failed, retrying once');
        return this.attempt(req);
      }
      throw err;
    }
  }

  private async attempt(req: LlmRequest): Promise<LlmResponse> {
    const body = {
      model: this.config.model,
      messages: [
        { role: 'system', content: req.system },
        ...req.messages.map(toWireMessage),
      ],
      // Omit `tools` entirely when empty. Some gateways reject an empty array.
      ...(req.tools.length > 0
        ? {
            tools: req.tools.map((t) => ({
              type: 'function',
              function: {
                name: t.name,
                description: t.description,
                parameters: t.parameters,
              },
            })),
            tool_choice: 'auto',
          }
        : {}),
      max_tokens: req.maxTokens ?? this.config.maxTokens,
      temperature: req.temperature ?? this.config.temperature,
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);

    let res: Response;
    try {
      res = await this.fetchImpl(`${trimSlash(this.config.baseUrl)}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.config.apiKey}`,
          'content-type': 'application/json',
          ...(this.config.appUrl ? { 'http-referer': this.config.appUrl } : {}),
          ...(this.config.appTitle ? { 'x-title': this.config.appTitle } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (cause) {
      // Network failure or timeout. Both are worth one retry.
      throw new LlmError('llm request failed to complete', { retryable: true, cause });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => '<unreadable body>');
      const retryable = RETRYABLE_STATUS.has(res.status);
      // Log the provider's own error text. "LLM call failed" alone does not
      // distinguish a bad key from a rate limit from an unsupported parameter.
      this.logger.error({ status: res.status, detail, retryable }, 'llm call rejected');
      throw new LlmError(`llm call rejected with ${res.status}`, {
        status: res.status,
        retryable,
      });
    }

    let payload: unknown;
    try {
      payload = await res.json();
    } catch (cause) {
      throw new LlmError('llm returned a non-JSON body', { retryable: true, cause });
    }

    return parseResponse(payload);
  }
}

function toWireMessage(message: LlmMessage): Record<string, unknown> {
  switch (message.role) {
    case 'user':
      return { role: 'user', content: message.content };
    case 'assistant':
      return {
        role: 'assistant',
        // Must be null rather than "" when the turn was purely tool calls;
        // some gateways reject an empty string alongside tool_calls.
        content: message.content ?? null,
        ...(message.toolCalls && message.toolCalls.length > 0
          ? {
              tool_calls: message.toolCalls.map((c) => ({
                id: c.id,
                type: 'function',
                function: { name: c.name, arguments: c.argumentsJson },
              })),
            }
          : {}),
      };
    case 'tool':
      // The wire format has no is_error flag. A failed tool result is ordinary
      // content; the loop is responsible for making the failure legible in the
      // string it puts here.
      return { role: 'tool', tool_call_id: message.toolCallId, content: message.content };
  }
}

function parseResponse(payload: unknown): LlmResponse {
  const root = payload as { choices?: unknown; usage?: unknown; model?: unknown };
  const choices = Array.isArray(root.choices) ? (root.choices as WireChoice[]) : [];
  const choice = choices[0];

  if (!choice) {
    throw new LlmError('llm response contained no choices', { retryable: true });
  }

  const rawCalls = Array.isArray(choice.message?.tool_calls)
    ? (choice.message.tool_calls as WireToolCall[])
    : [];

  const toolCalls: LlmToolCall[] = [];
  for (const [i, call] of rawCalls.entries()) {
    const name = call.function?.name;
    if (typeof name !== 'string' || name.length === 0) continue; // unusable
    toolCalls.push({
      // Some gateways omit the id on single-call responses. Synthesize one so
      // the tool result can still be correlated.
      id: typeof call.id === 'string' && call.id.length > 0 ? call.id : `call_${i}`,
      name,
      argumentsJson: typeof call.function?.arguments === 'string' ? call.function.arguments : '{}',
    });
  }

  const usage = root.usage as { prompt_tokens?: unknown; completion_tokens?: unknown } | undefined;

  return {
    text: typeof choice.message?.content === 'string' ? choice.message.content : null,
    toolCalls,
    stopReason: toStopReason(choice.finish_reason, toolCalls.length > 0),
    ...(typeof usage?.prompt_tokens === 'number' && typeof usage?.completion_tokens === 'number'
      ? { usage: { inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens } }
      : {}),
    ...(typeof root.model === 'string' ? { model: root.model } : {}),
  };
}

function toStopReason(raw: unknown, hasToolCalls: boolean): LlmStopReason {
  // Trust the presence of tool calls over the reported reason. Several
  // gateways report "stop" on a turn that carries tool_calls, and believing
  // them would silently drop the call.
  if (hasToolCalls) return 'tool_use';
  switch (raw) {
    case 'stop':
      return 'end_turn';
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    default:
      return 'other';
  }
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}
