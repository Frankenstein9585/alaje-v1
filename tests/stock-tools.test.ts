import { beforeEach, describe, expect, it } from 'vitest';
import { addStockTool, checkStockTool, recordSaleTool } from '../src/agent/tools/stock.js';
import { executeTool, type ToolContext } from '../src/agent/tools/registry.js';
import type { BusinessRecord } from '../src/store.js';
import { InMemoryStore, silentLogger } from './fakes.js';

const business: BusinessRecord = {
  id: 'biz-1',
  whatsappNumber: '2348031234567',
  name: 'Mama Chika Stores',
  createdAt: new Date(),
};

const tools = [addStockTool, checkStockTool, recordSaleTool];

describe('stock tools', () => {
  let store: InMemoryStore;
  let ctx: ToolContext;

  const call = (name: string, args: unknown) =>
    executeTool(tools, ctx, { id: 'c1', name, argumentsJson: JSON.stringify(args) });

  beforeEach(() => {
    store = new InMemoryStore();
    ctx = { business, store, logger: silentLogger };
  });

  describe('add_stock', () => {
    it('creates a new product and sets the stock', async () => {
      const out = await call('add_stock', {
        product: 'Indomie',
        quantity: 20,
        unit: 'carton',
        low_stock_threshold: 3,
      });

      expect(out.isError).toBe(false);
      expect(store.products[0]).toMatchObject({
        name: 'Indomie',
        stockQty: 20,
        unit: 'carton',
        lowStockThreshold: 3,
      });
      expect(out.value).toMatchObject({
        display: 'Added 20 cartons of Indomie. Now 20 cartons in stock.',
      });
    });

    it('adds to an existing product rather than creating a second row', async () => {
      await call('add_stock', { product: 'Indomie', quantity: 20, unit: 'carton' });
      // Different casing and a plural: the same product to a shop owner.
      await call('add_stock', { product: 'indomies', quantity: 5 });

      expect(store.products).toHaveLength(1);
      expect(store.products[0]?.stockQty).toBe(25);
    });

    it('rejects a zero or negative quantity', async () => {
      const out = await call('add_stock', { product: 'Indomie', quantity: 0 });
      expect(out.isError).toBe(true);
      expect(store.products).toHaveLength(0);
    });
  });

  describe('check_stock', () => {
    it('reports a single product', async () => {
      await call('add_stock', { product: 'Indomie', quantity: 17, unit: 'carton' });
      const out = await call('check_stock', { product: 'Indomie' });

      expect(out.value).toMatchObject({ display: 'Indomie: 17 cartons left.' });
    });

    it('says so plainly for an unknown product, without erroring', async () => {
      const out = await call('check_stock', { product: 'Milo' });

      expect(out.isError).toBe(false);
      expect(out.value).toMatchObject({ found: false, display: 'No record of Milo yet.' });
    });

    it('lists everything when no product is named', async () => {
      await call('add_stock', { product: 'Indomie', quantity: 17, unit: 'carton' });
      await call('add_stock', { product: 'Peak Milk', quantity: 4, unit: 'tin' });

      const out = await call('check_stock', {});
      expect(out.value).toMatchObject({ display: 'Indomie: 17 cartons\nPeak Milk: 4 tins' });
    });

    it('handles an empty shop', async () => {
      const out = await call('check_stock', {});
      expect(out.value).toMatchObject({ display: 'Nothing in stock yet.' });
    });
  });

  describe('record_sale', () => {
    beforeEach(async () => {
      await call('add_stock', {
        product: 'Indomie',
        quantity: 20,
        unit: 'carton',
        low_stock_threshold: 3,
      });
    });

    it('logs the money and decrements the stock', async () => {
      const out = await call('record_sale', { product: 'Indomie', quantity: 3, amount: 42000 });

      expect(store.transactions).toHaveLength(1);
      expect(store.transactions[0]).toMatchObject({
        type: 'sale',
        amount: '42000.00',
        quantity: 3,
      });
      expect(store.products[0]?.stockQty).toBe(17);
      expect(out.value).toMatchObject({
        display: 'Sold 3 cartons of Indomie for ₦42,000. 17 cartons left.',
      });
    });

    it('warns about low stock inline, in the same reply', async () => {
      // Threshold is 3. Selling down to 2 must warn in this reply, never a
      // separate follow-up message.
      const out = await call('record_sale', { product: 'Indomie', quantity: 18, amount: 250000 });

      const display = (out.value as { display: string }).display;
      expect(display).toContain('2 cartons left.');
      expect(display).toContain("That's low.");
    });

    it('records the sale even when stock would go negative, and flags the count', async () => {
      // A real shop sells what is on the shelf. Refusing to record revenue
      // because our count is stale is the worse failure.
      const out = await call('record_sale', { product: 'Indomie', quantity: 25, amount: 300000 });

      expect(store.transactions).toHaveLength(1);
      expect(out.value).toMatchObject({ stock_went_negative: true });
      expect((out.value as { display: string }).display).toContain('my count was off');
    });

    it('starts tracking an unknown product instead of refusing', async () => {
      const out = await call('record_sale', { product: 'Milo', quantity: 2, amount: 3000 });

      expect(out.isError).toBe(false);
      expect(out.value).toMatchObject({ product_created: true });
      expect(store.transactions).toHaveLength(1);
    });

    it('formats naira without kobo for whole amounts', async () => {
      const out = await call('record_sale', { product: 'Indomie', quantity: 1, amount: 4200 });
      expect(out.value).toMatchObject({ amount_display: '₦4,200' });
    });

    it('rejects a non-numeric amount rather than guessing one', async () => {
      const out = await call('record_sale', {
        product: 'Indomie',
        quantity: 1,
        amount: 'plenty',
      });

      expect(out.isError).toBe(true);
      expect(store.transactions).toHaveLength(0);
      expect(store.products[0]?.stockQty).toBe(20); // untouched
    });
  });

  it('never touches another business, even given its product id', async () => {
    await call('add_stock', { product: 'Indomie', quantity: 20 });
    const productId = store.products[0]?.id;

    const otherCtx: ToolContext = {
      business: { ...business, id: 'biz-2', name: 'Shop B' },
      store,
      logger: silentLogger,
    };

    // Shop B sells "Indomie": it must create its own row, not touch biz-1's.
    await executeTool(tools, otherCtx, {
      id: 'c1',
      name: 'record_sale',
      argumentsJson: JSON.stringify({ product: 'Indomie', quantity: 5, amount: 1000 }),
    });

    const original = store.products.find((p) => p.id === productId);
    expect(original?.stockQty).toBe(20);
    expect(store.products).toHaveLength(2);
    expect(store.transactions.every((t) => t.businessId === 'biz-2')).toBe(true);
  });

  it('logs every call with arguments, result and success', async () => {
    await call('add_stock', { product: 'Indomie', quantity: 20 });
    await call('record_sale', { product: 'Indomie', quantity: 1, amount: 'bad' });

    expect(store.toolCalls).toHaveLength(2);
    expect(store.toolCalls[0]).toMatchObject({ toolName: 'add_stock', success: true });
    expect(store.toolCalls[1]).toMatchObject({ toolName: 'record_sale', success: false });
    expect(store.toolCalls.every((c) => c.businessId === 'biz-1')).toBe(true);
  });
});
