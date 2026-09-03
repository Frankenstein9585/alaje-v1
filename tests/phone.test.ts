import { describe, expect, it } from 'vitest';
import { phoneVariants, toCanonical } from '../src/phone.js';

describe('toCanonical', () => {
  it('leaves an already-international number alone', () => {
    expect(toCanonical('2348031234567')).toBe('2348031234567');
  });

  it('converts the local trunk form', () => {
    expect(toCanonical('08031234567')).toBe('2348031234567');
  });

  it('strips E.164 punctuation', () => {
    expect(toCanonical('+234 803 123 4567')).toBe('2348031234567');
    expect(toCanonical('(0803) 123-4567')).toBe('2348031234567');
  });

  it('handles the 00 international prefix', () => {
    expect(toCanonical('002348031234567')).toBe('2348031234567');
  });

  it('expands a bare national significant number', () => {
    expect(toCanonical('8031234567')).toBe('2348031234567');
  });
});

describe('phoneVariants', () => {
  it('matches a number stored in any common format', () => {
    // The real incident: WhatsApp delivers international, the row was written
    // in local format, and exact-match lookup created a duplicate business.
    const variants = phoneVariants('2348031234567');
    for (const stored of ['2348031234567', '+2348031234567', '08031234567', '8031234567']) {
      expect(variants).toContain(stored);
    }
  });

  it('produces the same variant set from every input format', () => {
    const fromInternational = new Set(phoneVariants('2348031234567'));
    const fromLocal = new Set(phoneVariants('08031234567'));
    for (const v of fromInternational) {
      if (v === '2348031234567') expect(fromLocal.has(v)).toBe(true);
    }
    expect(fromLocal.has('2348031234567')).toBe(true);
  });
});
