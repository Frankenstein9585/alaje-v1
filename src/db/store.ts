import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import type { Db } from './client.js';
import { businesses, processedMessages, toolCallLogs } from './schema.js';
import type { BusinessRecord, Store, ToolCallLogEntry } from '../store.js';

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
}
