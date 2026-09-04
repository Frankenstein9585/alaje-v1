/**
 * The persistence port used by message handling and the tool layer.
 *
 * Everything depends on this interface rather than on Drizzle directly so the
 * acceptance criteria are testable without a live MySQL. `DrizzleStore` is the
 * real implementation; `InMemoryStore` backs the tests.
 *
 * Every method that touches business-scoped data takes `businessId` first and
 * filters on it. A missing scope is a silent cross-tenant leak, so there are no
 * exceptions to this, including for reads that "obviously" cannot leak.
 */

export interface BusinessRecord {
  id: string;
  whatsappNumber: string;
  name: string | null;
  createdAt: Date;
}

export interface ProductRecord {
  id: string;
  businessId: string;
  name: string;
  normalizedName: string;
  unit: string | null;
  stockQty: number;
  lowStockThreshold: number;
}

export interface CustomerRecord {
  id: string;
  businessId: string;
  name: string;
  normalizedName: string;
}

export type TransactionType = 'sale' | 'expense' | 'payment';

export interface TransactionRecord {
  id: string;
  businessId: string;
  type: TransactionType;
  /** DECIMAL as a string. Never parsed into a float on the way through. */
  amount: string;
  productRef: string | null;
  customerId: string | null;
  quantity: number | null;
  groupId: string | null;
  source: 'typed' | 'ocr';
  voidedAt: Date | null;
  createdAt: Date;
}

export interface NewProduct {
  name: string;
  unit?: string | null;
  stockQty?: number;
  lowStockThreshold?: number;
}

export interface NewTransaction {
  type: TransactionType;
  amount: string;
  productRef?: string | null;
  customerId?: string | null;
  quantity?: number | null;
  groupId?: string | null;
  source?: 'typed' | 'ocr';
}

export interface ToolCallLogEntry {
  businessId: string;
  toolName: string;
  arguments: unknown;
  result: unknown;
  success: boolean;
}

export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
  waMessageId?: string | null;
}

export interface Store {
  /**
   * Atomically claim a WhatsApp message id for processing.
   * Returns true if this caller won the claim, false if it was already seen.
   * Must be atomic — two concurrent webhook retries must not both win.
   */
  claimMessage(waMessageId: string): Promise<boolean>;

  /** Find a business whose stored number matches ANY of the supplied variants. */
  findBusinessByPhoneVariants(variants: string[]): Promise<BusinessRecord | null>;

  /** Create a business in the onboarding state (name = null). */
  createBusiness(canonicalNumber: string): Promise<BusinessRecord>;

  /** Complete onboarding by setting the business name. */
  setBusinessName(businessId: string, name: string): Promise<void>;

  logToolCall(entry: ToolCallLogEntry): Promise<void>;

  // --- products ---

  /** Match on the normalized name, so casing and plurals resolve to one row. */
  findProductByName(businessId: string, name: string): Promise<ProductRecord | null>;
  listProducts(businessId: string): Promise<ProductRecord[]>;
  createProduct(businessId: string, product: NewProduct): Promise<ProductRecord>;
  /**
   * Apply a relative change to stock and return the updated row.
   * Must be a single atomic statement, not read-modify-write: two messages can
   * arrive concurrently and a lost update silently corrupts the count.
   */
  adjustStock(businessId: string, productId: string, delta: number): Promise<ProductRecord | null>;

  // --- customers ---

  findCustomerByName(businessId: string, name: string): Promise<CustomerRecord | null>;
  listCustomers(businessId: string): Promise<CustomerRecord[]>;
  createCustomer(businessId: string, name: string): Promise<CustomerRecord>;
  /**
   * Net of sales minus payments, per customer. Positive means they owe.
   * Computed from transactions rather than kept as a running column: a stored
   * balance and a voided transaction drift apart the moment anyone corrects
   * anything.
   */
  customerBalance(businessId: string, customerId: string): Promise<string>;
  /** Every customer with a non-zero balance, largest debt first. */
  outstandingBalances(businessId: string): Promise<Array<{ customer: CustomerRecord; balance: string }>>;

  // --- transactions ---

  createTransaction(businessId: string, tx: NewTransaction): Promise<TransactionRecord>;
  /** Most recent first, excluding voided rows. */
  listRecentTransactions(businessId: string, limit: number): Promise<TransactionRecord[]>;
  /** Returns the voided row, or null if it was already voided or not found. */
  voidTransaction(businessId: string, transactionId: string): Promise<TransactionRecord | null>;
  /**
   * Void the most recent entry, including every row sharing its group id.
   * Returns the voided rows, or an empty array when there is nothing to undo.
   */
  voidLastEntry(businessId: string): Promise<TransactionRecord[]>;

  // --- conversation ---

  appendMessage(businessId: string, turn: ConversationTurn): Promise<void>;
  /** Oldest first, ready to append to an LLM message list. */
  recentMessages(businessId: string, limit: number): Promise<ConversationTurn[]>;
}
