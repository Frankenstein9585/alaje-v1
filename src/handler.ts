import type { LlmMessage } from './agent/llm.js';
import { runAgent, type AgentDeps } from './agent/loop.js';
import {
  NAME_REJECTED_MESSAGE,
  UNSUPPORTED_MEDIA_MESSAGE,
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

export interface HandlerDeps extends Pick<AgentDeps, 'llm' | 'tools' | 'maxIterations'> {
  store: Store;
  sender: WhatsAppSender;
  logger: Logger;
  /** How many past turns to replay as context. */
  historyTurns: number;
}

/**
 * Handle one inbound message. Order matters:
 *
 *   1. dedupe   — Meta retries; a retried payload must produce zero extra replies
 *   2. ack      — read receipt + typing, so the owner sees something immediately
 *   3. resolve  — deterministic business lookup, before any reasoning
 *   4. onboard  — a null business name means onboarding is still in progress
 *   5. agent    — only a fully-onboarded business reaches the tool layer
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

  // 2. Acknowledge immediately. An agent turn takes seconds and unbroken
  //    silence on WhatsApp reads as a broken bot. Best effort by contract.
  await deps.sender.acknowledge(message.waMessageId);

  // 3. Identity is resolved here, in code, and handed to everything downstream.
  const { business, isNew } = await resolveBusiness(deps.store, message.from);
  const businessLog = log.child({ businessId: business.id });

  // 4. First contact: the row now exists with a null name; ask for it.
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

  // Media we cannot act on yet. Never drop it silently: the owner sent
  // something real and deserves to know it did not land, plus a way forward.
  if (!message.text) {
    const kind =
      message.type === 'audio' ? 'audio' : message.type === 'image' ? 'image' : 'other';
    businessLog.info({ messageType: message.type }, 'unsupported message type');
    await deps.sender.sendText(message.from, UNSUPPORTED_MEDIA_MESSAGE[kind]);
    return;
  }

  // 5. Fully onboarded — hand off to the agent, scoped to this business.
  // Past turns let the owner answer a clarifying question or say "undo that"
  // and be understood. A transcript, not a state machine.
  const past = await deps.store.recentMessages(business.id, deps.historyTurns);
  const history: LlmMessage[] = past.map((turn) =>
    turn.role === 'user'
      ? { role: 'user', content: turn.content }
      : { role: 'assistant', content: turn.content },
  );

  const reply = await runAgent(
    {
      store: deps.store,
      logger: businessLog,
      llm: deps.llm,
      tools: deps.tools,
      maxIterations: deps.maxIterations,
    },
    business,
    message,
    history,
  );
  await deps.sender.sendText(message.from, reply);

  // Record both sides so the next turn has context. Failing to write history
  // must not cost the owner their reply, which has already been sent.
  try {
    await deps.store.appendMessage(business.id, {
      role: 'user',
      content: message.text,
      waMessageId: message.waMessageId,
    });
    await deps.store.appendMessage(business.id, { role: 'assistant', content: reply });
  } catch (err) {
    businessLog.error({ err }, 'failed to append conversation history');
  }
}
