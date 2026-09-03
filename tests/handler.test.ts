import { beforeEach, describe, expect, it } from 'vitest';
import { WELCOME_MESSAGE } from '../src/businesses/onboarding.js';
import { handleInboundMessage, type HandlerDeps } from '../src/handler.js';
import { InMemoryStore, SpySender, silentLogger, textMessage } from './fakes.js';

describe('handleInboundMessage', () => {
  let store: InMemoryStore;
  let sender: SpySender;
  let deps: HandlerDeps;

  beforeEach(() => {
    store = new InMemoryStore();
    sender = new SpySender();
    deps = { store, sender, logger: silentLogger };
  });

  it('walks a brand new number through two-message onboarding', async () => {
    const from = '2348031234567';

    await handleInboundMessage(deps, textMessage({ from, text: 'hi' }));
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]?.body).toBe(WELCOME_MESSAGE);
    expect(store.businesses[0]?.name).toBeNull();

    await handleInboundMessage(deps, textMessage({ from, text: 'Mama Chika Stores' }));
    expect(store.businesses).toHaveLength(1);
    expect(store.businesses[0]?.name).toBe('Mama Chika Stores');
    expect(sender.sent[1]?.body).toContain('Mama Chika Stores');
  });

  it('reaches the stub tool scoped to its own business_id right after onboarding', async () => {
    const from = '2348031234567';
    await handleInboundMessage(deps, textMessage({ from, text: 'hi' }));
    await handleInboundMessage(deps, textMessage({ from, text: 'Mama Chika Stores' }));
    await handleInboundMessage(deps, textMessage({ from, text: 'sold 3 cartons' }));

    expect(store.toolCalls).toHaveLength(1);
    expect(store.toolCalls[0]?.toolName).toBe('stub');
    expect(store.toolCalls[0]?.success).toBe(true);
    expect(store.toolCalls[0]?.businessId).toBe(store.businesses[0]?.id);
  });

  it('produces exactly one reply when the same message id arrives twice', async () => {
    // Meta retries deliveries; a redelivery must be a no-op.
    const message = textMessage({ id: 'wamid.retry', text: 'hi' });

    await handleInboundMessage(deps, message);
    await handleInboundMessage(deps, message);

    expect(sender.sent).toHaveLength(1);
    expect(store.businesses).toHaveLength(1);
  });

  it('recognises a returning number whatever format it was stored in', async () => {
    // The business row is written from the international form WhatsApp sends;
    // a lookup keyed on the raw string would create a second business here.
    await handleInboundMessage(deps, textMessage({ from: '08031234567', text: 'hi' }));
    await handleInboundMessage(deps, textMessage({ from: '+2348031234567', text: 'Mama Chika' }));
    await handleInboundMessage(deps, textMessage({ from: '2348031234567', text: 'sold 3' }));

    expect(store.businesses).toHaveLength(1);
    expect(store.businesses[0]?.name).toBe('Mama Chika');
  });

  it('re-asks instead of dead-ending when the business name is unusable', async () => {
    const from = '2348031234567';
    await handleInboundMessage(deps, textMessage({ from, text: 'hi' }));
    await handleInboundMessage(deps, textMessage({ from, text: '   ' }));

    expect(store.businesses[0]?.name).toBeNull();
    expect(sender.sent[1]?.body).toContain('business');

    // Still recoverable — no fresh onboarding, no lost identity.
    await handleInboundMessage(deps, textMessage({ from, text: 'Mama Chika Stores' }));
    expect(store.businesses[0]?.name).toBe('Mama Chika Stores');
    expect(store.businesses).toHaveLength(1);
  });

  it('keeps two businesses separate', async () => {
    await handleInboundMessage(deps, textMessage({ from: '2348031234567', text: 'hi' }));
    await handleInboundMessage(deps, textMessage({ from: '2348031234567', text: 'Shop A' }));
    await handleInboundMessage(deps, textMessage({ from: '2349099999999', text: 'hi' }));
    await handleInboundMessage(deps, textMessage({ from: '2349099999999', text: 'Shop B' }));

    await handleInboundMessage(deps, textMessage({ from: '2349099999999', text: 'sold 3' }));

    const shopB = store.businesses.find((b) => b.name === 'Shop B');
    expect(store.toolCalls).toHaveLength(1);
    expect(store.toolCalls[0]?.businessId).toBe(shopB?.id);
  });
});
