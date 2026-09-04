import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { normalizeProductName } from '../src/format.js';
import type {
  BusinessRecord,
  ConversationTurn,
  NewProduct,
  NewTransaction,
  ProductRecord,
  Store,
  ToolCallLogEntry,
  TransactionRecord,
} from '../src/store.js';
import type { LlmClient, LlmRequest, LlmResponse } from '../src/agent/llm.js';
import type { WhatsAppSender } from '../src/whatsapp/client.js';

export const silentLogger = pino({ level: 'silent' });

export class InMemoryStore implements Store {
  readonly businesses: BusinessRecord[] = [];
  readonly toolCalls: ToolCallLogEntry[] = [];
  readonly products: ProductRecord[] = [];
  readonly transactions: TransactionRecord[] = [];
  readonly messages: Array<{ businessId: string; turn: ConversationTurn }> = [];
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

  // --- products ---

  async findProductByName(businessId: string, name: string): Promise<ProductRecord | null> {
    const normalized = normalizeProductName(name);
    return (
      this.products.find((p) => p.businessId === businessId && p.normalizedName === normalized) ??
      null
    );
  }

  async listProducts(businessId: string): Promise<ProductRecord[]> {
    return this.products
      .filter((p) => p.businessId === businessId)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async createProduct(businessId: string, product: NewProduct): Promise<ProductRecord> {
    const row: ProductRecord = {
      id: randomUUID(),
      businessId,
      name: product.name.trim(),
      normalizedName: normalizeProductName(product.name),
      unit: product.unit ?? null,
      stockQty: product.stockQty ?? 0,
      lowStockThreshold: product.lowStockThreshold ?? 0,
    };
    this.products.push(row);
    return row;
  }

  async adjustStock(
    businessId: string,
    productId: string,
    delta: number,
  ): Promise<ProductRecord | null> {
    const row = this.products.find((p) => p.id === productId && p.businessId === businessId);
    if (!row) return null;
    row.stockQty += delta;
    return row;
  }

  // --- transactions ---

  async createTransaction(businessId: string, tx: NewTransaction): Promise<TransactionRecord> {
    const row: TransactionRecord = {
      id: randomUUID(),
      businessId,
      type: tx.type,
      amount: tx.amount,
      productRef: tx.productRef ?? null,
      customerId: tx.customerId ?? null,
      quantity: tx.quantity ?? null,
      source: tx.source ?? 'typed',
      voidedAt: null,
      createdAt: new Date(),
    };
    this.transactions.push(row);
    return row;
  }

  async listRecentTransactions(businessId: string, limit: number): Promise<TransactionRecord[]> {
    return this.transactions
      .filter((t) => t.businessId === businessId && t.voidedAt === null)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
  }

  async voidTransaction(
    businessId: string,
    transactionId: string,
  ): Promise<TransactionRecord | null> {
    const row = this.transactions.find(
      (t) => t.id === transactionId && t.businessId === businessId && t.voidedAt === null,
    );
    if (!row) return null;
    row.voidedAt = new Date();
    return row;
  }

  // --- conversation ---

  async appendMessage(businessId: string, turn: ConversationTurn): Promise<void> {
    this.messages.push({ businessId, turn });
  }

  async recentMessages(businessId: string, limit: number): Promise<ConversationTurn[]> {
    return this.messages
      .filter((m) => m.businessId === businessId)
      .slice(-limit)
      .map((m) => m.turn);
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
