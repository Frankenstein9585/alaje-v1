import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LlmError } from '../src/agent/llm.js';
import { OpenAiCompatClient, type FetchLike } from '../src/agent/openai-compat.js';
import { silentLogger } from './fakes.js';

const config = {
  baseUrl: 'https://gateway.example/api/v1/',
  model: 'test-model',
  apiKey: 'test-key',
  maxTokens: 2048,
  temperature: 0.2,
  timeoutMs: 5000,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function textReply(content: string) {
  return {
    model: 'test-model',
    choices: [{ message: { content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 100, completion_tokens: 20 },
  };
}

function toolReply(name: string, args: string, id = 'call_abc') {
  return {
    choices: [
      {
        message: {
          content: null,
          tool_calls: [{ id, type: 'function', function: { name, arguments: args } }],
        },
        finish_reason: 'tool_calls',
      },
    ],
  };
}

const baseRequest = {
  system: 'You are Alaje.',
  messages: [{ role: 'user' as const, content: 'sold 3 cartons for 42000' }],
  tools: [
    {
      name: 'record_sale',
      description: 'Record a sale',
      parameters: { type: 'object', properties: { amount: { type: 'number' } } },
    },
  ],
};

describe('OpenAiCompatClient', () => {
  let calls: Array<{ url: string; body: Record<string, unknown>; headers: Headers }>;

  function clientReturning(...responses: Array<Response | Error>) {
    const queue = [...responses];
    const fetchImpl: FetchLike = vi.fn(async (url, init) => {
      calls.push({
        url,
        body: JSON.parse(init.body as string),
        headers: new Headers(init.headers),
      });
      const next = queue.shift();
      if (next instanceof Error) throw next;
      if (!next) throw new Error('no queued response');
      return next;
    });
    return new OpenAiCompatClient(config, silentLogger, fetchImpl);
  }

  beforeEach(() => {
    calls = [];
  });

  it('sends system, messages and tools in the OpenAI shape', async () => {
    const client = clientReturning(jsonResponse(textReply('ok')));
    await client.complete(baseRequest);

    const [call] = calls;
    // Trailing slash on the base URL must not produce a double slash.
    expect(call?.url).toBe('https://gateway.example/api/v1/chat/completions');
    expect(call?.headers.get('authorization')).toBe('Bearer test-key');
    expect(call?.body.model).toBe('test-model');
    expect(call?.body.messages).toEqual([
      { role: 'system', content: 'You are Alaje.' },
      { role: 'user', content: 'sold 3 cartons for 42000' },
    ]);
    expect(call?.body.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'record_sale',
          description: 'Record a sale',
          parameters: { type: 'object', properties: { amount: { type: 'number' } } },
        },
      },
    ]);
    expect(call?.body.tool_choice).toBe('auto');
  });

  it('omits tools entirely when there are none', async () => {
    const client = clientReturning(jsonResponse(textReply('ok')));
    await client.complete({ ...baseRequest, tools: [] });

    expect(calls[0]?.body).not.toHaveProperty('tools');
    expect(calls[0]?.body).not.toHaveProperty('tool_choice');
  });

  it('parses a plain text reply', async () => {
    const client = clientReturning(jsonResponse(textReply('Logged it.')));
    const res = await client.complete(baseRequest);

    expect(res.text).toBe('Logged it.');
    expect(res.toolCalls).toEqual([]);
    expect(res.stopReason).toBe('end_turn');
    expect(res.usage).toEqual({ inputTokens: 100, outputTokens: 20 });
  });

  it('parses a tool call and leaves arguments unparsed', async () => {
    const client = clientReturning(
      jsonResponse(toolReply('record_sale', '{"amount":42000,"quantity":3}')),
    );
    const res = await client.complete(baseRequest);

    expect(res.stopReason).toBe('tool_use');
    expect(res.toolCalls).toEqual([
      { id: 'call_abc', name: 'record_sale', argumentsJson: '{"amount":42000,"quantity":3}' },
    ]);
    // The port hands back the raw string; parsing and validation belong to the
    // tool registry, not the transport.
    expect(typeof res.toolCalls[0]?.argumentsJson).toBe('string');
  });

  it('reports tool_use even when the gateway says finish_reason stop', async () => {
    // Several gateways do this. Believing finish_reason would drop the call.
    const client = clientReturning(
      jsonResponse({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                { id: 'c1', type: 'function', function: { name: 'check_stock', arguments: '{}' } },
              ],
            },
            finish_reason: 'stop',
          },
        ],
      }),
    );
    const res = await client.complete(baseRequest);
    expect(res.stopReason).toBe('tool_use');
    expect(res.toolCalls).toHaveLength(1);
  });

  it('synthesizes an id when the gateway omits one', async () => {
    const client = clientReturning(
      jsonResponse({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [{ type: 'function', function: { name: 'check_stock', arguments: '{}' } }],
            },
            finish_reason: 'tool_calls',
          },
        ],
      }),
    );
    const res = await client.complete(baseRequest);
    expect(res.toolCalls[0]?.id).toBe('call_0');
  });

  it('round-trips an assistant tool call and its result', async () => {
    const client = clientReturning(jsonResponse(textReply('done')));
    await client.complete({
      ...baseRequest,
      messages: [
        { role: 'user', content: 'sold 3' },
        {
          role: 'assistant',
          content: null,
          toolCalls: [{ id: 'call_1', name: 'record_sale', argumentsJson: '{"quantity":3}' }],
        },
        { role: 'tool', toolCallId: 'call_1', content: '{"ok":true}' },
      ],
    });

    expect(calls[0]?.body.messages).toEqual([
      { role: 'system', content: 'You are Alaje.' },
      { role: 'user', content: 'sold 3' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'record_sale', arguments: '{"quantity":3}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '{"ok":true}' },
    ]);
  });

  it('retries once on a 429 and succeeds', async () => {
    const client = clientReturning(
      jsonResponse({ error: 'rate limited' }, 429),
      jsonResponse(textReply('recovered')),
    );
    const res = await client.complete(baseRequest);

    expect(res.text).toBe('recovered');
    expect(calls).toHaveLength(2);
  });

  it('retries once on a network failure', async () => {
    const client = clientReturning(new Error('ECONNRESET'), jsonResponse(textReply('recovered')));
    const res = await client.complete(baseRequest);

    expect(res.text).toBe('recovered');
    expect(calls).toHaveLength(2);
  });

  it('does not retry a 401 and reports it as non-retryable', async () => {
    const client = clientReturning(jsonResponse({ error: 'bad key' }, 401));

    await expect(client.complete(baseRequest)).rejects.toMatchObject({
      name: 'LlmError',
      options: { status: 401, retryable: false },
    });
    expect(calls).toHaveLength(1);
  });

  it('gives up after one retry', async () => {
    const client = clientReturning(
      jsonResponse({ error: 'down' }, 503),
      jsonResponse({ error: 'still down' }, 503),
    );

    await expect(client.complete(baseRequest)).rejects.toBeInstanceOf(LlmError);
    expect(calls).toHaveLength(2);
  });

  it('treats a malformed body as retryable', async () => {
    const client = clientReturning(
      new Response('<html>gateway error</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
      jsonResponse(textReply('recovered')),
    );
    const res = await client.complete(baseRequest);
    expect(res.text).toBe('recovered');
  });

  it('sends OpenRouter attribution headers when configured', async () => {
    const fetchImpl: FetchLike = vi.fn(async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body as string), headers: new Headers(init.headers) });
      return jsonResponse(textReply('ok'));
    });
    const client = new OpenAiCompatClient(
      { ...config, appUrl: 'https://alaje.example', appTitle: 'Alaje' },
      silentLogger,
      fetchImpl,
    );
    await client.complete(baseRequest);

    expect(calls[0]?.headers.get('http-referer')).toBe('https://alaje.example');
    expect(calls[0]?.headers.get('x-title')).toBe('Alaje');
  });
});
