import { beforeEach, describe, expect, it } from 'vitest';
import { checkBalanceTool, recordPaymentTool } from '../src/agent/tools/customers.js';
import { sendInvoiceTool } from '../src/agent/tools/invoice.js';
import { executeTool, type ToolContext } from '../src/agent/tools/registry.js';
import { runReportTool } from '../src/agent/tools/report.js';
import { updateProductTool } from '../src/agent/tools/product.js';
import { addStockTool, recordSaleTool } from '../src/agent/tools/stock.js';
import { undoLastTool } from '../src/agent/tools/undo.js';
import { periodRange } from '../src/period.js';
import type { BusinessRecord } from '../src/store.js';
import { InMemoryStore, SpySender, silentLogger } from './fakes.js';

const business: BusinessRecord = {
  id: 'biz-1',
  whatsappNumber: '2348031234567',
  name: 'Mama Chika Stores',
  createdAt: new Date(),
};

const tools = [
  addStockTool,
  recordSaleTool,
  recordPaymentTool,
  checkBalanceTool,
  undoLastTool,
  runReportTool,
  sendInvoiceTool,
  updateProductTool,
];

describe('periodRange', () => {
  it('starts today at Lagos midnight, not UTC midnight', () => {
    // 00:30 Lagos on 4 Sept is 23:30 UTC on 3 Sept. A UTC-based day boundary
    // would push the evening's sales into tomorrow's report.
    const now = new Date('2026-09-03T23:30:00Z');
    const { from, to } = periodRange('today', now);

    expect(from.toISOString()).toBe('2026-09-03T23:00:00.000Z');
    expect(to.toISOString()).toBe('2026-09-04T23:00:00.000Z');
    expect(from.getTime()).toBeLessThanOrEqual(now.getTime());
  });

  it('treats week as a rolling seven days', () => {
    const { from, to, label } = periodRange('week', new Date('2026-09-04T12:00:00Z'));
    expect(label).toBe('Last 7 days');
    expect((to.getTime() - from.getTime()) / 86_400_000).toBe(7);
  });

  it('starts month at the first of the month in Lagos', () => {
    const { from, label } = periodRange('month', new Date('2026-09-04T12:00:00Z'));
    expect(from.toISOString()).toBe('2026-08-31T23:00:00.000Z');
    expect(label).toBe('September');
  });
});

describe('run_report and send_invoice', () => {
  let store: InMemoryStore;
  let sender: SpySender;
  let ctx: ToolContext;

  const call = (name: string, args: unknown = {}) =>
    executeTool(tools, ctx, { id: 'c1', name, argumentsJson: JSON.stringify(args) });
  const display = (out: { value?: unknown }) => (out.value as { display: string }).display;

  beforeEach(async () => {
    store = new InMemoryStore();
    sender = new SpySender();
    ctx = {
      business,
      store,
      logger: silentLogger,
      channel: { sender, to: '2348031234567' },
    };
    await call('add_stock', { product: 'Indomie', quantity: 50, unit: 'carton' });
  });

  describe('run_report', () => {
    it('reports nothing recorded on an empty day', async () => {
      const out = await call('run_report', { period: 'today' });
      expect(display(out)).toBe('Today: nothing recorded yet.');
    });

    it('sums sales, and says plainly that it cannot work out profit', async () => {
      // No cost price has been given, so profit is unknowable. Naming the gap
      // beats quoting a number that only counts some of the costs.
      await call('record_sale', { product: 'Indomie', quantity: 3, amount: 42000 });
      await call('record_sale', { product: 'Indomie', quantity: 1, amount: 8000 });

      const out = await call('run_report', { period: 'today' });
      expect(display(out)).toContain('Sales: ₦50,000 from 2 sales');
      expect(display(out)).toContain("I don't know what you paid for Indomie");
      expect(out.value).toMatchObject({ revenue: '50000.00', sale_count: 2, profit: null });
    });

    it('reports real profit once the cost is known', async () => {
      await call('add_stock', { product: 'Milo', quantity: 10, unit: 'tin', unit_cost: 1500 });
      await call('record_sale', { product: 'Milo', quantity: 4, amount: 8000 });

      const out = await call('run_report', { period: 'today' });
      // 8,000 revenue less 4 x 1,500 cost.
      expect(display(out)).toContain('Cost of goods: ₦6,000');
      expect(display(out)).toContain('Profit: ₦2,000');
      expect(out.value).toMatchObject({ profit: '2000.00' });
    });

    it('withholds profit when only some sales have a known cost', async () => {
      await call('add_stock', { product: 'Milo', quantity: 10, unit: 'tin', unit_cost: 1500 });
      await call('record_sale', { product: 'Milo', quantity: 4, amount: 8000 });
      await call('record_sale', { product: 'Indomie', quantity: 1, amount: 9000 });

      const out = await call('run_report', { period: 'today' });
      expect(out.value).toMatchObject({ profit: null, products_missing_cost: 1 });
      expect(display(out)).toContain('Indomie');
      expect(display(out)).not.toContain('Profit:');
    });

    it('does not let a later restock rewrite past profit', async () => {
      // The cost is snapshotted onto the sale. Buying the next batch dearer
      // must not retroactively shrink a margin the owner already earned.
      await call('add_stock', { product: 'Milo', quantity: 10, unit: 'tin', unit_cost: 1000 });
      await call('record_sale', { product: 'Milo', quantity: 2, amount: 4000 });

      await call('add_stock', { product: 'Milo', quantity: 10, unit_cost: 1800 });

      const out = await call('run_report', { period: 'today' });
      expect(out.value).toMatchObject({ cost_of_goods: '2000.00', profit: '2000.00' });
    });

    it('picks up a cost given after the fact, for sales from then on', async () => {
      await call('add_stock', { product: 'Milo', quantity: 10, unit: 'tin' });
      const set = await call('update_product', { product: 'Milo', unit_cost: 1500 });
      expect(display(set)).toContain('costs you ₦1,500 per tin');

      await call('record_sale', { product: 'Milo', quantity: 2, amount: 5000 });

      const out = await call('run_report', { period: 'today' });
      expect(out.value).toMatchObject({ profit: '2000.00' });
    });

    it('will not set a cost for a product it has never seen', async () => {
      const out = await call('update_product', { product: 'Garri', unit_cost: 900 });
      expect(out.isError).toBe(false);
      expect(display(out)).toContain('No record of Garri yet');
    });

    it('excludes a voided sale from the numbers', async () => {
      // The whole point of voiding: the report must not count it.
      await call('record_sale', { product: 'Indomie', quantity: 3, amount: 42000 });
      await call('undo_last');
      await call('record_sale', { product: 'Indomie', quantity: 3, amount: 4200 });

      const out = await call('run_report', { period: 'today' });
      expect(out.value).toMatchObject({ revenue: '4200.00', sale_count: 1 });
    });

    it('does not count a payment as revenue', async () => {
      // The sale was already counted when it happened. Counting the payment
      // too would double the day.
      await call('record_sale', { product: 'Indomie', quantity: 3, amount: 42000, customer: 'Chika' });
      await call('record_payment', { customer: 'Chika', amount: 42000 });

      const out = await call('run_report', { period: 'today' });
      expect(out.value).toMatchObject({ revenue: '42000.00', sale_count: 1 });
    });

    it('rejects a period it does not support', async () => {
      const out = await call('run_report', { period: 'year' });
      expect(out.isError).toBe(true);
    });

    it('never counts another business sales', async () => {
      await call('record_sale', { product: 'Indomie', quantity: 3, amount: 42000 });

      const otherCtx: ToolContext = { business: { ...business, id: 'biz-2' }, store, logger: silentLogger };
      const out = await executeTool(tools, otherCtx, {
        id: 'c1',
        name: 'run_report',
        argumentsJson: JSON.stringify({ period: 'today' }),
      });
      expect(display(out)).toBe('Today: nothing recorded yet.');
    });
  });

  describe('send_invoice', () => {
    beforeEach(async () => {
      await call('record_sale', {
        product: 'Indomie',
        quantity: 3,
        amount: 42000,
        customer: 'Chika',
      });
    });

    it('sends a PDF to the owner', async () => {
      const out = await call('send_invoice', { customer: 'Chika' });

      expect(sender.documents).toHaveLength(1);
      const [doc] = sender.documents;
      expect(doc?.to).toBe('2348031234567'); // the owner, who forwards it
      expect(doc?.filename).toMatch(/^INV-\d{8}-[A-Z0-9]{4}\.pdf$/);
      expect(doc?.size).toBeGreaterThan(500); // a real PDF, not an empty buffer
      expect(display(out)).toBe('Sent the invoice for Chika as a PDF.');
    });

    it('produces a valid PDF', async () => {
      await call('send_invoice', { customer: 'Chika' });
      // Nothing here renders the PDF, so at minimum assert it is one.
      expect(sender.documents[0]?.size).toBeGreaterThan(500);
    });

    it('falls back to text when the PDF cannot be delivered', async () => {
      // A missing attachment is a disappointment; a missing invoice is a
      // broken feature.
      sender.failDocuments = true;
      const out = await call('send_invoice', { customer: 'Chika' });

      expect(out.isError).toBe(false);
      expect(out.value).toMatchObject({ fell_back_to_text: true });
      const text = display(out);
      expect(text).toContain('Mama Chika Stores');
      expect(text).toContain('3 cartons Indomie');
      expect(text).toContain('Balance due: ₦42,000');
    });

    it('reflects payments already made', async () => {
      await call('record_payment', { customer: 'Chika', amount: 20000 });
      sender.failDocuments = true;

      const out = await call('send_invoice', { customer: 'Chika' });
      const text = display(out);
      expect(text).toContain('Total: ₦42,000');
      expect(text).toContain('Paid: ₦20,000');
      expect(text).toContain('Balance due: ₦22,000');
    });

    it('will not invoice a customer whose only sale was voided', async () => {
      await call('undo_last');

      const out = await call('send_invoice', { customer: 'Chika' });

      // Better than a blank PDF: there is genuinely nothing to bill for.
      expect(display(out)).toBe("Nothing recorded for Chika yet, so there's nothing to invoice.");
      expect(sender.documents).toHaveLength(0);
    });

    it('excludes a voided sale but still invoices the rest', async () => {
      await call('record_sale', {
        product: 'Indomie',
        quantity: 1,
        amount: 9000,
        customer: 'Chika',
      });
      await call('undo_last'); // reverses the 9,000, leaving the 42,000
      sender.failDocuments = true;

      const out = await call('send_invoice', { customer: 'Chika' });
      const text = display(out);
      expect(text).toContain('Balance due: ₦42,000');
      expect(text).not.toContain('9,000');
    });

    it('says so plainly for an unknown customer', async () => {
      const out = await call('send_invoice', { customer: 'Nobody' });
      expect(out.isError).toBe(false);
      expect(display(out)).toBe("No record of Nobody yet, so there's nothing to invoice.");
      expect(sender.documents).toHaveLength(0);
    });

    it('never invoices from another business data', async () => {
      const otherCtx: ToolContext = {
        business: { ...business, id: 'biz-2', name: 'Shop B' },
        store,
        logger: silentLogger,
        channel: { sender, to: '2349099999999' },
      };
      const out = await executeTool(tools, otherCtx, {
        id: 'c1',
        name: 'send_invoice',
        argumentsJson: JSON.stringify({ customer: 'Chika' }),
      });

      expect(display(out)).toContain('No record of Chika yet');
      expect(sender.documents).toHaveLength(0);
    });
  });
});
