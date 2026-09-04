import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { normalizeProductName } from '../src/format.js';
import { sumDecimals, toKobo } from '../src/money.js';
import type {
  BusinessRecord,
  ConversationTurn,
  CustomerRecord,
  NewProduct,
  NewTransaction,
  ProductPatch,
  ProductRecord,
  Store,
  ToolCallLogEntry,
  ToolCallRecord,
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
  readonly customers: CustomerRecord[] = [];
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

  async listToolCalls(businessId: string, limit: number): Promise<ToolCallRecord[]> {
    return this.toolCalls
      .filter((c) => c.businessId === businessId)
      .slice(-limit)
      .map((c) => ({
        toolName: c.toolName,
        arguments: c.arguments,
        result: c.result,
        success: c.success,
        createdAt: new Date(),
      }));
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
    // Mirrors DrizzleStore, which relies on the unique index: a second create
    // for the same normalized name returns the existing row.
    //
    // The lookup is deliberately NOT awaited. Awaiting yields the event loop
    // between the check and the insert, so two parallel calls both see "not
    // found" and both insert — which is precisely the bug this guards against,
    // and the fake would quietly stop reproducing it.
    const normalized = normalizeProductName(product.name);
    const already = this.products.find(
      (p) => p.businessId === businessId && p.normalizedName === normalized,
    );
    if (already) return already;
    const row: ProductRecord = {
      id: randomUUID(),
      businessId,
      name: product.name.trim(),
      normalizedName: normalizeProductName(product.name),
      unit: product.unit ?? null,
      costPrice: product.costPrice ?? null,
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

  async updateProduct(
    businessId: string,
    productId: string,
    patch: ProductPatch,
  ): Promise<ProductRecord | null> {
    const row = this.products.find((p) => p.id === productId && p.businessId === businessId);
    if (!row) return null;
    if (patch.unit !== undefined) row.unit = patch.unit;
    if (patch.costPrice !== undefined) row.costPrice = patch.costPrice;
    if (patch.lowStockThreshold !== undefined) row.lowStockThreshold = patch.lowStockThreshold;
    return row;
  }

  // --- customers ---

  async findCustomerByName(businessId: string, name: string): Promise<CustomerRecord | null> {
    const normalized = normalizeProductName(name);
    return (
      this.customers.find((c) => c.businessId === businessId && c.normalizedName === normalized) ??
      null
    );
  }

  async listCustomers(businessId: string): Promise<CustomerRecord[]> {
    return this.customers
      .filter((c) => c.businessId === businessId)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async createCustomer(businessId: string, name: string): Promise<CustomerRecord> {
    // Same reasoning as createProduct: no await between check and insert.
    const normalized = normalizeProductName(name);
    const already = this.customers.find(
      (c) => c.businessId === businessId && c.normalizedName === normalized,
    );
    if (already) return already;
    const row: CustomerRecord = {
      id: randomUUID(),
      businessId,
      name: name.trim(),
      normalizedName: normalizeProductName(name),
    };
    this.customers.push(row);
    return row;
  }

  async customerBalance(businessId: string, customerId: string): Promise<string> {
    const signed = this.transactions
      .filter(
        (t) => t.businessId === businessId && t.customerId === customerId && t.voidedAt === null,
      )
      .map((t) => (t.type === 'payment' ? -toKobo(t.amount) / 100 : t.type === 'sale' ? Number(t.amount) : 0));
    return sumDecimals(signed);
  }

  async outstandingBalances(
    businessId: string,
  ): Promise<Array<{ customer: CustomerRecord; balance: string }>> {
    const out: Array<{ customer: CustomerRecord; balance: string }> = [];
    for (const customer of await this.listCustomers(businessId)) {
      const balance = await this.customerBalance(businessId, customer.id);
      if (toKobo(balance) !== 0) out.push({ customer, balance });
    }
    return out.sort((a, b) => toKobo(b.balance) - toKobo(a.balance));
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
      costAmount: tx.costAmount ?? null,
      groupId: tx.groupId ?? null,
      source: tx.source ?? 'typed',
      voidedAt: null,
      createdAt: new Date(),
    };
    this.transactions.push(row);
    return row;
  }

  async listRecentTransactions(businessId: string, limit: number): Promise<TransactionRecord[]> {
    // Insertion order stands in for the database's seq column. Sorting on
    // createdAt here would reproduce the same-second ambiguity seq exists to
    // avoid, and the test would stop catching it.
    return this.transactions
      .filter((t) => t.businessId === businessId && t.voidedAt === null)
      .slice()
      .reverse()
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

  async transactionsBetween(
    businessId: string,
    from: Date,
    to: Date,
  ): Promise<TransactionRecord[]> {
    return this.transactions.filter(
      (t) =>
        t.businessId === businessId &&
        t.voidedAt === null &&
        t.createdAt >= from &&
        t.createdAt < to,
    );
  }

  async customerTransactions(
    businessId: string,
    customerId: string,
  ): Promise<TransactionRecord[]> {
    return this.transactions.filter(
      (t) => t.businessId === businessId && t.customerId === customerId && t.voidedAt === null,
    );
  }

  async voidLastEntry(businessId: string): Promise<TransactionRecord[]> {
    const [latest] = await this.listRecentTransactions(businessId, 1);
    if (!latest) return [];

    const siblings = latest.groupId
      ? this.transactions.filter(
          (t) =>
            t.businessId === businessId && t.groupId === latest.groupId && t.voidedAt === null,
        )
      : [latest];

    const voidedAt = new Date();
    for (const row of siblings) row.voidedAt = voidedAt;
    return siblings;
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
  readonly documents: Array<{
    to: string;
    filename: string;
    size: number;
    caption?: string | undefined;
  }> = [];
  /** Set to exercise the text fallback. */
  failDocuments = false;

  async sendText(to: string, body: string): Promise<void> {
    this.sent.push({ to, body });
  }

  async acknowledge(waMessageId: string): Promise<void> {
    this.acknowledged.push(waMessageId);
  }

  async sendDocument(
    to: string,
    file: { buffer: Buffer; filename: string; mimeType: string },
    caption?: string,
  ): Promise<void> {
    if (this.failDocuments) throw new Error('media upload failed');
    this.documents.push({ to, filename: file.filename, size: file.buffer.length, caption });
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
