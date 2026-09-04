import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { LlmError } from '../src/agent/llm.js';
import { runAgent, type AgentDeps } from '../src/agent/loop.js';
import { FALLBACK_REPLY } from '../src/agent/prompt.js';
import type { AnyToolDefinition, ToolContext } from '../src/agent/tools/registry.js';
import type { BusinessRecord } from '../src/store.js';
import {
  InMemoryStore,
  ScriptedLlmClient,
  silentLogger,
  textMessage,
  textResponse,
  toolResponse,
} from './fakes.js';

const business: BusinessRecord = {
  id: 'biz-1',
  whatsappNumber: '2348031234567',
  name: 'Mama Chika Stores',
  createdAt: new Date(),
};

const otherBusiness: BusinessRecord = { ...business, id: 'biz-2', name: 'Shop B' };

/** Records which business it was handed, so scoping can be asserted. */
function spyTool(overrides: Partial<AnyToolDefinition> = {}) {
  const seen: Array<{ businessId: string; args: unknown }> = [];
  const tool: AnyToolDefinition = {
    name: 'record_thing',
    description: 'Record a thing',
    schema: z.object({ amount: z.number() }),
    async execute(ctx: ToolContext, args: unknown) {
      seen.push({ businessId: ctx.business.id, args });
      return { ok: true, display: '₦42,000' };
    },
    ...overrides,
  };
  return { tool, seen };
}

describe('runAgent', () => {
  let store: InMemoryStore;

  const deps = (llm: ScriptedLlmClient, tools: AnyToolDefinition[] = []): AgentDeps => ({
    store,
    logger: silentLogger,
    llm,
    tools,
    maxIterations: 3,
  });

  beforeEach(() => {
    store = new InMemoryStore();
  });

  it('returns a plain reply when no tool is called', async () => {
    const llm = new ScriptedLlmClient(textResponse('Noted.'));
    const reply = await runAgent(deps(llm), business, textMessage({ text: 'hello' }));

    expect(reply).toBe('Noted.');
    expect(store.toolCalls).toHaveLength(0);
  });

  it('executes a tool then returns the follow-up text', async () => {
    const { tool, seen } = spyTool();
    const llm = new ScriptedLlmClient(
      toolResponse([{ name: 'record_thing', args: { amount: 42000 } }]),
      textResponse('Sold 3 cartons for ₦42,000. 17 left.'),
    );

    const reply = await runAgent(deps(llm, [tool]), business, textMessage({ text: 'sold 3' }));

    expect(seen).toEqual([{ businessId: 'biz-1', args: { amount: 42000 } }]);
    expect(reply).toBe('Sold 3 cartons for ₦42,000. 17 left.');
    expect(store.toolCalls[0]).toMatchObject({ toolName: 'record_thing', success: true });
  });

  it('passes the resolved business, never one the model could name', async () => {
    const { tool, seen } = spyTool();
    const llm = new ScriptedLlmClient(
      // Model tries to smuggle in another business id. It is not in the schema
      // and there is no path for it to reach the tool.
      toolResponse([{ name: 'record_thing', args: { amount: 1, business_id: 'biz-2' } }]),
      textResponse('done'),
    );

    await runAgent(deps(llm, [tool]), otherBusiness, textMessage({ text: 'x' }));

    expect(seen[0]?.businessId).toBe('biz-2'); // the one the loop was handed
    expect(seen[0]?.args).toEqual({ amount: 1 }); // extra key stripped by Zod
  });

  it('returns every tool result in a single follow-up turn', async () => {
    const { tool } = spyTool();
    const llm = new ScriptedLlmClient(
      toolResponse([
        { name: 'record_thing', args: { amount: 1 }, id: 'c1' },
        { name: 'record_thing', args: { amount: 2 }, id: 'c2' },
      ]),
      textResponse('both done'),
    );

    await runAgent(deps(llm, [tool]), business, textMessage({ text: 'two things' }));

    // Splitting results across messages teaches the model to stop batching.
    const second = llm.requests[1];
    const toolMessages = second?.messages.filter((m) => m.role === 'tool') ?? [];
    expect(toolMessages).toHaveLength(2);
    expect(toolMessages.map((m) => (m as { toolCallId: string }).toolCallId)).toEqual(['c1', 'c2']);
  });

  it('hands a thrown tool back as an error and lets the model recover', async () => {
    const { tool } = spyTool({
      async execute() {
        throw new Error('database is on fire');
      },
    });
    const llm = new ScriptedLlmClient(
      toolResponse([{ name: 'record_thing', args: { amount: 1 } }]),
      textResponse("That didn't go through."),
    );

    const reply = await runAgent(deps(llm, [tool]), business, textMessage({ text: 'x' }));

    const toolMessage = llm.requests[1]?.messages.find((m) => m.role === 'tool');
    expect(toolMessage).toMatchObject({ isError: true });
    // The real exception is logged, never surfaced to the owner.
    expect(reply).not.toContain('database is on fire');
    expect(store.toolCalls[0]).toMatchObject({ success: false });
  });

  it('rejects invalid arguments instead of coercing them', async () => {
    const { tool, seen } = spyTool();
    const llm = new ScriptedLlmClient(
      toolResponse([{ name: 'record_thing', args: { amount: 'plenty' } }]),
      textResponse('How much was it?'),
    );

    const reply = await runAgent(deps(llm, [tool]), business, textMessage({ text: 'x' }));

    // A guessed amount is worse than an asked question.
    expect(seen).toHaveLength(0);
    expect(reply).toBe('How much was it?');
    expect(store.toolCalls[0]).toMatchObject({ success: false });
  });

  it('tells the model when it invents a tool', async () => {
    const { tool } = spyTool();
    const llm = new ScriptedLlmClient(
      toolResponse([{ name: 'send_money', args: {} }]),
      textResponse("I can't do that."),
    );

    const reply = await runAgent(deps(llm, [tool]), business, textMessage({ text: 'x' }));

    expect(llm.requests[1]?.messages.at(-1)).toMatchObject({ isError: true });
    expect(reply).toBe("I can't do that.");
  });

  it('falls back cleanly when the provider fails', async () => {
    const llm = new ScriptedLlmClient(new LlmError('gateway down', { retryable: false }));
    const reply = await runAgent(deps(llm), business, textMessage({ text: 'x' }));

    expect(reply).toBe(FALLBACK_REPLY);
  });

  it('asks for a plain summary rather than giving up at the iteration cap', async () => {
    const { tool } = spyTool();
    const llm = new ScriptedLlmClient(
      toolResponse([{ name: 'record_thing', args: { amount: 1 } }]),
      toolResponse([{ name: 'record_thing', args: { amount: 2 } }]),
      toolResponse([{ name: 'record_thing', args: { amount: 3 } }]),
      textResponse('Recorded all three.'),
    );

    const reply = await runAgent(deps(llm, [tool]), business, textMessage({ text: 'loop' }));

    // The work is already done; dropping it for a generic apology wastes it.
    expect(reply).toBe('Recorded all three.');
    expect(llm.requests).toHaveLength(4);
    // The last call offers no tools, so the model has to answer in words.
    expect(llm.requests[3]?.tools).toEqual([]);
  });

  it('falls back when even the summary call cannot produce words', async () => {
    const { tool } = spyTool();
    const llm = new ScriptedLlmClient(
      toolResponse([{ name: 'record_thing', args: { amount: 1 } }]),
      toolResponse([{ name: 'record_thing', args: { amount: 2 } }]),
      toolResponse([{ name: 'record_thing', args: { amount: 3 } }]),
      new LlmError('gateway down', { retryable: false }),
    );

    const reply = await runAgent(deps(llm, [tool]), business, textMessage({ text: 'loop' }));
    expect(reply).toBe(FALLBACK_REPLY);
  });

  it('uses a truncated reply rather than apologising', async () => {
    // Hitting max_tokens mid-sentence still leaves the owner the numbers.
    const llm = new ScriptedLlmClient({
      text: 'Sold 3 cartons for ₦42,000. 17 cart',
      toolCalls: [],
      stopReason: 'max_tokens',
    });
    const reply = await runAgent(deps(llm), business, textMessage({ text: 'x' }));
    expect(reply).toBe('Sold 3 cartons for ₦42,000. 17 cart');
  });

  it('never replies with silence', async () => {
    const llm = new ScriptedLlmClient({ text: '   ', toolCalls: [], stopReason: 'end_turn' });
    const reply = await runAgent(deps(llm), business, textMessage({ text: 'x' }));

    expect(reply).toBe(FALLBACK_REPLY);
  });

  it('includes the business name and the reply-style contract in the system prompt', async () => {
    const llm = new ScriptedLlmClient(textResponse('ok'));
    await runAgent(deps(llm), business, textMessage({ text: 'x' }));

    const system = llm.requests[0]?.system ?? '';
    expect(system).toContain('Mama Chika Stores');
    expect(system).toContain('One or two lines');
    expect(system).toContain('Never state a number you did not get back from a tool');
  });
});
