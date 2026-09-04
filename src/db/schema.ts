import {
  bigint,
  boolean,
  decimal,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';

/**
 * IDs are app-generated UUIDs rather than auto-increment: MySQL has no
 * RETURNING clause, and generating the id up front means an insert never needs
 * a follow-up SELECT to learn what it just wrote.
 */
const id = () => varchar('id', { length: 36 }).primaryKey();

/**
 * A Business row with `name = null` IS the onboarding state — there is no
 * separate onboarding table. First contact from an unmatched number creates the
 * row; the next message fills in the name.
 */
export const businesses = mysqlTable(
  'businesses',
  {
    id: id(),
    // Canonical international digits, no '+'. Always written via toCanonical().
    whatsappNumber: varchar('whatsapp_number', { length: 32 }).notNull(),
    name: varchar('name', { length: 120 }),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => ({
    whatsappNumberIdx: uniqueIndex('businesses_whatsapp_number_idx').on(t.whatsappNumber),
  }),
);

export const products = mysqlTable(
  'products',
  {
    id: id(),
    businessId: varchar('business_id', { length: 36 }).notNull(),
    /** As the owner wrote it. This is what gets shown back to them. */
    name: varchar('name', { length: 160 }).notNull(),
    /**
     * Lowercased, whitespace-collapsed, de-pluralized. Uniqueness is enforced
     * on this rather than on `name`: "Indomie", "indomie " and "Indomies" are
     * one product to a shop owner, and three rows for them would quietly break
     * every stock count.
     */
    normalizedName: varchar('normalized_name', { length: 160 }).notNull(),
    /** "carton", "bag", "crate". Null until the owner uses one. */
    unit: varchar('unit', { length: 32 }),
    stockQty: int('stock_qty').notNull().default(0),
    lowStockThreshold: int('low_stock_threshold').notNull().default(0),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => ({
    // Scoped uniqueness: two businesses may both sell "Indomie".
    businessNameIdx: uniqueIndex('products_business_normalized_name_idx').on(
      t.businessId,
      t.normalizedName,
    ),
  }),
);

/** Someone the business sells to. Created on first mention by name. */
export const customers = mysqlTable(
  'customers',
  {
    id: id(),
    businessId: varchar('business_id', { length: 36 }).notNull(),
    name: varchar('name', { length: 160 }).notNull(),
    normalizedName: varchar('normalized_name', { length: 160 }).notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => ({
    businessNameIdx: uniqueIndex('customers_business_normalized_name_idx').on(
      t.businessId,
      t.normalizedName,
    ),
  }),
);

export const transactions = mysqlTable(
  'transactions',
  {
    id: id(),
    /**
     * Insertion order. created_at is a second-granularity TIMESTAMP, so two
     * entries recorded in the same second sort arbitrarily and "undo the last
     * thing" undoes the wrong one. This is the ordering key; created_at is for
     * display and date filtering only.
     */
    seq: bigint('seq', { mode: 'number' }).autoincrement().notNull(),
    businessId: varchar('business_id', { length: 36 }).notNull(),
    type: mysqlEnum('type', ['sale', 'expense', 'payment']).notNull(),
    // Money is DECIMAL, never a float. Read back as a string; parse deliberately.
    amount: decimal('amount', { precision: 14, scale: 2 }).notNull(),
    productRef: varchar('product_ref', { length: 36 }),
    customerId: varchar('customer_id', { length: 36 }),
    quantity: int('quantity'),
    /**
     * Rows written from one thing the owner said share a group id. A sale paid
     * for up front is a sale plus a payment; undoing it must void both, or the
     * reversal leaves a phantom debt behind.
     */
    groupId: varchar('group_id', { length: 36 }),
    // Distinguishes an OCR-derived entry from a typed one — the only
    // difference between the two entry paths.
    source: mysqlEnum('source', ['typed', 'ocr']).notNull().default('typed'),
    /**
     * Voiding rather than deleting. Re-recording a corrected amount would
     * double count, so a mistake needs a way to stop counting. Every report
     * filters `voided_at IS NULL`.
     */
    voidedAt: timestamp('voided_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => ({
    // Every report query is scoped by business first, then by date.
    businessCreatedAtIdx: index('transactions_business_created_at_idx').on(
      t.businessId,
      t.createdAt,
    ),
    businessCustomerIdx: index('transactions_business_customer_idx').on(t.businessId, t.customerId),
    // AUTO_INCREMENT needs to lead an index in InnoDB.
    seqIdx: uniqueIndex('transactions_seq_idx').on(t.seq),
    businessSeqIdx: index('transactions_business_seq_idx').on(t.businessId, t.seq),
  }),
);

/**
 * Rolling conversation transcript. Not a state machine: no status field and
 * nothing to transition. It exists so a clarifying question can be answered by
 * the next message, which the plan's own error handling requires.
 */
export const messages = mysqlTable(
  'messages',
  {
    id: id(),
    businessId: varchar('business_id', { length: 36 }).notNull(),
    waMessageId: varchar('wa_message_id', { length: 128 }),
    role: mysqlEnum('role', ['user', 'assistant']).notNull(),
    content: text('content').notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => ({
    businessCreatedAtIdx: index('messages_business_created_at_idx').on(t.businessId, t.createdAt),
  }),
);

/** One row per tool call: input, output, success. Cheap insurance. */
export const toolCallLogs = mysqlTable(
  'tool_call_logs',
  {
    id: id(),
    businessId: varchar('business_id', { length: 36 }).notNull(),
    toolName: varchar('tool_name', { length: 64 }).notNull(),
    arguments: json('arguments'),
    result: json('result'),
    success: boolean('success').notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => ({
    businessIdx: index('tool_call_logs_business_idx').on(t.businessId, t.createdAt),
  }),
);

/**
 * Webhook dedupe. Meta retries deliveries, and a retried payload must produce
 * zero additional replies. The unique index on wa_message_id is what enforces
 * that — the insert either wins the claim or throws ER_DUP_ENTRY.
 */
export const processedMessages = mysqlTable(
  'processed_messages',
  {
    id: id(),
    waMessageId: varchar('wa_message_id', { length: 128 }).notNull(),
    processedAt: timestamp('processed_at').notNull().defaultNow(),
  },
  (t) => ({
    waMessageIdIdx: uniqueIndex('processed_messages_wa_message_id_idx').on(t.waMessageId),
  }),
);
