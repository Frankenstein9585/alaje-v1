/** The slice of the Meta Cloud API webhook payload Phase 1 actually reads. */

export interface InboundTextMessage {
  waMessageId: string;
  from: string; // international digits, no '+'
  timestamp: string;
  type: 'text' | 'image' | 'audio' | 'unsupported';
  text: string | null;
  /** Present for image/audio; Phase 1 records the id but does not fetch media. */
  mediaId: string | null;
}

export interface WebhookValue {
  messaging_product?: string;
  metadata?: { display_phone_number?: string; phone_number_id?: string };
  messages?: Array<Record<string, unknown>>;
  statuses?: Array<Record<string, unknown>>;
}

export interface WebhookPayload {
  object?: string;
  entry?: Array<{ id?: string; changes?: Array<{ field?: string; value?: WebhookValue }> }>;
}
