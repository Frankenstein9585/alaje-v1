import { randomUUID } from 'node:crypto';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { normalizeProductName } from '../format.js';
import type {
  BusinessRecord,
  ConversationTurn,
  NewProduct,
  NewTransaction,
  ProductRecord,
  Store,
  ToolCallLogEntry,
  TransactionRecord,
} from '../store.js';
import type { Db } from './client.js';
import { businesses, messages, processedMessages, products, toolCallLogs, transactions } from './schema.js';
import { inArray } from 'drizzle-orm';

const ER_DUP_ENTRY = 'ER_DUP_ENTRY';

function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === ER_DUP_ENTRY;
}

export class DrizzleStore implements Store {
  constructor(private readonly db: Db) {}

  /**
   * The unique index on wa_message_id does the work: the insert either succeeds
   * (we own this message) or raises ER_DUP_ENTRY (someone already has it).
   * A read-then-write check would race against Meta's retries.
   */
  async claimMessage(waMessageId: string): Promise<boolean> {
    try {
      await this.db.insert(processedMessages).values({ id: randomUUID(), waMessageId });
      return true;
    } catch (err) {
      if (isDuplicateKeyError(err)) return false;
      throw err;
    }
  }

  async findBusinessByPhoneVariants(variants: string[]): Promise<BusinessRecord | null> {
    if (variants.length === 0) return null;
    const rows = await this.db
      .select()
      .from(businesses)
      .where(inArray(businesses.whatsappNumber, variants))
      .limit(1);
    return rows[0] ?? null;
  }

  async createBusiness(canonicalNumber: string): Promise<BusinessRecord> {
    const row: BusinessRecord = {
      id: randomUUID(),
      whatsappNumber: canonicalNumber,
      name: null,
      createdAt: new Date(),
    };
    await this.db.insert(businesses).values(row);
    return row;
  }

  async setBusinessName(businessId: string, name: string): Promise<void> {
    await this.db.update(businesses).set({ name }).where(eq(businesses.id, businessId));
  }

  async logToolCall(entry: ToolCallLogEntry): Promise<void> {
    await this.db.insert(toolCallLogs).values({
      id: randomUUID(),
      businessId: entry.businessId,
      toolName: entry.toolName,
      arguments: entry.arguments ?? null,
      result: entry.result ?? null,
      success: entry.success,
    });
  }

  async findProductByName(businessId: string, name: string): Promise<ProductRecord | null> {
    const rows = await this.db
      .select()
      .from(products)
      .where(
        and(
          eq(products.businessId, businessId),
          eq(products.normalizedName, normalizeProductName(name)),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async listProducts(businessId: string): Promise<ProductRecord[]> {
    return this.db
      .select()
      .from(products)
      .where(eq(products.businessId, businessId))
      .orderBy(products.name);
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
    await this.db.insert(products).values(row);
    return row;
  }

  async adjustStock(
    businessId: string,
    productId: string,
    delta: number,
  ): Promise<ProductRecord | null> {
    // Single relative UPDATE. Read-modify-write would lose an update when two
    // messages arrive at once, and a wrong stock count is invisible until it
    // matters.
    await this.db
      .update(products)
      .set({ stockQty: sql`${products.stockQty} + ${delta}` })
      .where(and(eq(products.id, productId), eq(products.businessId, businessId)));

    const rows = await this.db
      .select()
      .from(products)
      .where(and(eq(products.id, productId), eq(products.businessId, businessId)))
      .limit(1);
    return rows[0] ?? null;
  }

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
    await this.db.insert(transactions).values(row);
    return row;
  }

  async listRecentTransactions(businessId: string, limit: number): Promise<TransactionRecord[]> {
    return this.db
      .select()
      .from(transactions)
      .where(and(eq(transactions.businessId, businessId), isNull(transactions.voidedAt)))
      .orderBy(desc(transactions.createdAt))
      .limit(limit);
  }

  async voidTransaction(
    businessId: string,
    transactionId: string,
  ): Promise<TransactionRecord | null> {
    const rows = await this.db
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.id, transactionId),
          eq(transactions.businessId, businessId),
          isNull(transactions.voidedAt),
        ),
      )
      .limit(1);

    const row = rows[0];
    if (!row) return null; // not found, wrong business, or already voided

    const voidedAt = new Date();
    await this.db
      .update(transactions)
      .set({ voidedAt })
      .where(and(eq(transactions.id, transactionId), eq(transactions.businessId, businessId)));
    return { ...row, voidedAt };
  }

  async appendMessage(businessId: string, turn: ConversationTurn): Promise<void> {
    await this.db.insert(messages).values({
      id: randomUUID(),
      businessId,
      waMessageId: turn.waMessageId ?? null,
      role: turn.role,
      content: turn.content,
    });
  }

  async recentMessages(businessId: string, limit: number): Promise<ConversationTurn[]> {
    const rows = await this.db
      .select()
      .from(messages)
      .where(eq(messages.businessId, businessId))
      .orderBy(desc(messages.createdAt))
      .limit(limit);
    // Query is newest-first for the LIMIT; the caller wants oldest-first.
    return rows
      .reverse()
      .map((r) => ({ role: r.role, content: r.content, waMessageId: r.waMessageId }));
  }
}
