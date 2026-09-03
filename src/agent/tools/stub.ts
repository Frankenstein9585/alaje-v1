import type { BusinessRecord } from '../../store.js';

export interface StubToolArgs {
  message: string;
}

export interface StubToolResult {
  businessId: string;
  echoed: string;
}

/**
 * Phase 1 placeholder standing in for record_sale / record_expense / run_report.
 *
 * It exists to prove the wiring end-to-end: a resolved business reaches a tool
 * that is scoped to its own business_id, and the call is logged. Phase 2
 * replaces it with the real tools behind an LLM function-calling loop.
 *
 * Note the shape — every tool takes the business as an explicit argument rather
 * than reading it from ambient state, so a tool can never operate on a business
 * it was not handed.
 */
export function stubTool(business: BusinessRecord, args: StubToolArgs): StubToolResult {
  return { businessId: business.id, echoed: args.message };
}
