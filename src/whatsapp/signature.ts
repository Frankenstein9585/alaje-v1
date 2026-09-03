import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verify Meta's X-Hub-Signature-256 header against the RAW request body.
 *
 * This must run on the exact bytes Meta sent — re-serialising the parsed JSON
 * changes key order and whitespace and the HMAC will never match. See the
 * `verify` hook in app.ts, which stashes the raw buffer for this purpose.
 */
export function verifySignature(
  rawBody: Buffer | undefined,
  headerValue: string | undefined,
  appSecret: string,
): boolean {
  if (!rawBody || !headerValue) return false;
  if (!headerValue.startsWith('sha256=')) return false;

  const expected = createHmac('sha256', appSecret).update(rawBody).digest();

  let received: Buffer;
  try {
    received = Buffer.from(headerValue.slice('sha256='.length), 'hex');
  } catch {
    return false;
  }

  // timingSafeEqual throws on length mismatch, so guard first.
  if (received.length !== expected.length) return false;
  return timingSafeEqual(received, expected);
}
