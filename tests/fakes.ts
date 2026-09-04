import { randomUUID } from 'node:crypto';
import pino from 'pino';
import type { BusinessRecord, Store, ToolCallLogEntry } from '../src/store.js';
import type { LlmClient, LlmRequest, LlmResponse } from '../src/agent/llm.js';
import type { WhatsAppSender } from '../src/whatsapp/client.js';

export const silentLogger = pino({ level: 'silent' });

export class InMemoryStore implements Store {
  readonly businesses: BusinessRecord[] = [];
  readonly toolCalls: ToolCallLogEntry[] = [];
  private readonly claimed = new Set<string>();

  async claimMessage(waMessageId: string): Promise<boolean> {
    if (this.claimed.has(waMessageId)) return false;
    this.claimed.add(waMessageId);
    return true;
  }

  async findBusinessByPhoneVariants(variants: string[]): Promise<BusinessRecord | null> {
    return this.businesses.find((b) => variants.includes(b.whatsappNumber)) ?? null;
  }

  async createBusiness(canonicalNumber: string): Promise<BusinessRecord> {
    const row: BusinessRecord = {
      id: randomUUID(),
      whatsappNumber: canonicalNumber,
      name: null,
      createdAt: new Date(),
    };
    this.businesses.push(row);
    return row;
  }

  async setBusinessName(businessId: string, name: string): Promise<void> {
    const row = this.businesses.find((b) => b.id === businessId);
    if (row) row.name = name;
  }

  async logToolCall(entry: ToolCallLogEntry): Promise<void> {
    this.toolCalls.push(entry);
  }
}

export class SpySender implements WhatsAppSender {
  readonly sent: Array<{ to: string; body: string }> = [];
  readonly acknowledged: string[] = [];

  async sendText(to: string, body: string): Promise<void> {
    this.sent.push({ to, body });
  }

  async acknowledge(waMessageId: string): Promise<void> {
    this.acknowledged.push(waMessageId);
  }
}

export function textMessage(overrides: Partial<{ id: string; from: string; text: string }> = {}) {
  return {
    waMessageId: overrides.id ?? `wamid.${randomUUID()}`,
    from: overrides.from ?? '2348031234567',
    timestamp: '1730000000',
    type: 'text' as const,
    text: overrides.text ?? 'hello',
    mediaId: null,
  };
}

/**
 * Replays canned model responses so loop behaviour can be asserted without an
 * API key, a network call, or a non-deterministic model.
 */
export class ScriptedLlmClient implements LlmClient {
  readonly requests: LlmRequest[] = [];
  private readonly queue: Array<LlmResponse | Error>;

  constructor(...responses: Array<LlmResponse | Error>) {
    this.queue = [...responses];
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    this.requests.push(structuredClone(req));
    const next = this.queue.shift();
    if (!next) throw new Error('ScriptedLlmClient ran out of queued responses');
    if (next instanceof Error) throw next;
    return next;
  }
}

export function textResponse(text: string): LlmResponse {
  return { text, toolCalls: [], stopReason: 'end_turn' };
}

export function toolResponse(
  calls: Array<{ name: string; args: unknown; id?: string }>,
): LlmResponse {
  return {
    text: null,
    stopReason: 'tool_use',
    toolCalls: calls.map((c, i) => ({
      id: c.id ?? `call_${i}`,
      name: c.name,
      argumentsJson: JSON.stringify(c.args),
    })),
  };
}
