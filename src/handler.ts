import { runAgent } from './agent/loop.js';
import {
  NAME_REJECTED_MESSAGE,
  WELCOME_MESSAGE,
  confirmationMessage,
  isOnboarding,
  parseBusinessName,
} from './businesses/onboarding.js';
import { resolveBusiness } from './businesses/resolve.js';
import type { Logger } from './logger.js';
import type { Store } from './store.js';
import type { WhatsAppSender } from './whatsapp/client.js';
import type { InboundTextMessage } from './whatsapp/types.js';

export interface HandlerDeps {
  store: Store;
  sender: WhatsAppSender;
  logger: Logger;
}

/**
 * Handle one inbound message. Order matters:
 *
 *   1. dedupe   — Meta retries; a retried payload must produce zero extra replies
 *   2. resolve  — deterministic business lookup, before any reasoning
 *   3. onboard  — a null business name means onboarding is still in progress
 *   4. agent    — only a fully-onboarded business reaches the tool layer
 */
export async function handleInboundMessage(
  deps: HandlerDeps,
  message: InboundTextMessage,
): Promise<void> {
  const log = deps.logger.child({ waMessageId: message.waMessageId });

  // 1. Dedupe before anything with a side effect. Claiming is atomic, so two
  //    concurrent retries cannot both proceed.
  const claimed = await deps.store.claimMessage(message.waMessageId);
  if (!claimed) {
    log.info('duplicate webhook message ignored');
    return;
  }

  // 2. Identity is resolved here, in code, and handed to everything downstream.
  const { business, isNew } = await resolveBusiness(deps.store, message.from);
  const businessLog = log.child({ businessId: business.id });

  // 3. First contact: the row now exists with a null name; ask for it.
  if (isNew) {
    businessLog.info('new business created, onboarding started');
    await deps.sender.sendText(message.from, WELCOME_MESSAGE);
    return;
  }

  if (isOnboarding(business)) {
    const name = parseBusinessName(message.text);
    if (!name) {
      // Re-ask rather than dropping them into a dead end. An identified number
      // always has a way forward.
      businessLog.info('business name rejected during onboarding');
      await deps.sender.sendText(message.from, NAME_REJECTED_MESSAGE);
      return;
    }
    await deps.store.setBusinessName(business.id, name);
    businessLog.info('onboarding complete');
    await deps.sender.sendText(message.from, confirmationMessage(name));
    return;
  }

  // 4. Fully onboarded — hand off to the agent, scoped to this business.
  const reply = await runAgent({ store: deps.store, logger: businessLog }, business, message);
  await deps.sender.sendText(message.from, reply);
}
