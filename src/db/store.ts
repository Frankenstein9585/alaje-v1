import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, gte, isNull, lt, sql } from 'drizzle-orm';
import { normalizeProductName } from '../format.js';
import { koboToDecimal } from '../money.js';
import type {
  BusinessRecord,
  ConversationTurn,
  CustomerRecord,
  NewProduct,
  NewTransaction,
  ProductRecord,
  Store,
  ToolCallLogEntry,
  TransactionRecord,
} from '../store.js';
import type { Db } from './client.js';
import {
  businesses,
  customers,
  messages,
  processedMessages,
  products,
  toolCallLogs,
  transactions,
} from './schema.js';
import { inArray } from 'drizzle-orm';

const ER_DUP_ENTRY = 'ER_DUP_ENTRY';

/** A sale adds to what a customer owes; a payment reduces it. */
const BALANCE_SUM = sql<string>`COALESCE(SUM(CASE ${transactions.type}
  WHEN 'sale' THEN ${transactions.amount}
  WHEN 'payment' THEN -${transactions.amount}
  ELSE 0 END), 0)`;

function normalizeBalance(raw: unknown): string {
  if (raw === null || raw === undefined) return '0.00';
  return koboToDecimal(Math.round(Number(raw) * 100));
}

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
      costPrice: product.costPrice ?? null,
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

  async findCustomerByName(businessId: string, name: string): Promise<CustomerRecord | null> {
    const rows = await this.db
      .select()
      .from(customers)
      .where(
        and(
          eq(customers.businessId, businessId),
          eq(customers.normalizedName, normalizeProductName(name)),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async listCustomers(businessId: string): Promise<CustomerRecord[]> {
    return this.db
      .select()
      .from(customers)
      .where(eq(customers.businessId, businessId))
      .orderBy(customers.name);
  }

  async createCustomer(businessId: string, name: string): Promise<CustomerRecord> {
    const row: CustomerRecord = {
      id: randomUUID(),
      businessId,
      name: name.trim(),
      normalizedName: normalizeProductName(name),
    };
    await this.db.insert(customers).values(row);
    return row;
  }

  /**
   * Summed in SQL over DECIMAL so the arithmetic never becomes a float, and
   * derived from transactions rather than a stored column: a running balance
   * and a voided transaction drift apart the moment anyone corrects anything.
   */
  async customerBalance(businessId: string, customerId: string): Promise<string> {
    const rows = await this.db
      .select({ balance: BALANCE_SUM })
      .from(transactions)
      .where(
        and(
          eq(transactions.businessId, businessId),
          eq(transactions.customerId, customerId),
          isNull(transactions.voidedAt),
        ),
      );
    return normalizeBalance(rows[0]?.balance);
  }

  async outstandingBalances(
    businessId: string,
  ): Promise<Array<{ customer: CustomerRecord; balance: string }>> {
    const rows = await this.db
      .select({
        id: customers.id,
        businessId: customers.businessId,
        name: customers.name,
        normalizedName: customers.normalizedName,
        balance: BALANCE_SUM,
      })
      .from(transactions)
      .innerJoin(customers, eq(customers.id, transactions.customerId))
      .where(and(eq(transactions.businessId, businessId), isNull(transactions.voidedAt)))
      .groupBy(customers.id, customers.businessId, customers.name, customers.normalizedName)
      .having(sql`${BALANCE_SUM} <> 0`)
      .orderBy(desc(BALANCE_SUM));

    return rows.map((r) => ({
      customer: {
        id: r.id,
        businessId: r.businessId,
        name: r.name,
        normalizedName: r.normalizedName,
      },
      balance: normalizeBalance(r.balance),
    }));
  }

  async setProductCost(
    businessId: string,
    productId: string,
    costPrice: string,
  ): Promise<ProductRecord | null> {
    await this.db
      .update(products)
      .set({ costPrice })
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
      costAmount: tx.costAmount ?? null,
      groupId: tx.groupId ?? null,
      source: tx.source ?? 'typed',
      voidedAt: null,
      createdAt: new Date(),
    };
    // seq is assigned by the database.
    await this.db.insert(transactions).values(row);
    return row;
  }

  async listRecentTransactions(businessId: string, limit: number): Promise<TransactionRecord[]> {
    return this.db
      .select()
      .from(transactions)
      .where(and(eq(transactions.businessId, businessId), isNull(transactions.voidedAt)))
      // seq, not created_at: same-second entries must still order correctly.
      .orderBy(desc(transactions.seq))
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

  async transactionsBetween(
    businessId: string,
    from: Date,
    to: Date,
  ): Promise<TransactionRecord[]> {
    return this.db
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.businessId, businessId),
          isNull(transactions.voidedAt),
          gte(transactions.createdAt, from),
          lt(transactions.createdAt, to),
        ),
      )
      .orderBy(asc(transactions.seq));
  }

  async customerTransactions(
    businessId: string,
    customerId: string,
  ): Promise<TransactionRecord[]> {
    return this.db
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.businessId, businessId),
          eq(transactions.customerId, customerId),
          isNull(transactions.voidedAt),
        ),
      )
      .orderBy(asc(transactions.seq));
  }

  async voidLastEntry(businessId: string): Promise<TransactionRecord[]> {
    const [latest] = await this.listRecentTransactions(businessId, 1);
    if (!latest) return [];

    // Void the whole group, not just the newest row: a sale paid up front is a
    // sale plus a payment, and voiding one of them leaves a phantom debt.
    const siblings = latest.groupId
      ? await this.db
          .select()
          .from(transactions)
          .where(
            and(
              eq(transactions.businessId, businessId),
              eq(transactions.groupId, latest.groupId),
              isNull(transactions.voidedAt),
            ),
          )
      : [latest];

    const voidedAt = new Date();
    for (const row of siblings) {
      await this.db
        .update(transactions)
        .set({ voidedAt })
        .where(and(eq(transactions.id, row.id), eq(transactions.businessId, businessId)));
    }
    return siblings.map((row) => ({ ...row, voidedAt }));
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
