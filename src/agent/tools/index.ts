import { renameBusinessTool } from './business.js';
import { setCostPriceTool } from './cost.js';
import { checkBalanceTool, recordPaymentTool } from './customers.js';
import { sendInvoiceTool } from './invoice.js';
import { runReportTool } from './report.js';
import type { AnyToolDefinition } from './registry.js';
import { addStockTool, checkStockTool, recordSaleTool } from './stock.js';
import { undoLastTool } from './undo.js';

/**
 * The tool catalogue. Order is stable so the rendered tool list stays
 * byte-identical between requests and does not defeat prompt caching.
 */
export const allTools: AnyToolDefinition[] = [
  addStockTool,
  checkStockTool,
  recordSaleTool,
  recordPaymentTool,
  checkBalanceTool,
  undoLastTool,
  runReportTool,
  sendInvoiceTool,
  renameBusinessTool,
  setCostPriceTool,
];
