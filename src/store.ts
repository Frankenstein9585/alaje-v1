/**
 * The persistence port used by message handling.
 *
 * Message handling depends on this interface rather than on Drizzle directly so
 * the Phase 1 acceptance criteria (dedupe produces exactly one reply; a new
 * number is walked through onboarding) are testable without a live MySQL.
 * `DrizzleStore` is the real implementation; `InMemoryStore` backs the tests.
 */

export interface BusinessRecord {
  id: string;
  whatsappNumber: string;
  name: string | null;
  createdAt: Date;
}

export interface ToolCallLogEntry {
  businessId: string;
  toolName: string;
  arguments: unknown;
  result: unknown;
  success: boolean;
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
}
