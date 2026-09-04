import { beforeEach, describe, expect, it } from 'vitest';
import { renameBusinessTool } from '../src/agent/tools/business.js';
import { executeTool, type ToolContext } from '../src/agent/tools/registry.js';
import { runReportTool } from '../src/agent/tools/report.js';
import type { BusinessRecord } from '../src/store.js';
import { InMemoryStore, silentLogger } from './fakes.js';

const tools = [renameBusinessTool, runReportTool];

describe('rename_business', () => {
  let store: InMemoryStore;
  let business: BusinessRecord;
  let ctx: ToolContext;

  const call = (name: string, args: unknown) =>
    executeTool(tools, ctx, { id: 'c1', name, argumentsJson: JSON.stringify(args) });
  const display = (out: { value?: unknown }) => (out.value as { display: string }).display;

  beforeEach(async () => {
    store = new InMemoryStore();
    business = await store.createBusiness('2348031234567');
    await store.setBusinessName(business.id, 'Mama Chika Stores');
    business.name = 'Mama Chika Stores';
    ctx = { business, store, logger: silentLogger };
  });

  it('corrects a name typed wrong during onboarding', async () => {
    // Onboarding only runs while name is null, so without this the typo is
    // permanent and shows up on every reply and every invoice.
    const out = await call('rename_business', { name: 'Mama Chika Ventures' });

    expect(display(out)).toBe("Noted, I'll call it Mama Chika Ventures from now on.");
    expect(store.businesses[0]?.name).toBe('Mama Chika Ventures');
    expect(out.value).toMatchObject({ previous: 'Mama Chika Stores' });
  });

  it('updates the name used for the rest of the same turn', async () => {
    await call('rename_business', { name: 'Chika Provisions' });
    // A later tool in the same turn must not see the stale name.
    expect(ctx.business.name).toBe('Chika Provisions');
  });

  it('tidies whitespace the way onboarding does', async () => {
    await call('rename_business', { name: '  Chika   Provisions  ' });
    expect(store.businesses[0]?.name).toBe('Chika Provisions');
  });

  it('rejects something that is not a name, and asks', async () => {
    const out = await call('rename_business', { name: '12345' });

    expect(out.value).toMatchObject({ ok: false });
    expect(display(out)).toContain('What should I call it?');
    expect(store.businesses[0]?.name).toBe('Mama Chika Stores'); // untouched
  });

  it('rejects an empty name at the schema, before it reaches the tool', async () => {
    const out = await call('rename_business', { name: '' });
    expect(out.isError).toBe(true);
    expect(store.businesses[0]?.name).toBe('Mama Chika Stores');
  });

  it('never renames another business', async () => {
    const other = await store.createBusiness('2349099999999');
    await store.setBusinessName(other.id, 'Shop B');

    await call('rename_business', { name: 'Renamed' });

    expect(store.businesses.find((b) => b.id === other.id)?.name).toBe('Shop B');
  });

  it('is logged like every other tool call', async () => {
    await call('rename_business', { name: 'Chika Provisions' });

    expect(store.toolCalls).toHaveLength(1);
    expect(store.toolCalls[0]).toMatchObject({
      toolName: 'rename_business',
      success: true,
      businessId: business.id,
    });
  });
});
