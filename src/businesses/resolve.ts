import { phoneVariants, toCanonical } from '../phone.js';
import type { BusinessRecord, Store } from '../store.js';

export interface ResolvedBusiness {
  business: BusinessRecord;
  /** True when this message is the very first contact from the number. */
  isNew: boolean;
}

/**
 * Resolve which business an inbound message belongs to.
 *
 * This is deterministic server-side code and it runs BEFORE the agent loop.
 * Identity is never something the model infers or decides — the model decides
 * *when* to act, never *whose* data it acts on. Keep it that way.
 */
export async function resolveBusiness(store: Store, fromNumber: string): Promise<ResolvedBusiness> {
  const existing = await store.findBusinessByPhoneVariants(phoneVariants(fromNumber));
  if (existing) return { business: existing, isNew: false };

  const business = await store.createBusiness(toCanonical(fromNumber));
  return { business, isNew: true };
}
