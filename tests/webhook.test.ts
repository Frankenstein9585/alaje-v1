import { createHmac } from 'node:crypto';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { WELCOME_MESSAGE } from '../src/businesses/onboarding.js';
import { InMemoryStore, ScriptedLlmClient, SpySender, silentLogger, textResponse } from './fakes.js';

const APP_SECRET = 'test-app-secret';
const VERIFY_TOKEN = 'test-verify-token';

function payload(messageId: string, from = '2348031234567', text = 'hi') {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '123',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '15550000000', phone_number_id: '999' },
              messages: [
                { from, id: messageId, timestamp: '1730000000', type: 'text', text: { body: text } },
              ],
            },
          },
        ],
      },
    ],
  };
}

describe('webhook', () => {
  let store: InMemoryStore;
  let sender: SpySender;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    store = new InMemoryStore();
    sender = new SpySender();
    app = createApp({
      store,
      sender,
      logger: silentLogger,
      llm: new ScriptedLlmClient(textResponse('Got it.'), textResponse('Got it.')),
      tools: [],
      maxIterations: 3,
      historyTurns: 10,
      verifyToken: VERIFY_TOKEN,
      appSecret: APP_SECRET,
    });
  });

  const post = (body: object, secret = APP_SECRET) => {
    const raw = JSON.stringify(body);
    const signature = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
    return request(app)
      .post('/webhook')
      .set('content-type', 'application/json')
      .set('x-hub-signature-256', signature)
      .send(raw);
  };

  it('completes Meta\'s verification handshake', async () => {
    const res = await request(app).get('/webhook').query({
      'hub.mode': 'subscribe',
      'hub.verify_token': VERIFY_TOKEN,
      'hub.challenge': 'challenge-value',
    });
    expect(res.status).toBe(200);
    expect(res.text).toBe('challenge-value');
  });

  it('rejects the handshake with a wrong verify token', async () => {
    const res = await request(app)
      .get('/webhook')
      .query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'nope', 'hub.challenge': 'x' });
    expect(res.status).toBe(403);
  });

  it('rejects an unsigned or wrongly-signed payload without side effects', async () => {
    const unsigned = await request(app).post('/webhook').send(payload('wamid.1'));
    expect(unsigned.status).toBe(401);

    const wrong = await post(payload('wamid.1'), 'not-the-secret');
    expect(wrong.status).toBe(401);

    expect(store.businesses).toHaveLength(0);
    expect(sender.sent).toHaveLength(0);
  });

  it('onboards a new number on a signed payload', async () => {
    const res = await post(payload('wamid.1'));
    expect(res.status).toBe(200);
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]?.body).toBe(WELCOME_MESSAGE);
  });

  it('replies exactly once when the same payload is delivered twice', async () => {
    // Phase 1 acceptance criterion.
    await post(payload('wamid.dup'));
    await post(payload('wamid.dup'));

    expect(sender.sent).toHaveLength(1);
    expect(store.businesses).toHaveLength(1);
  });

  it('ignores delivery-status callbacks', async () => {
    const statusOnly = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: '123',
          changes: [
            {
              field: 'messages',
              value: { statuses: [{ id: 'wamid.1', status: 'delivered' }] },
            },
          ],
        },
      ],
    };
    const res = await post(statusOnly);
    expect(res.status).toBe(200);
    expect(sender.sent).toHaveLength(0);
  });
});
