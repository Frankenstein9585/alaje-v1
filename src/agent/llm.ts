/**
 * The LLM port.
 *
 * Nothing below the loop imports a provider SDK. This interface is deliberately
 * the intersection of what Anthropic, OpenAI, DeepSeek, Gemini and the
 * OpenAI-compatible gateways all express, so swapping providers is one adapter
 * file and three environment variables.
 *
 * It is also what makes the agent loop testable: `ScriptedLlmClient` in the
 * tests implements this and replays canned responses, so loop behaviour can be
 * asserted without an API key, a network call, or a non-deterministic model.
 */

/** JSON Schema for a tool's arguments. Produced from a Zod schema. */
export type JsonSchema = Record<string, unknown>;

export interface LlmToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface LlmToolCall {
  /** Provider-assigned id. Echoed back on the matching tool result. */
  id: string;
  name: string;
  /**
   * Raw JSON string exactly as the model emitted it.
   *
   * Kept unparsed on purpose. Providers differ in how they escape strings, so
   * the caller must JSON.parse and then validate with the tool's Zod schema.
   * Never string-match against this.
   */
  argumentsJson: string;
}

export type LlmMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; toolCalls?: LlmToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string; isError?: boolean };

export interface LlmRequest {
  system: string;
  messages: LlmMessage[];
  tools: LlmToolDefinition[];
  maxTokens?: number;
  temperature?: number;
}

export type LlmStopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'other';

export interface LlmResponse {
  text: string | null;
  toolCalls: LlmToolCall[];
  stopReason: LlmStopReason;
  usage?: { inputTokens: number; outputTokens: number };
  /** Which model actually served the request, when the provider reports it. */
  model?: string;
}

export interface LlmClient {
  complete(req: LlmRequest): Promise<LlmResponse>;
}

/**
 * Thrown when the provider could not be reached or refused the request.
 *
 * `retryable` records whether the adapter considered this transient. The
 * adapter has already retried transient failures by the time this surfaces, so
 * the loop treats any LlmError as final and replies with a plain failure.
 */
export class LlmError extends Error {
  constructor(
    message: string,
    readonly options: { status?: number; retryable: boolean; cause?: unknown },
  ) {
    super(message);
    this.name = 'LlmError';
  }
}
