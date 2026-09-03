import { Router, type Request, type Response } from 'express';
import { handleInboundMessage, type HandlerDeps } from '../handler.js';
import { extractMessages } from './parse.js';
import { verifySignature } from './signature.js';
import type { WebhookPayload } from './types.js';

export interface WebhookDeps extends HandlerDeps {
  verifyToken: string;
  appSecret: string;
}

export function createWebhookRouter(deps: WebhookDeps): Router {
  const router = Router();

  // Meta's one-time verification handshake when the webhook URL is registered.
  router.get('/webhook', (req: Request, res: Response) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === deps.verifyToken && typeof challenge === 'string') {
      res.status(200).send(challenge);
      return;
    }
    deps.logger.warn({ mode }, 'webhook verification rejected');
    res.sendStatus(403);
  });

  router.post('/webhook', async (req: Request, res: Response) => {
    const valid = verifySignature(
      (req as Request & { rawBody?: Buffer }).rawBody,
      req.header('x-hub-signature-256'),
      deps.appSecret,
    );
    if (!valid) {
      deps.logger.warn('webhook signature verification failed');
      res.sendStatus(401);
      return;
    }

    const messages = extractMessages(req.body as WebhookPayload);

    // Acknowledge before processing: Meta retries anything it considers slow,
    // and dedupe already makes a retry harmless. Errors below must never turn
    // into a non-200 that triggers a redelivery storm.
    res.sendStatus(200);

    for (const message of messages) {
      try {
        await handleInboundMessage(deps, message);
      } catch (err) {
        // Log the real exception with enough context to reproduce from the data.
        deps.logger.error(
          { err, waMessageId: message.waMessageId, from: message.from },
          'failed to handle inbound message',
        );
      }
    }
  });

  return router;
}
