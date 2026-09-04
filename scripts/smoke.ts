/**
 * Live smoke test against the configured LLM provider.
 *
 * Runs the real agent loop, the real tools and the real prompt over an
 * in-memory store, so it exercises everything except WhatsApp and MySQL. This
 * is what tells you whether the model actually picks the right tool and reads
 * "42k" as 42,000 — the unit tests script the model and cannot answer that.
 *
 *   npx tsx scripts/smoke.ts
 *
 * Costs a handful of real API calls.
 */
import pino from 'pino';
import type { LlmMessage } from '../src/agent/llm.js';
import { runAgent } from '../src/agent/loop.js';
import { OpenAiCompatClient } from '../src/agent/openai-compat.js';
import { allTools } from '../src/agent/tools/index.js';
import { loadEnv } from '../src/env.js';
import type { BusinessRecord } from '../src/store.js';
import { InMemoryStore } from '../tests/fakes.js';

const env = loadEnv();
const logger = pino({ level: process.env.SMOKE_LOG_LEVEL ?? 'silent' });

const business: BusinessRecord = {
  id: 'biz-smoke',
  whatsappNumber: '2348031234567',
  name: 'Mama Chika Stores',
  createdAt: new Date(),
};

/**
 * Deliberately written the way a shop owner types: lowercase, no punctuation,
 * "42k" for amounts, a little pidgin. Testing on clean English would prove
 * nothing about the real input.
 */
const script: Array<{ say: string; expect: string }> = [
  { say: 'oya my shop na Mama Chika Ventures not Stores', expect: 'rename_business' },
  { say: 'i got 20 cartons of indomie, i bought am for 12k each', expect: 'add_stock (unit_cost 12000)' },
  { say: 'sold 3 to chika for 42k', expect: 'record_sale (customer Chika, amount 42000)' },
  { say: 'how much indomie remain?', expect: 'check_stock' },
  { say: 'chika don pay 20k', expect: 'record_payment (20000)' },
  { say: 'who dey owe me?', expect: 'check_balance' },
  { say: 'wetin i make today?', expect: 'run_report (today, real profit)' },
  { say: 'send chika her invoice', expect: 'send_invoice' },
  // Two phrasings: one unambiguous, one where "no" could read as a refusal.
  // A model that only handles the tidy one will disappoint a real owner.
  { say: 'undo that last one', expect: 'undo_last' },
  { say: 'no, cancel that too', expect: 'undo_last' },
];

const store = new InMemoryStore();
const llm = new OpenAiCompatClient(
  {
    baseUrl: env.LLM_BASE_URL,
    model: env.LLM_MODEL,
    apiKey: env.LLM_API_KEY,
    maxTokens: env.LLM_MAX_TOKENS,
    temperature: env.LLM_TEMPERATURE,
    timeoutMs: env.LLM_TIMEOUT_MS,
    appTitle: 'Alaje',
  },
  logger,
);

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;

console.log(`\n  provider ${env.LLM_BASE_URL}`);
console.log(`  model    ${env.LLM_MODEL}`);
console.log(`  tools    ${allTools.map((t) => t.name).join(', ')}\n`);

const history: LlmMessage[] = [];
let seen = 0;
let hits = 0;
const started = Date.now();

for (const [i, step] of script.entries()) {
  const turnStart = Date.now();
  const reply = await runAgent(
    { store, logger, llm, tools: allTools, maxIterations: env.AGENT_MAX_ITERATIONS },
    business,
    {
      waMessageId: `smoke-${i}`,
      from: business.whatsappNumber,
      timestamp: String(Date.now()),
      type: 'text',
      text: step.say,
      mediaId: null,
    },
    history,
  );

  const calls = store.toolCalls.slice(seen);
  seen = store.toolCalls.length;
  const named = calls.map((c) => c.toolName);
  const ok = named.some((n) => step.expect.startsWith(n));
  if (ok) hits += 1;

  console.log(`${bold(`> ${step.say}`)}  ${dim(`${Date.now() - turnStart}ms`)}`);
  console.log(`  ${dim('want')} ${step.expect}`);
  for (const call of calls) {
    const mark = call.success ? green('ok') : red('FAILED');
    console.log(`  ${dim('call')} ${cyan(call.toolName)} ${mark} ${JSON.stringify(call.arguments)}`);
  }
  if (calls.length === 0) console.log(`  ${dim('call')} ${red('none — model answered without a tool')}`);
  console.log(`  ${dim('says')} ${reply.replace(/\n/g, '\n       ')}\n`);

  history.push({ role: 'user', content: step.say }, { role: 'assistant', content: reply });
}

console.log(dim('  ─────────────────────────────────────────────'));
console.log(`  ${hits}/${script.length} turns called the expected tool`);
console.log(`  ${store.toolCalls.filter((c) => !c.success).length} failed tool calls`);
console.log(`  ${((Date.now() - started) / script.length / 1000).toFixed(1)}s average per turn\n`);

console.log(dim('  final state'));
for (const p of store.products) {
  console.log(`    ${p.name}: ${p.stockQty} ${p.unit ?? 'units'}`);
}
for (const c of store.customers) {
  console.log(`    ${c.name}: balance ${await store.customerBalance(business.id, c.id)}`);
}
const live = store.transactions.filter((t) => t.voidedAt === null);
console.log(`    ${live.length} live transactions, ${store.transactions.length - live.length} voided\n`);
