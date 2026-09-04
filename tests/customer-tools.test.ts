import { beforeEach, describe, expect, it } from 'vitest';
import { checkBalanceTool, recordPaymentTool } from '../src/agent/tools/customers.js';
import { executeTool, type ToolContext } from '../src/agent/tools/registry.js';
import { addStockTool, recordSaleTool } from '../src/agent/tools/stock.js';
import type { BusinessRecord } from '../src/store.js';
import { InMemoryStore, silentLogger } from './fakes.js';

const business: BusinessRecord = {
  id: 'biz-1',
  whatsappNumber: '2348031234567',
  name: 'Mama Chika Stores',
  createdAt: new Date(),
};

const tools = [addStockTool, recordSaleTool, recordPaymentTool, checkBalanceTool];

describe('customer tools', () => {
  let store: InMemoryStore;
  let ctx: ToolContext;

  const call = (name: string, args: unknown) =>
    executeTool(tools, ctx, { id: 'c1', name, argumentsJson: JSON.stringify(args) });
  const display = (out: { value?: unknown }) => (out.value as { display: string }).display;

  beforeEach(async () => {
    store = new InMemoryStore();
    ctx = { business, store, logger: silentLogger };
    await call('add_stock', { product: 'Indomie', quantity: 20, unit: 'carton' });
  });

  it('records the customer on a sale and reports what they owe', async () => {
    // The canonical example from the pitch. The customer must not be dropped.
    const out = await call('record_sale', {
      product: 'Indomie',
      quantity: 3,
      amount: 42000,
      customer: 'Chika',
    });

    expect(store.customers).toHaveLength(1);
    expect(store.customers[0]?.name).toBe('Chika');
    expect(store.transactions[0]?.customerId).toBe(store.customers[0]?.id);
    expect(display(out)).toBe(
      'Sold 3 cartons of Indomie to Chika for ₦42,000. 17 cartons left. Chika owes ₦42,000.',
    );
  });

  it('records a sale as owed, never as paid', async () => {
    // A live model once inferred payment from a message that only described a
    // sale, inventing money that never arrived. record_sale takes no "paid"
    // flag: money in is its own event.
    await call('record_sale', { product: 'Indomie', quantity: 3, amount: 42000, customer: 'Chika' });

    expect(store.transactions.map((t) => t.type)).toEqual(['sale']);
    const balance = await call('check_balance', { customer: 'Chika' });
    expect(display(balance)).toBe('Chika owes ₦42,000.');
  });

  it('settles when the payment is recorded as its own event', async () => {
    await call('record_sale', { product: 'Indomie', quantity: 3, amount: 42000, customer: 'Chika' });
    const out = await call('record_payment', { customer: 'Chika', amount: 42000 });

    expect(store.transactions.map((t) => t.type)).toEqual(['sale', 'payment']);
    expect(display(out)).toContain('Chika is settled up.');
  });

  it('reduces the balance when a payment comes in', async () => {
    await call('record_sale', { product: 'Indomie', quantity: 3, amount: 42000, customer: 'Chika' });
    const out = await call('record_payment', { customer: 'Chika', amount: 20000 });

    expect(display(out)).toBe('Received ₦20,000 from Chika. Chika owes ₦22,000.');
  });

  it('settles a balance exactly', async () => {
    await call('record_sale', { product: 'Indomie', quantity: 3, amount: 42000, customer: 'Chika' });
    const out = await call('record_payment', { customer: 'Chika', amount: 42000 });

    expect(display(out)).toContain('Chika is settled up.');
  });

  it('reports an overpayment as credit rather than negative debt', async () => {
    await call('record_sale', { product: 'Indomie', quantity: 1, amount: 5000, customer: 'Chika' });
    const out = await call('record_payment', { customer: 'Chika', amount: 8000 });

    expect(display(out)).toContain('₦3,000 in credit');
  });

  it('matches a customer regardless of casing', async () => {
    await call('record_sale', { product: 'Indomie', quantity: 1, amount: 5000, customer: 'Chika' });
    await call('record_payment', { customer: 'chika', amount: 5000 });

    expect(store.customers).toHaveLength(1);
  });

  it('keeps money arithmetic exact across many small amounts', async () => {
    // Floats would drift here. Balances are summed in integer kobo.
    for (let i = 0; i < 10; i++) {
      await call('record_sale', {
        product: 'Indomie',
        quantity: 1,
        amount: 0.1,
        customer: 'Chika',
      });
    }
    const out = await call('check_balance', { customer: 'Chika' });
    expect((out.value as { balance: string }).balance).toBe('1.00');
  });

  describe('check_balance', () => {
    it('lists everyone who owes, largest first', async () => {
      await call('record_sale', { product: 'Indomie', quantity: 1, amount: 5000, customer: 'Ada' });
      await call('record_sale', { product: 'Indomie', quantity: 1, amount: 9000, customer: 'Chika' });

      const out = await call('check_balance', {});
      expect(display(out)).toBe('Chika: ₦9,000\nAda: ₦5,000');
    });

    it('excludes settled customers from the list', async () => {
      await call('record_sale', { product: 'Indomie', quantity: 1, amount: 5000, customer: 'Ada' });
      await call('record_payment', { customer: 'Ada', amount: 5000 });

      const out = await call('check_balance', {});
      expect(display(out)).toBe('Nobody owes you anything right now.');
    });

    it('says so plainly for an unknown customer, without erroring', async () => {
      const out = await call('check_balance', { customer: 'Nobody' });
      expect(out.isError).toBe(false);
      expect(display(out)).toBe('No record of Nobody yet.');
    });
  });

  it('never reads another business customers', async () => {
    await call('record_sale', { product: 'Indomie', quantity: 1, amount: 5000, customer: 'Chika' });

    const otherCtx: ToolContext = {
      business: { ...business, id: 'biz-2', name: 'Shop B' },
      store,
      logger: silentLogger,
    };
    const out = await executeTool(tools, otherCtx, {
      id: 'c1',
      name: 'check_balance',
      argumentsJson: JSON.stringify({}),
    });

    expect(display(out)).toBe('Nobody owes you anything right now.');
  });

  it('does not count a voided sale toward a balance', async () => {
    await call('record_sale', { product: 'Indomie', quantity: 3, amount: 42000, customer: 'Chika' });
    const sale = store.transactions.find((t) => t.type === 'sale');
    await store.voidTransaction(business.id, sale!.id);

    const out = await call('check_balance', { customer: 'Chika' });
    expect(display(out)).toContain('settled up');
  });
});
