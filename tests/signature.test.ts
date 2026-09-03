import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifySignature } from '../src/whatsapp/signature.js';

const SECRET = 'test-app-secret';
const body = Buffer.from(JSON.stringify({ object: 'whatsapp_business_account' }));
const sign = (buf: Buffer, secret = SECRET) =>
  `sha256=${createHmac('sha256', secret).update(buf).digest('hex')}`;

describe('verifySignature', () => {
  it('accepts a signature computed over the raw body', () => {
    expect(verifySignature(body, sign(body), SECRET)).toBe(true);
  });

  it('rejects a signature from a different secret', () => {
    expect(verifySignature(body, sign(body, 'wrong-secret'), SECRET)).toBe(false);
  });

  it('rejects a tampered body', () => {
    expect(verifySignature(Buffer.from('{"object":"tampered"}'), sign(body), SECRET)).toBe(false);
  });

  it('rejects a missing or malformed header', () => {
    expect(verifySignature(body, undefined, SECRET)).toBe(false);
    expect(verifySignature(body, 'sha1=abc', SECRET)).toBe(false);
    expect(verifySignature(body, 'sha256=not-hex', SECRET)).toBe(false);
    expect(verifySignature(undefined, sign(body), SECRET)).toBe(false);
  });
});
