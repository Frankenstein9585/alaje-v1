import { createApp } from './app.js';
import { OpenAiCompatClient } from './agent/openai-compat.js';
import { allTools } from './agent/tools/index.js';
import { createDb } from './db/client.js';
import { DrizzleStore } from './db/store.js';
import { loadEnv } from './env.js';
import { logger } from './logger.js';
import { CloudApiSender } from './whatsapp/client.js';

const env = loadEnv();
const { db, pool } = createDb(env.DATABASE_URL);

const app = createApp({
  store: new DrizzleStore(db),
  sender: new CloudApiSender(
    {
      token: env.WHATSAPP_TOKEN,
      phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID,
      graphVersion: env.WHATSAPP_GRAPH_VERSION,
    },
    logger,
  ),
  logger,
  llm: new OpenAiCompatClient(
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
  ),
  tools: allTools,
  maxIterations: env.AGENT_MAX_ITERATIONS,
  historyTurns: env.AGENT_HISTORY_TURNS,
  verifyToken: env.WHATSAPP_VERIFY_TOKEN,
  appSecret: env.WHATSAPP_APP_SECRET,
});

const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT }, 'alaje listening');
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    logger.info({ signal }, 'shutting down');
    server.close(() => {
      void pool.end().then(() => process.exit(0));
    });
  });
}
