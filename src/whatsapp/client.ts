import type { Logger } from '../logger.js';

/** Outbound messaging port. Swapped for a spy in tests. */
export interface WhatsAppSender {
  sendText(to: string, body: string): Promise<void>;
  /**
   * Mark the message read and show the typing indicator.
   *
   * An LLM turn takes seconds, and on WhatsApp that silence reads as broken.
   * Best effort by design: a failure here must never stop the actual reply.
   */
  acknowledge(waMessageId: string): Promise<void>;
}

export interface CloudApiConfig {
  token: string;
  phoneNumberId: string;
  graphVersion: string;
}

export class CloudApiSender implements WhatsAppSender {
  constructor(
    private readonly config: CloudApiConfig,
    private readonly logger: Logger,
  ) {}

  async sendText(to: string, body: string): Promise<void> {
    const res = await fetch(this.endpoint(), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.config.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'text',
        text: { preview_url: false, body },
      }),
    });

    if (!res.ok) {
      // Log the real Graph error body — "send failed" alone tells you nothing
      // about whether it was an expired token, a 24h-window violation, or a
      // malformed recipient.
      const detail = await res.text().catch(() => '<unreadable body>');
      this.logger.error({ to, status: res.status, detail }, 'whatsapp send failed');
      throw new Error(`WhatsApp send failed with ${res.status}`);
    }
  }

  async acknowledge(waMessageId: string): Promise<void> {
    try {
      const res = await fetch(this.endpoint(), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.config.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          status: 'read',
          message_id: waMessageId,
          typing_indicator: { type: 'text' },
        }),
      });
      if (!res.ok) {
        // Older API versions reject the typing_indicator field. Not worth
        // failing a real reply over, so log at debug and carry on.
        const detail = await res.text().catch(() => '<unreadable body>');
        this.logger.debug({ waMessageId, status: res.status, detail }, 'acknowledge failed');
      }
    } catch (err) {
      this.logger.debug({ err, waMessageId }, 'acknowledge threw');
    }
  }

  private endpoint(): string {
    return `https://graph.facebook.com/${this.config.graphVersion}/${this.config.phoneNumberId}/messages`;
  }
}
