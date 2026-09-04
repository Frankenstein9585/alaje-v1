/**
 * Money arithmetic in integer kobo.
 *
 * Amounts live in the database as DECIMAL and travel as strings. Any sum done
 * in floating point drifts, and a balance that is off by a kobo is a balance
 * nobody trusts. Every calculation converts to whole kobo, adds integers, and
 * converts back.
 */

/** "42000.00" -> 4200000 */
export function toKobo(amount: string | number): number {
  const value = typeof amount === 'string' ? Number(amount) : amount;
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 100);
}

/** 4200000 -> "42000.00", the shape the DECIMAL column expects. */
export function koboToDecimal(kobo: number): string {
  const sign = kobo < 0 ? '-' : '';
  const abs = Math.abs(Math.round(kobo));
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** Sum DECIMAL strings without ever touching a float. */
export function sumDecimals(amounts: Array<string | number>): string {
  return koboToDecimal(amounts.reduce<number>((total, a) => total + toKobo(a), 0));
}
