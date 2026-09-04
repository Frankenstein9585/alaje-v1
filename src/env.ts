import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.string().default('info'),
  DATABASE_URL: z.string().min(1),
  WHATSAPP_VERIFY_TOKEN: z.string().min(1),
  WHATSAPP_APP_SECRET: z.string().min(1),
  WHATSAPP_TOKEN: z.string().min(1),
  WHATSAPP_PHONE_NUMBER_ID: z.string().min(1),
  WHATSAPP_GRAPH_VERSION: z.string().default('v21.0'),

  // LLM provider. Any OpenAI-compatible gateway: DeepSeek, OpenRouter, Groq,
  // Together, OpenAI. Swapping providers is these three values.
  LLM_BASE_URL: z.string().url().default('https://openrouter.ai/api/v1'),
  LLM_MODEL: z.string().min(1),
  LLM_API_KEY: z.string().min(1),
  LLM_MAX_TOKENS: z.coerce.number().int().positive().default(4096),
  // Low but not zero: bookkeeping wants repeatable tool arguments, and a few
  // gateways behave oddly at exactly 0.
  LLM_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.2),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  AGENT_MAX_ITERATIONS: z.coerce.number().int().min(1).max(10).default(3),
  AGENT_HISTORY_TURNS: z.coerce.number().int().min(0).max(50).default(10),
});

export type Env = z.infer<typeof schema>;

/**
 * Fail fast at boot rather than at the first inbound webhook — a missing
 * app secret must never degrade into "signature check skipped".
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment:\n${issues}`);
  }
  return parsed.data;
}
