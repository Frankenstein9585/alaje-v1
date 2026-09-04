import { beforeEach, describe, expect, it } from 'vitest';
import { checkBalanceTool, recordPaymentTool } from '../src/agent/tools/customers.js';
import { executeTool, type ToolContext } from '../src/agent/tools/registry.js';
import { addStockTool, checkStockTool, recordSaleTool } from '../src/agent/tools/stock.js';
import { undoLastTool } from '../src/agent/tools/undo.js';
import type { BusinessRecord } from '../src/store.js';
import { InMemoryStore, silentLogger } from './fakes.js';

const business: BusinessRecord = {
  id: 'biz-1',
  whatsappNumber: '2348031234567',
  name: 'Mama Chika Stores',
  createdAt: new Date(),
};

const tools = [
  addStockTool,
  checkStockTool,
  recordSaleTool,
  recordPaymentTool,
  checkBalanceTool,
  undoLastTool,
];

describe('undo_last', () => {
  let store: InMemoryStore;
  let ctx: ToolContext;

  const call = (name: string, args: unknown = {}) =>
    executeTool(tools, ctx, { id: 'c1', name, argumentsJson: JSON.stringify(args) });
  const display = (out: { value?: unknown }) => (out.value as { display: string }).display;

  beforeEach(async () => {
    store = new InMemoryStore();
    ctx = { business, store, logger: silentLogger };
    await call('add_stock', { product: 'Indomie', quantity: 20, unit: 'carton' });
  });

  it('reverses a sale and puts the stock back', async () => {
    await call('record_sale', { product: 'Indomie', quantity: 3, amount: 42000 });
    expect(store.products[0]?.stockQty).toBe(17);

    const out = await call('undo_last');

    expect(display(out)).toBe(
      'Undone. That sale of ₦42,000 no longer counts. 3 cartons of Indomie back in stock.',
    );
    expect(store.products[0]?.stockQty).toBe(20);
  });

  it('stops the voided sale counting toward a balance', async () => {
    // The reason void exists: re-recording a corrected amount would double
    // count instead of replacing.
    await call('record_sale', { product: 'Indomie', quantity: 3, amount: 42000, customer: 'Chika' });
    await call('undo_last');
    await call('record_sale', { product: 'Indomie', quantity: 3, amount: 4200, customer: 'Chika' });

    const balance = await call('check_balance', { customer: 'Chika' });
    expect(display(balance)).toBe('Chika owes ₦4,200.');
  });

  it('voids both halves of a paid-up-front sale', async () => {
    await call('record_sale', {
      product: 'Indomie',
      quantity: 3,
      amount: 42000,
      customer: 'Chika',
      paid: true,
    });

    await call('undo_last');

    // Voiding only one half would leave a phantom debt or a phantom credit.
    expect(store.transactions.every((t) => t.voidedAt !== null)).toBe(true);
    const balance = await call('check_balance', { customer: 'Chika' });
    expect(display(balance)).toBe('Chika is settled up.');
  });

  it('reverses a payment', async () => {
    await call('record_sale', { product: 'Indomie', quantity: 1, amount: 5000, customer: 'Ada' });
    await call('record_payment', { customer: 'Ada', amount: 5000 });

    const out = await call('undo_last');
    expect(display(out)).toBe('Undone. That payment of ₦5,000 no longer counts.');

    const balance = await call('check_balance', { customer: 'Ada' });
    expect(display(balance)).toBe('Ada owes ₦5,000.');
  });

  it('undoes only the most recent entry', async () => {
    await call('record_sale', { product: 'Indomie', quantity: 1, amount: 1000 });
    await call('record_sale', { product: 'Indomie', quantity: 2, amount: 2000 });

    await call('undo_last');

    const live = store.transactions.filter((t) => t.voidedAt === null);
    expect(live).toHaveLength(1);
    expect(live[0]?.amount).toBe('1000.00');
  });

  it('can be called twice to undo two entries', async () => {
    await call('record_sale', { product: 'Indomie', quantity: 1, amount: 1000 });
    await call('record_sale', { product: 'Indomie', quantity: 2, amount: 2000 });

    await call('undo_last');
    await call('undo_last');

    expect(store.transactions.every((t) => t.voidedAt !== null)).toBe(true);
    expect(store.products[0]?.stockQty).toBe(20);
  });

  it('says so plainly when there is nothing to undo', async () => {
    const out = await call('undo_last');
    expect(out.isError).toBe(false);
    expect(display(out)).toBe("There's nothing to undo yet.");
  });

  it('never undoes another business entry', async () => {
    await call('record_sale', { product: 'Indomie', quantity: 3, amount: 42000 });

    const otherCtx: ToolContext = {
      business: { ...business, id: 'biz-2', name: 'Shop B' },
      store,
      logger: silentLogger,
    };
    const out = await executeTool(tools, otherCtx, {
      id: 'c1',
      name: 'undo_last',
      argumentsJson: '{}',
    });

    expect(display(out)).toBe("There's nothing to undo yet.");
    expect(store.transactions[0]?.voidedAt).toBeNull();
  });
});
