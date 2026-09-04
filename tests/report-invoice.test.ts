import { beforeEach, describe, expect, it } from 'vitest';
import { checkBalanceTool, recordPaymentTool } from '../src/agent/tools/customers.js';
import { sendInvoiceTool } from '../src/agent/tools/invoice.js';
import { executeTool, type ToolContext } from '../src/agent/tools/registry.js';
import { runReportTool } from '../src/agent/tools/report.js';
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

    it('sums sales for the period', async () => {
      await call('record_sale', { product: 'Indomie', quantity: 3, amount: 42000 });
      await call('record_sale', { product: 'Indomie', quantity: 1, amount: 8000 });

      const out = await call('run_report', { period: 'today' });
      expect(display(out)).toBe('Today:\nSales: ₦50,000 from 2 sales');
      expect(out.value).toMatchObject({ revenue: '50000.00', sale_count: 2 });
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
