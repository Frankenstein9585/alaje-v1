import type { InboundTextMessage, WebhookPayload } from './types.js';

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * Flatten a webhook payload into the messages worth handling.
 *
 * Delivery/read `statuses` entries are ignored — they carry no message id we
 * should reply to, and treating them as messages would burn dedupe slots.
 */
export function extractMessages(payload: WebhookPayload): InboundTextMessage[] {
  const out: InboundTextMessage[] = [];

  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const raw of change.value?.messages ?? []) {
        const waMessageId = str(raw.id);
        const from = str(raw.from);
        if (!waMessageId || !from) continue; // malformed; nothing to reply to

        const rawType = str(raw.type) ?? 'unsupported';
        const text =
          rawType === 'text'
            ? str((raw.text as { body?: unknown } | undefined)?.body)
            : str((raw[rawType] as { caption?: unknown } | undefined)?.caption);
        const mediaId = str((raw[rawType] as { id?: unknown } | undefined)?.id);

        out.push({
          waMessageId,
          from,
          timestamp: str(raw.timestamp) ?? '',
          type: rawType === 'text' || rawType === 'image' || rawType === 'audio' ? rawType : 'unsupported',
          text,
          mediaId,
        });
      }
    }
  }

  return out;
}
