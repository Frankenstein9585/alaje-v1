/**
 * Live smoke test: the real agent loop, the real tools, the real prompt, and by
 * default the real database.
 *
 *   npx tsx scripts/smoke.ts                       # against DATABASE_URL
 *   SMOKE_STORE=memory npx tsx scripts/smoke.ts    # no database needed
 *   SMOKE_LOG_LEVEL=warn npx tsx scripts/smoke.ts  # show adapter errors
 *
 * This answers what the unit tests cannot: whether the model picks the right
 * tool, whether "42k" reads as 42,000, and whether the SQL actually runs.
 *
 * It works on its own business row, keyed to a phone number no real shop will
 * have, and clears that row's data at the start of every run so repeated runs
 * are comparable. It never touches another business.
 *
 * Costs a handful of real API calls.
 */
import pino from 'pino';
import type { LlmMessage } from '../src/agent/llm.js';
import { runAgent } from '../src/agent/loop.js';
import { OpenAiCompatClient } from '../src/agent/openai-compat.js';
import { allTools } from '../src/agent/tools/index.js';
import { createDb } from '../src/db/client.js';
import { DrizzleStore } from '../src/db/store.js';
import { loadEnv } from '../src/env.js';
import { formatNaira } from '../src/format.js';
import type { BusinessRecord, Store } from '../src/store.js';
import { InMemoryStore } from '../tests/fakes.js';

const env = loadEnv();
const logger = pino({ level: process.env.SMOKE_LOG_LEVEL ?? 'silent' });
const useMemory = process.env.SMOKE_STORE === 'memory';

/** Reserved for this script. Not a dialable Nigerian number. */
const SMOKE_NUMBER = '2340000000001';

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;

/**
 * Deliberately written the way a shop owner types: lowercase, no punctuation,
 * "42k" for amounts, a little pidgin. Testing on clean English would prove
 * nothing about the real input.
 */
const script: Array<{ say: string; expect: string }> = [
  { say: 'oya my shop na Mama Chika Ventures not Stores', expect: 'rename_business' },
  {
    say: 'i got 20 cartons of indomie, i bought am for 12k each',
    expect: 'add_stock (unit_cost 12000)',
  },
  { say: 'sold 3 to chika for 42k', expect: 'record_sale (customer Chika, amount 42000)' },
  { say: 'how much indomie remain?', expect: 'check_stock' },
  { say: 'abeg warn me when indomie remain 15', expect: 'update_product (low_stock_alert 15)' },
  { say: 'chika don pay 20k', expect: 'record_payment (20000)' },
  { say: 'who dey owe me?', expect: 'check_balance' },
  { say: 'wetin i make today?', expect: 'run_report (today, real profit)' },
  { say: 'send chika her invoice', expect: 'send_invoice' },
  // Two phrasings: one unambiguous, one where "no" could read as a refusal.
  // A model that only handles the tidy one will disappoint a real owner.
  { say: 'undo that last one', expect: 'undo_last' },
  { say: 'no, cancel that too', expect: 'undo_last' },
];

async function setup(): Promise<{
  store: Store;
  business: BusinessRecord;
  close: () => Promise<void>;
}> {
  if (useMemory) {
    const store = new InMemoryStore();
    const business = await store.createBusiness(SMOKE_NUMBER);
    await store.setBusinessName(business.id, 'Mama Chika Stores');
    business.name = 'Mama Chika Stores';
    return { store, business, close: async () => {} };
  }

  const { db, pool } = createDb(env.DATABASE_URL);
  const store = new DrizzleStore(db);

  // Clear only this script's own business, by id. Never a blanket truncate:
  // this runs against whatever DATABASE_URL points at, which one day will be
  // something that matters.
  const existing = await store.findBusinessByPhoneVariants([SMOKE_NUMBER]);
  if (existing) {
    for (const table of ['transactions', 'products', 'customers', 'messages', 'tool_call_logs']) {
      await pool.query(`DELETE FROM \`${table}\` WHERE business_id = ?`, [existing.id]);
    }
    await pool.query('DELETE FROM `businesses` WHERE id = ?', [existing.id]);
  }

  const business = await store.createBusiness(SMOKE_NUMBER);
  await store.setBusinessName(business.id, 'Mama Chika Stores');
  business.name = 'Mama Chika Stores';

  return { store, business, close: () => pool.end() };
}

const { store, business, close } = await setup();

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

console.log(`\n  store    ${useMemory ? 'in memory' : `mysql ${redact(env.DATABASE_URL)}`}`);
console.log(`  provider ${env.LLM_BASE_URL}`);
console.log(`  model    ${env.LLM_MODEL}`);
console.log(`  tools    ${allTools.map((t) => t.name).join(', ')}\n`);

const history: LlmMessage[] = [];
let seenCalls = 0;
let hits = 0;
let totalCalls = 0;
let failedCalls = 0;
const started = Date.now();

for (const [i, step] of script.entries()) {
  const turnStart = Date.now();

  const reply = await runAgent(
    { store, logger, llm, tools: allTools, maxIterations: env.AGENT_MAX_ITERATIONS },
    business,
    {
      waMessageId: `smoke-${started}-${i}`,
      from: business.whatsappNumber,
      timestamp: String(Date.now()),
      type: 'text',
      text: step.say,
      mediaId: null,
    },
    history,
  );

  // Read the calls back out of the audit log rather than tallying them in
  // memory. That way this also proves logToolCall round-trips through the
  // real schema, JSON columns included.
  const all = await store.listToolCalls(business.id, 500);
  const calls = all.slice(seenCalls);
  seenCalls = all.length;
  totalCalls += calls.length;
  failedCalls += calls.filter((c) => !c.success).length;
  if (calls.some((c) => step.expect.startsWith(c.toolName))) hits += 1;

  console.log(`${bold(`> ${step.say}`)}  ${dim(`${Date.now() - turnStart}ms`)}`);
  console.log(`  ${dim('want')} ${step.expect}`);
  for (const call of calls) {
    const mark = call.success ? green('ok') : red('FAILED');
    console.log(`  ${dim('call')} ${cyan(call.toolName)} ${mark} ${JSON.stringify(call.arguments)}`);
  }
  if (calls.length === 0) {
    console.log(`  ${dim('call')} ${red('none — model answered without a tool')}`);
  }
  console.log(`  ${dim('says')} ${reply.replace(/\n/g, '\n       ')}\n`);

  history.push({ role: 'user', content: step.say }, { role: 'assistant', content: reply });
}

console.log(dim('  ─────────────────────────────────────────────'));
console.log(`  ${hits}/${script.length} turns called the expected tool`);
console.log(`  ${totalCalls} tool calls, ${failedCalls} failed`);
console.log(`  ${((Date.now() - started) / script.length / 1000).toFixed(1)}s average per turn\n`);

// Read everything back through the port, so the summary reflects what is
// actually persisted rather than what the process remembers.
console.log(dim('  final state, read back from the store'));
for (const p of await store.listProducts(business.id)) {
  const cost = p.costPrice ? `cost ${formatNaira(p.costPrice)}` : 'cost unknown';
  console.log(`    ${p.name}: ${p.stockQty} ${p.unit ?? 'units'}, ${cost}`);
}
for (const c of await store.listCustomers(business.id)) {
  const balance = await store.customerBalance(business.id, c.id);
  console.log(`    ${c.name}: balance ${formatNaira(balance)}`);
}
console.log(`    ${(await store.listRecentTransactions(business.id, 500)).length} live transactions`);
// The transcript is written by the handler, not the loop, and this script calls
// the loop directly — so zero here is expected, not a missing write.
const turns = (await store.recentMessages(business.id, 100)).length;
console.log(`    ${turns} conversation turns stored ${dim('(the handler writes these, not the loop)')}\n`);

await close();

function redact(url: string): string {
  return url.replace(/\/\/[^@]*@/, '//***@');
}
