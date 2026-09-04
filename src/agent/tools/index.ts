import type { AnyToolDefinition } from './registry.js';
import { addStockTool, checkStockTool, recordSaleTool } from './stock.js';

/**
 * The tool catalogue. Order is stable so the rendered tool list stays
 * byte-identical between requests and does not defeat prompt caching.
 */
export const allTools: AnyToolDefinition[] = [addStockTool, checkStockTool, recordSaleTool];
