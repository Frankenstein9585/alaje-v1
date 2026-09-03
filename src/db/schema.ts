import {
  boolean,
  decimal,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
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
    name: varchar('name', { length: 160 }).notNull(),
    stockQty: int('stock_qty').notNull().default(0),
    lowStockThreshold: int('low_stock_threshold').notNull().default(0),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => ({
    // Scoped uniqueness: two businesses may both sell "Indomie".
    businessNameIdx: uniqueIndex('products_business_name_idx').on(t.businessId, t.name),
  }),
);

export const transactions = mysqlTable(
  'transactions',
  {
    id: id(),
    businessId: varchar('business_id', { length: 36 }).notNull(),
    type: mysqlEnum('type', ['sale', 'expense']).notNull(),
    // Money is DECIMAL, never a float. Read back as a string; parse deliberately.
    amount: decimal('amount', { precision: 14, scale: 2 }).notNull(),
    productRef: varchar('product_ref', { length: 36 }),
    // Distinguishes an OCR-derived expense from a typed one — the only
    // difference between the two entry paths into record_expense.
    source: mysqlEnum('source', ['typed', 'ocr']).notNull().default('typed'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => ({
    // Every report query is scoped by business first, then by date.
    businessCreatedAtIdx: index('transactions_business_created_at_idx').on(t.businessId, t.createdAt),
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
