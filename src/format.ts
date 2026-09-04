/**
 * Display formatting for anything the owner reads.
 *
 * Tools return these strings alongside their raw values so the model relays a
 * formatted number rather than composing one. Models mangle thousands
 * separators often enough to matter, and in this product a wrong-looking amount
 * is worse than an ugly one: the confirmation echo is how the owner catches a
 * misparse, so it has to be unambiguous at a glance.
 */

const nairaWhole = new Intl.NumberFormat('en-NG', {
  style: 'currency',
  currency: 'NGN',
  maximumFractionDigits: 0,
});

const nairaKobo = new Intl.NumberFormat('en-NG', {
  style: 'currency',
  currency: 'NGN',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * Format an amount for display. Accepts the DECIMAL strings the driver returns
 * so money never round-trips through a float on its way to the screen.
 *
 * Whole naira drop the kobo: shop owners write "42k", not "42,000.00".
 */
export function formatNaira(amount: string | number): string {
  const value = typeof amount === 'string' ? Number(amount) : amount;
  if (!Number.isFinite(value)) return String(amount);
  return Number.isInteger(value) ? nairaWhole.format(value) : nairaKobo.format(value);
}

/** "3 cartons", "1 carton", "5 units" when no unit is known. */
export function formatQuantity(quantity: number, unit = 'unit'): string {
  const noun = quantity === 1 ? unit : pluralize(unit);
  return `${quantity.toLocaleString('en-NG')} ${noun}`;
}

function pluralize(word: string): string {
  if (/(s|x|z|ch|sh)$/i.test(word)) return `${word}es`;
  if (/[^aeiou]y$/i.test(word)) return `${word.slice(0, -1)}ies`;
  return `${word}s`;
}

/**
 * Normalize a product name for matching: case, spacing and a trailing plural.
 * "Indomie ", "indomie" and "Indomies" are the same product to a shop owner,
 * and creating three rows for them would quietly break every stock count.
 */
export function normalizeProductName(name: string): string {
  const trimmed = name.trim().toLowerCase().replace(/\s+/g, ' ');
  return trimmed.endsWith('s') && trimmed.length > 3 ? trimmed.slice(0, -1) : trimmed;
}
