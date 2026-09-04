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

  /**
   * Send a file. Throws on failure so the caller can fall back to text.
   *
   * Meta will not accept a raw buffer on the messages endpoint: the file is
   * uploaded to /media first and the returned id is sent. That avoids having
   * to host invoices at a public URL.
   */
  sendDocument(
    to: string,
    file: { buffer: Buffer; filename: string; mimeType: string },
    caption?: string,
  ): Promise<void>;
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

  async sendDocument(
    to: string,
    file: { buffer: Buffer; filename: string; mimeType: string },
    caption?: string,
  ): Promise<void> {
    const mediaId = await this.uploadMedia(file);

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
        type: 'document',
        document: { id: mediaId, filename: file.filename, ...(caption ? { caption } : {}) },
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '<unreadable body>');
      this.logger.error({ to, status: res.status, detail }, 'whatsapp document send failed');
      throw new Error(`WhatsApp document send failed with ${res.status}`);
    }
  }

  /** Returns a media id, valid for 30 days. */
  private async uploadMedia(file: {
    buffer: Buffer;
    filename: string;
    mimeType: string;
  }): Promise<string> {
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', file.mimeType);
    form.append(
      'file',
      new Blob([new Uint8Array(file.buffer)], { type: file.mimeType }),
      file.filename,
    );

    const url = `https://graph.facebook.com/${this.config.graphVersion}/${this.config.phoneNumberId}/media`;
    // No content-type header: fetch sets the multipart boundary itself.
    const res = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.config.token}` },
      body: form,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '<unreadable body>');
      this.logger.error({ status: res.status, detail }, 'whatsapp media upload failed');
      throw new Error(`WhatsApp media upload failed with ${res.status}`);
    }

    const payload = (await res.json()) as { id?: unknown };
    if (typeof payload.id !== 'string') {
      throw new Error('WhatsApp media upload returned no id');
    }
    return payload.id;
  }

  private endpoint(): string {
    return `https://graph.facebook.com/${this.config.graphVersion}/${this.config.phoneNumberId}/messages`;
  }
}
