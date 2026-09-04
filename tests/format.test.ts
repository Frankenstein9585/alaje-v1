import { describe, expect, it } from 'vitest';
import { formatNaira, formatQuantity, normalizeProductName } from '../src/format.js';

describe('formatNaira', () => {
  it('formats whole naira without kobo', () => {
    // The owner writes "42k". Showing "₦42,000.00" back reads like a bank
    // statement, not a shop.
    expect(formatNaira(42000)).toBe('₦42,000');
    expect(formatNaira('42000.00')).toBe('₦42,000');
  });

  it('keeps kobo when there is a fractional part', () => {
    expect(formatNaira('1250.50')).toBe('₦1,250.50');
  });

  it('groups thousands', () => {
    expect(formatNaira(1234567)).toBe('₦1,234,567');
  });

  it('returns the input unchanged when it is not a number', () => {
    expect(formatNaira('not-a-number')).toBe('not-a-number');
  });
});

describe('formatQuantity', () => {
  it('pluralizes only when needed', () => {
    expect(formatQuantity(1, 'carton')).toBe('1 carton');
    expect(formatQuantity(3, 'carton')).toBe('3 cartons');
  });

  it('falls back to a generic unit', () => {
    expect(formatQuantity(5)).toBe('5 units');
  });

  it('handles awkward plurals', () => {
    expect(formatQuantity(2, 'box')).toBe('2 boxes');
    expect(formatQuantity(2, 'bag')).toBe('2 bags');
  });
});

describe('normalizeProductName', () => {
  it('treats case, spacing and a trailing plural as the same product', () => {
    // Three rows for one product would quietly break every stock count.
    const forms = ['Indomie', 'indomie ', '  INDOMIE', 'Indomies'];
    const normalized = new Set(forms.map(normalizeProductName));
    expect(normalized.size).toBe(1);
  });

  it('collapses internal whitespace', () => {
    expect(normalizeProductName('Peak  Milk')).toBe('peak milk');
  });

  it('does not strip the s from very short names', () => {
    expect(normalizeProductName('Gas')).toBe('gas');
  });
});
