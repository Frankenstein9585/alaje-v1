import express, { type Express, type Request } from 'express';
import type { HandlerDeps } from './handler.js';
import { createWebhookRouter } from './whatsapp/webhook.js';

export interface AppDeps extends HandlerDeps {
  verifyToken: string;
  appSecret: string;
}

export function createApp(deps: AppDeps): Express {
  const app = express();

  app.use(
    express.json({
      limit: '1mb',
      // Stash the raw bytes: the X-Hub-Signature-256 HMAC is computed over the
      // exact payload Meta sent, and re-serialising the parsed object breaks it.
      verify: (req, _res, buf) => {
        (req as Request & { rawBody?: Buffer }).rawBody = buf;
      },
    }),
  );

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.use(createWebhookRouter(deps));

  return app;
}
