import { randomUUID } from 'node:crypto';
import pino from 'pino';
import type { BusinessRecord, Store, ToolCallLogEntry } from '../src/store.js';
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

  async sendText(to: string, body: string): Promise<void> {
    this.sent.push({ to, body });
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
