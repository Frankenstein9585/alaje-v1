import { beforeEach, describe, expect, it } from 'vitest';
import { WELCOME_MESSAGE } from '../src/businesses/onboarding.js';
import { handleInboundMessage, type HandlerDeps } from '../src/handler.js';
import {
  InMemoryStore,
  ScriptedLlmClient,
  SpySender,
  silentLogger,
  textMessage,
  textResponse,
} from './fakes.js';

describe('handleInboundMessage', () => {
  let store: InMemoryStore;
  let sender: SpySender;
  let llm: ScriptedLlmClient;
  let deps: HandlerDeps;

  beforeEach(() => {
    store = new InMemoryStore();
    sender = new SpySender();
    // Enough queued replies for any single test's agent turns.
    llm = new ScriptedLlmClient(
      ...Array.from({ length: 5 }, () => textResponse('Got it.')),
    );
    deps = { store, sender, logger: silentLogger, llm, tools: [], maxIterations: 3, historyTurns: 10 };
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

  it('reaches the agent scoped to its own business right after onboarding', async () => {
    const from = '2348031234567';
    await handleInboundMessage(deps, textMessage({ from, text: 'hi' }));
    await handleInboundMessage(deps, textMessage({ from, text: 'Mama Chika Stores' }));
    await handleInboundMessage(deps, textMessage({ from, text: 'sold 3 cartons' }));

    // Onboarding turns never reach the model; only the third message does.
    expect(llm.requests).toHaveLength(1);
    expect(llm.requests[0]?.system).toContain('Mama Chika Stores');
    expect(llm.requests[0]?.messages.at(-1)).toEqual({
      role: 'user',
      content: 'sold 3 cartons',
    });
    expect(sender.sent.at(-1)?.body).toBe('Got it.');
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

  it('acknowledges every message it acts on', async () => {
    // Read receipt + typing indicator. An agent turn takes seconds and silence
    // on WhatsApp reads as broken.
    const message = textMessage({ id: 'wamid.ack', text: 'hi' });
    await handleInboundMessage(deps, message);
    expect(sender.acknowledged).toEqual(['wamid.ack']);
  });

  it('does not acknowledge a duplicate', async () => {
    const message = textMessage({ id: 'wamid.dup', text: 'hi' });
    await handleInboundMessage(deps, message);
    await handleInboundMessage(deps, message);
    expect(sender.acknowledged).toEqual(['wamid.dup']);
  });

  it('tells the owner when it cannot handle a voice note', async () => {
    const from = '2348031234567';
    await handleInboundMessage(deps, textMessage({ from, text: 'hi' }));
    await handleInboundMessage(deps, textMessage({ from, text: 'Mama Chika' }));

    await handleInboundMessage(deps, {
      ...textMessage({ from }),
      type: 'audio',
      text: null,
      mediaId: 'media-1',
    });

    // Never silently dropped, and the reply says what to do instead.
    const last = sender.sent.at(-1)?.body ?? '';
    expect(last).toContain('voice note');
    expect(last).toContain('Type it out');
    expect(store.toolCalls).toHaveLength(0);
  });

  it('replays past turns so a follow-up message makes sense', async () => {
    const from = '2348031234567';
    await handleInboundMessage(deps, textMessage({ from, text: 'hi' }));
    await handleInboundMessage(deps, textMessage({ from, text: 'Mama Chika' }));
    await handleInboundMessage(deps, textMessage({ from, text: 'sold 3 cartons' }));
    await handleInboundMessage(deps, textMessage({ from, text: 'undo that' }));

    // The second agent turn sees the first exchange, so "undo that" has a
    // referent instead of arriving with no context.
    expect(llm.requests[1]?.messages).toEqual([
      { role: 'user', content: 'sold 3 cartons' },
      { role: 'assistant', content: 'Got it.' },
      { role: 'user', content: 'undo that' },
    ]);
  });

  it('does not record onboarding turns as conversation history', async () => {
    const from = '2348031234567';
    await handleInboundMessage(deps, textMessage({ from, text: 'hi' }));
    await handleInboundMessage(deps, textMessage({ from, text: 'Mama Chika' }));

    expect(store.messages).toHaveLength(0);
  });

  it('keeps two businesses separate', async () => {
    await handleInboundMessage(deps, textMessage({ from: '2348031234567', text: 'hi' }));
    await handleInboundMessage(deps, textMessage({ from: '2348031234567', text: 'Shop A' }));
    await handleInboundMessage(deps, textMessage({ from: '2349099999999', text: 'hi' }));
    await handleInboundMessage(deps, textMessage({ from: '2349099999999', text: 'Shop B' }));

    await handleInboundMessage(deps, textMessage({ from: '2349099999999', text: 'sold 3' }));

    // The agent is told about Shop B and nothing about Shop A.
    expect(llm.requests).toHaveLength(1);
    expect(llm.requests[0]?.system).toContain('Shop B');
    expect(llm.requests[0]?.system).not.toContain('Shop A');
  });
});
